// findAsDerivative.js - Script to find blocks containing asDerivative
const { ApiPromise, WsProvider } = require('@polkadot/api');

async function findAsDerivativeBlocks() {
  const wsEndpoint = process.env.RPC_WS || 'wss://paseo-rpc.dwellir.com';
  console.log(`🔌 Connecting to ${wsEndpoint}...`);
  
  const provider = new WsProvider(wsEndpoint);
  const api = await ApiPromise.create({ provider });

  const chain = await api.rpc.system.chain();
  console.log(`✅ Connected to: ${chain}\n`);

  // Get current block
  const header = await api.rpc.chain.getHeader();
  const currentBlock = header.number.toNumber();
  console.log(`📦 Current block: ${currentBlock}\n`);

  // Option 1: Quick scan of last N blocks
  console.log('🔍 Option 1: Quick scan of recent blocks...\n');
  
  const blocksToScan = parseInt(process.env.BLOCKS || '10000');
  const startBlock = Math.max(1, currentBlock - blocksToScan);
  
  console.log(`Scanning blocks ${startBlock} - ${currentBlock}...`);
  console.log('(Interrupt with Ctrl+C when you find something)\n');

  let found = 0;
  const foundBlocks = [];
  const batchSize = 100;

  for (let b = startBlock; b <= currentBlock; b += batchSize) {
    const endBatch = Math.min(b + batchSize - 1, currentBlock);
    
    try {
      // Fetch block batch
      const blockNumbers = [];
      for (let i = b; i <= endBatch; i++) {
        blockNumbers.push(i);
      }
      
      const hashes = await Promise.all(
        blockNumbers.map(n => api.rpc.chain.getBlockHash(n))
      );
      
      const blocks = await Promise.all(
        hashes.map(h => api.rpc.chain.getBlock(h))
      );
      
      // Analyze each block
      for (let i = 0; i < blocks.length; i++) {
        const blockNum = blockNumbers[i];
        const extrinsics = blocks[i].block.extrinsics;
        
        let hasAsDerivative = false;
        let utilityCount = 0;
        
        extrinsics.forEach((ex) => {
          if (ex.method.section === 'utility') {
            utilityCount++;
            
            if (ex.method.method === 'asDerivative') {
              hasAsDerivative = true;
              found++;
            }
            
            // Also check in batches
            if (['batch', 'batchAll'].includes(ex.method.method)) {
              const calls = ex.method.args[0];
              if (calls && Array.isArray(calls.toHuman ? calls.toHuman() : calls)) {
                const callsArray = calls.toHuman ? calls.toHuman() : calls;
                callsArray.forEach(call => {
                  if (call && call.section === 'utility' && call.method === 'asDerivative') {
                    hasAsDerivative = true;
                    found++;
                  }
                });
              }
            }
          }
        });
        
        if (hasAsDerivative) {
          foundBlocks.push(blockNum);
          console.log(`✅ FOUND asDerivative in block ${blockNum}!`);
        } else if (utilityCount > 0 && blockNum % 1000 === 0) {
          console.log(`   Block ${blockNum}: ${utilityCount} utility calls (no asDerivative)`);
        }
      }
      
      // Progress
      if (endBatch % 1000 === 0) {
        console.log(`   Scanned up to block ${endBatch}... (found ${found} asDerivative)`);
      }
      
    } catch (error) {
      console.error(`Error batch ${b}-${endBatch}:`, error.message);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`📊 SCAN RESULTS:`);
  console.log('='.repeat(60));
  console.log(`Blocks scanned: ${currentBlock - startBlock + 1}`);
  console.log(`asDerivative found: ${found}`);
  
  if (foundBlocks.length > 0) {
    console.log(`\n✅ Blocks with asDerivative:`);
    foundBlocks.slice(0, 20).forEach(b => console.log(`   - ${b}`));
    if (foundBlocks.length > 20) {
      console.log(`   ... and ${foundBlocks.length - 20} more blocks`);
    }
    
    console.log(`\n💡 Use these blocks for testing:`);
    console.log(`START_BLOCK=${foundBlocks[0]} END_BLOCK=${foundBlocks[0]} node checkExtrinsic.js`);
  } else {
    console.log('\n❌ No asDerivative found!');
    console.log('\nOption 2: Search a wider range:');
    console.log(`BLOCKS=50000 node findAsDerivative.js`);
    
    console.log('\nOption 3: Try creating an asDerivative:');
    console.log('Use Polkadot.js Apps to create a utility.asDerivative transaction');
  }

  // Option 2: Show example of how to create asDerivative
  console.log('\n📝 EXAMPLE: How to create an asDerivative:\n');
  console.log('1. Go to Polkadot.js Apps for Paseo');
  console.log('2. Developer -> Extrinsics');
  console.log('3. Select: utility -> asDerivative');
  console.log('4. Parameters:');
  console.log('   - index: 0 (or any number 0-255)');
  console.log('   - call: system.remark (or any other call)');
  console.log('5. Submit Transaction\n');

  await api.disconnect();
  console.log('✅ Disconnected.');
}

// Alternative script to verify if an account has derivatives
async function checkAccountDerivatives() {
  const wsEndpoint = process.env.RPC_WS || 'wss://paseo-rpc.dwellir.com';
  const account = process.env.ACCOUNT;
  
  if (!account) {
    console.log('❌ Specify an account: ACCOUNT=5GrwvaEF... node findAsDerivative.js --check');
    return;
  }
  
  const provider = new WsProvider(wsEndpoint);
  const api = await ApiPromise.create({ provider });

  console.log(`\n🔍 Checking derivatives for: ${account}\n`);

  // Check first 10 indices
  for (let i = 0; i < 10; i++) {
    // Derive the account
    const { u8aConcat, stringToU8a } = require('@polkadot/util');
    const { blake2AsU8a } = require('@polkadot/util-crypto');
    
    const prefix = stringToU8a('modlpy/utilisuba');
    const accountBytes = api.registry.createType('AccountId32', account).toU8a();
    const indexByte = new Uint8Array([i & 0xff]);
    const raw = u8aConcat(prefix, accountBytes, indexByte);
    const hash = blake2AsU8a(raw, 256);
    const derived = api.registry.createType('AccountId32', hash);
    
    // Check if it has a balance
    const info = await api.query.system.account(derived);
    
    if (info.data.free.gtn(0) || info.nonce.gtn(0)) {
      console.log(`✅ Index ${i}: ${derived.toString()}`);
      console.log(`   Balance: ${info.data.free.toString()}`);
      console.log(`   Nonce: ${info.nonce.toString()}`);
    }
  }
  
  await api.disconnect();
}

// Entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--check')) {
    checkAccountDerivatives().catch(console.error);
  } else {
    findAsDerivativeBlocks().catch(console.error);
  }
}