// checkExtrinsic.js - Versione corretta
const { ApiPromise, WsProvider } = require('@polkadot/api');
const { u8aConcat, stringToU8a } = require('@polkadot/util');
const { blake2AsU8a } = require('@polkadot/util-crypto');
const fs = require('fs');
const path = require('path');

// ——————————————————————————————————
//  CONFIGURAZIONE
// ——————————————————————————————————
const DERIVATION_PREFIX = stringToU8a('modlpy/utilisuba');
const BATCH_SIZE        = parseInt(process.env.BATCH_SIZE || '20', 10);
const RPC_RETRY_LIMIT   = 3;
const RPC_RETRY_DELAY   = 500; // ms

// ——————————————————————————————————
//  HELPERS
// ——————————————————————————————————
function deriveAccountCorrect(api, signer, derivativeIndex) {
  const accountBytes = api.registry
    .createType('AccountId32', signer)
    .toU8a();
  const indexByte = new Uint8Array([derivativeIndex & 0xff]);
  const raw      = u8aConcat(DERIVATION_PREFIX, accountBytes, indexByte);
  const hash     = blake2AsU8a(raw, 256);
  return api.registry.createType('AccountId32', hash);
}

async function retry(fn, args = [], limit = RPC_RETRY_LIMIT) {
  let err;
  for (let i = 0; i < limit; i++) {
    try {
      return await fn(...args);
    } catch (e) {
      err = e;
      console.log(`⚠️  Retry ${i + 1}/${limit} dopo errore: ${e.message}`);
      await new Promise(r => setTimeout(r, RPC_RETRY_DELAY * (i + 1)));
    }
  }
  throw err;
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// Contatori per debug
let debugCounters = {
  totalExtrinsics: 0,
  utilityExtrinsics: 0,
  utilityMethods: {}
};

function checkAsDerivative(callMethod, callArgs, api, blockNumber, extrinsicIndex, signer, writeDetail, counters, depth = 0) {
  // Debug: conta i metodi utility trovati
  if (depth === 0 && callMethod.section === 'utility') {
    const methodName = callMethod.method.toString();
    debugCounters.utilityMethods[methodName] = (debugCounters.utilityMethods[methodName] || 0) + 1;
  }
  
  // IMPORTANTE: usa 'asDerivative' (camelCase) non 'as_derivative'!
  if (callMethod.section === 'utility' && callMethod.method === 'asDerivative') {
    const derivativeIndex = callArgs[0].toNumber();
    const innerCall      = callArgs[1];
    const derivedAccount = deriveAccountCorrect(api, signer, derivativeIndex).toString();

    counters.unique.add(derivedAccount);
    counters.total++;

    console.log(`   ✅ TROVATO asDerivative #${counters.total}!`);
    console.log(`      Blocco: ${blockNumber}, Extrinsic: ${extrinsicIndex}`);
    console.log(`      Index: ${derivativeIndex}, Signer: ${signer.substring(0, 10)}...`);
    console.log(`      Derived: ${derivedAccount.substring(0, 10)}...`);

    writeDetail({
      block: blockNumber,
      extrinsicIndex,
      signer,
      derivativeIndex,
      derivedAccount,
      innerCall: `${innerCall.method.section}.${innerCall.method.method}`,
      innerCallArgs: innerCall.args.map(a => a.toHuman())
    });
    return;
  }

  // Controlla batch calls (solo metodi comuni, forceBatch potrebbe non esistere)
  if (
    callMethod.section === 'utility' &&
    ['batch', 'batchAll'].includes(callMethod.method)
  ) {
    const callsVec = callArgs[0];
    const callsArr = typeof callsVec.toArray === 'function'
      ? callsVec.toArray()
      : Array.isArray(callsVec)
        ? callsVec
        : [];
    
    if (depth === 0 && callsArr.length > 0) {
      console.log(`   📦 Controllo batch (${callMethod.method}) con ${callsArr.length} chiamate...`);
    }
    
    callsArr.forEach((nested, idx) => {
      if (nested && nested.method) {
        checkAsDerivative(
          nested.method,
          nested.args,
          api,
          blockNumber,
          extrinsicIndex,
          signer,
          writeDetail,
          counters,
          depth + 1
        );
      }
    });
  }
}

// ——————————————————————————————————
//  TEST UTILITY PALLET - VERSIONE CORRETTA
// ——————————————————————————————————
async function testUtilityPallet(api) {
  console.log('\n🧪 Verifica metodi disponibili nel pallet Utility...\n');
  
  try {
    // Metodo 1: Usa l'API runtime se disponibile
    if (api.tx.utility) {
      console.log('Metodi disponibili in utility (via api.tx):');
      const methods = Object.keys(api.tx.utility);
      methods.forEach(method => {
        console.log(`   - ${method}`);
      });
      
      if (!methods.includes('asDerivative')) {
        console.log('\n⚠️  ATTENZIONE: asDerivative non trovato nei metodi!');
        console.log('   Metodi trovati:', methods.join(', '));
      } else {
        console.log('\n✅ asDerivative è disponibile!');
      }
      
      return methods;
    }
    
    // Metodo 2: Fallback ai metadata raw
    console.log('Accesso diretto ai metadata...');
    const metadata = await api.rpc.state.getMetadata();
    const modules = metadata.asLatest.pallets || metadata.asLatest.modules;
    
    const utilityPallet = modules.find(m => {
      const name = m.name ? m.name.toString() : '';
      return name === 'Utility';
    });
    
    if (utilityPallet) {
      console.log('✅ Pallet Utility trovato nei metadata');
      
      // Prova ad accedere ai calls in vari modi
      let callsData = null;
      if (utilityPallet.calls && utilityPallet.calls.isSome) {
        callsData = utilityPallet.calls.unwrap();
      } else if (utilityPallet.calls) {
        callsData = utilityPallet.calls;
      }
      
      if (callsData && callsData.length > 0) {
        console.log(`Trovati ${callsData.length} metodi`);
        // Non possiamo facilmente decodificare i nomi dai metadata raw
        // quindi usiamo api.tx come fonte primaria
      }
    }
    
    return [];
    
  } catch (error) {
    console.error('Errore nel test del pallet Utility:', error.message);
    return [];
  }
}

// ——————————————————————————————————
//  FUNZIONE DI DEBUG PER ESAMINARE UN BLOCCO
// ——————————————————————————————————
async function debugBlock(api, blockNumber) {
  console.log(`\n🔍 DEBUG: Esaminando blocco ${blockNumber}...\n`);
  
  try {
    const blockHash = await api.rpc.chain.getBlockHash(blockNumber);
    const signedBlock = await api.rpc.chain.getBlock(blockHash);
    
    console.log(`Blocco ${blockNumber}: ${signedBlock.block.extrinsics.length} extrinsics totali`);
    
    signedBlock.block.extrinsics.forEach((ex, idx) => {
      const { method, signer } = ex;
      console.log(`\nExtrinsic ${idx}:`);
      console.log(`  Section: ${method.section}`);
      console.log(`  Method: ${method.method}`);
      console.log(`  Signer: ${signer ? signer.toString().substring(0, 20) + '...' : 'None'}`);
      
      if (method.section === 'utility') {
        console.log(`  ⭐ UTILITY CALL TROVATA!`);
        console.log(`  Args length: ${method.args.length}`);
        
        // Se è un batch, mostra le chiamate interne
        if (['batch', 'batchAll'].includes(method.method) && method.args[0]) {
          const calls = method.args[0];
          const callsArray = Array.isArray(calls) ? calls : 
                           (calls.toArray ? calls.toArray() : []);
          console.log(`  Batch contiene ${callsArray.length} chiamate:`);
          callsArray.forEach((call, i) => {
            if (call && call.method) {
              console.log(`    ${i}: ${call.method.section}.${call.method.method}`);
            }
          });
        }
      }
    });
    
  } catch (error) {
    console.error(`Errore nel debug del blocco ${blockNumber}:`, error.message);
  }
}

// ——————————————————————————————————
//  MAIN
// ——————————————————————————————————
async function main() {
  const wsEndpoint = process.env.RPC_WS || 'wss://asset-hub-paseo-rpc.n.dwellir.com';
  console.log(`🔌 Connessione a ${wsEndpoint}...`);
  
  const provider = new WsProvider(wsEndpoint);
  const api = await ApiPromise.create({ provider });

  // Info chain
  const chain = await api.rpc.system.chain();
  console.log(`✅ Connesso a: ${chain}`);

  // Prima verifica i metodi disponibili
  const availableMethods = await testUtilityPallet(api);

  // Header e blocchi
  const head = await retry(api.rpc.chain.getHeader.bind(api.rpc.chain), []);
  const latestNum = head.number.toNumber();
  
  const startBlock = parseInt(process.env.START_BLOCK || (latestNum - 1000), 10);
  const endBlock = parseInt(process.env.END_BLOCK || latestNum, 10);

  console.log(`\n🔢 Range blocchi: ${startBlock} → ${endBlock} (${endBlock - startBlock + 1} blocchi)`);
  console.log(`📦 Batch size: ${BATCH_SIZE}\n`);

  // Se il range è piccolo, fai debug dettagliato
  if (endBlock - startBlock < 10) {
    console.log('Range piccolo rilevato, abilito debug dettagliato...');
    for (let b = startBlock; b <= endBlock; b++) {
      await debugBlock(api, b);
    }
  }

  const outDir = process.env.OUT_DIR || '.';
  const detailsPath = path.join(outDir, 'derived_details-ah.json');
  const summaryPath = path.join(outDir, 'derived_summary.json');
  const ws = fs.createWriteStream(detailsPath);
  ws.write('[');
  let firstDetail = true;

  const counters = { total: 0, unique: new Set() };
  const allBlocks = Array.from({ length: endBlock - startBlock + 1 }, (_, i) => startBlock + i);
  const batches = chunkArray(allBlocks, BATCH_SIZE);

  const startTime = Date.now();

  console.log('\n🚀 Inizio scansione...\n');

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    
    try {
      // Fetch paralleli
      const hashes = await retry(
        blocks => Promise.all(blocks.map(n => api.rpc.chain.getBlockHash(n))),
        [batch]
      );
      const blocks = await retry(
        hs => Promise.all(hs.map(h => api.rpc.chain.getBlock(h))),
        [hashes]
      );

      // Processa blocchi
      for (let i = 0; i < blocks.length; i++) {
        const blockNumber = batch[i];
        const extrinsics = blocks[i].block.extrinsics;

        extrinsics.forEach((ex, idx) => {
          debugCounters.totalExtrinsics++;
          
          if (!ex.signer) return;
          
          if (ex.method.section === 'utility') {
            debugCounters.utilityExtrinsics++;
          } else {
            return;
          }

          const writeDetail = detail => {
            const json = JSON.stringify(detail);
            ws.write((firstDetail ? '' : ',') + '\n' + json);
            firstDetail = false;
          };

          checkAsDerivative(
            ex.method,
            ex.method.args || ex.args || [],
            api,
            blockNumber,
            idx,
            ex.signer.toString(),
            writeDetail,
            counters
          );
        });
      }

      // Progress
      const progress = ((batchIdx + 1) / batches.length * 100).toFixed(1);
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = (batch[batch.length - 1] - startBlock + 1) / elapsed;
      
      console.log(`✅ Batch ${batchIdx + 1}/${batches.length} (${progress}%) - ${rate.toFixed(1)} blocchi/s`);
      
    } catch (error) {
      console.error(`❌ Errore batch ${batch[0]}-${batch[batch.length - 1]}:`, error.message);
    }
  }

  ws.write('\n]');
  ws.end();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

  const summary = {
    chain: chain.toString(),
    scannedBlocks: endBlock - startBlock + 1,
    startBlock,
    endBlock,
    totalDerivatives: counters.total,
    uniqueAccounts: counters.unique.size,
    totalExtrinsics: debugCounters.totalExtrinsics,
    utilityExtrinsics: debugCounters.utilityExtrinsics,
    utilityMethodsFound: debugCounters.utilityMethods,
    processingTime: `${elapsed}s`,
    blocksPerSecond: ((endBlock - startBlock + 1) / elapsed).toFixed(2),
    timestamp: new Date().toISOString()
  };
  
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  console.log('\n' + '='.repeat(60));
  console.log('📊 SCAN COMPLETATO');
  console.log('='.repeat(60));
  console.log(`⏱️  Tempo: ${elapsed}s (${summary.blocksPerSecond} blocchi/s)`);
  console.log(`📦 Extrinsics totali: ${debugCounters.totalExtrinsics}`);
  console.log(`🔧 Utility extrinsics: ${debugCounters.utilityExtrinsics}`);
  console.log(`🎯 asDerivative trovati: ${counters.total}`);
  console.log(`🔑 Account derivati unici: ${counters.unique.size}`);
  
  if (Object.keys(debugCounters.utilityMethods).length > 0) {
    console.log(`\n📊 Metodi utility trovati:`);
    Object.entries(debugCounters.utilityMethods).forEach(([method, count]) => {
      console.log(`   - ${method}: ${count}`);
    });
  }

  console.log(`\n💾 Files salvati:`);
  console.log(`   - Dettagli: ${detailsPath}`);
  console.log(`   - Sommario: ${summaryPath}`);

  if (counters.total === 0) {
    console.log('\n⚠️  ATTENZIONE: Nessun asDerivative trovato!');
    console.log('   Possibili cause:');
    console.log('   1. Non ci sono chiamate asDerivative nel range specificato');
    console.log('   2. Il metodo potrebbe avere un nome diverso su Paseo');
    console.log('   3. Prova un range più ampio o verifica su un explorer');
  }

  await api.disconnect();
  console.log('\n✅ Disconnesso.');
}

// ——————————————————————————————————
//  ENTRY POINT
// ——————————————————————————————————
if (require.main === module) {
  main().catch(console.error);
}