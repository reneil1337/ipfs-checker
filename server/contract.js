import { ethers } from 'ethers';
import { fetchMetadata, extractHashesFromMetadata, checkIpfsHash, extractHashFromUri } from './ipfs.js';
import { saveTokenAnalysis } from './db.js';

// Primary RPC from env, with fallback list
const PRIMARY_RPC = process.env.ETHEREUM_RPC_URL;
const FALLBACK_RPCS = [
  'https://ethereum-rpc.publicnode.com',
  'https://eth.llamarpc.com',
  'https://1rpc.io/eth',
  'https://eth.drpc.org',
  'https://eth-pokt.nodies.app',
  'https://rpc.ankr.com/eth',
  'https://eth.meowrpc.com',
  'https://ethereum.publicnode.com'
];

const ERC721_ABI = [
  'function totalSupply() view returns (uint256)',
  'function tokenByIndex(uint256 index) view returns (uint256)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function symbol() view returns (string)',
  'function name() view returns (string)'
];

// Build the RPC list: primary first (if set), then fallbacks
function getRpcList() {
  if (PRIMARY_RPC) {
    return [PRIMARY_RPC, ...FALLBACK_RPCS.filter(r => r !== PRIMARY_RPC)];
  }
  return FALLBACK_RPCS;
}

// Create a provider with explicit chainId to avoid network detection delays
function createProvider(rpcUrl) {
  return new ethers.JsonRpcProvider(rpcUrl, 1, { staticNetwork: true });
}

// RPC Manager: cycles through RPCs on failure
class RpcManager {
  constructor() {
    this.rpcs = getRpcList();
    this.currentIndex = 0;
    this.failCounts = new Map();
  }

  get rpc() {
    return this.rpcs[this.currentIndex];
  }

  getProvider() {
    return createProvider(this.rpc);
  }

  getContract(address) {
    return new ethers.Contract(address, ERC721_ABI, this.getProvider());
  }

  rotate() {
    const previous = this.rpc;
    this.currentIndex = (this.currentIndex + 1) % this.rpcs.length;
    console.log(`RPC rotated: ${previous} -> ${this.rpc}`);
    return this.rpc;
  }

  recordFailure() {
    const count = (this.failCounts.get(this.rpc) || 0) + 1;
    this.failCounts.set(this.rpc, count);
    this.rotate();
  }
}

// Check if an error is a contract revert (token doesn't exist) vs an RPC issue
function isTokenNotFound(error) {
  const msg = error.message || '';
  return msg.includes('invalid token ID') ||
         msg.includes('nonexistent token') ||
         msg.includes('URI query for nonexistent') ||
         msg.includes('owner query for nonexistent') ||
         (msg.includes('execution reverted') && !msg.includes('rate') && !msg.includes('limit'));
}

// Execute a call, retrying across multiple RPCs
async function rpcCall(rpcManager, contractAddress, callFn, maxAttempts = 6) {
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const contract = rpcManager.getContract(contractAddress);
    try {
      return await callFn(contract);
    } catch (error) {
      lastError = error;
      const msg = error.message || '';

      // If it's a legitimate contract revert, don't retry on other RPCs
      if (isTokenNotFound(error)) {
        throw error;
      }

      console.log(`RPC call failed (${rpcManager.rpc}): ${msg.substring(0, 80)}`);
      rpcManager.recordFailure();

      await new Promise(r => setTimeout(r, 300));
    }
  }
  throw lastError;
}

// Discover the highest tokenId via binary search
async function discoverHighestTokenId(rpcManager, contractAddress, sendProgress) {
  sendProgress({ type: 'info', message: 'totalSupply() not available, discovering token range...' });

  // First check if tokens start at 0 or 1
  let startsAtZero = false;
  try {
    await rpcCall(rpcManager, contractAddress, c => c.tokenURI(0), 3);
    startsAtZero = true;
  } catch { /* starts at 1 or 0 doesn't exist */ }

  // Binary search for the highest tokenId that exists
  // Note: there may be gaps, so we look for the highest ID where ownerOf doesn't revert
  let low = startsAtZero ? 0 : 1;
  let high = 20000;
  let lastValid = low;

  // First find a rough upper bound
  let probe = 100;
  while (probe <= high) {
    try {
      await rpcCall(rpcManager, contractAddress, c => c.ownerOf(probe), 3);
      lastValid = probe;
      probe *= 2;
    } catch {
      high = probe;
      break;
    }
    await new Promise(r => setTimeout(r, 100));
  }

  // Binary search between lastValid and high
  low = lastValid;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    try {
      await rpcCall(rpcManager, contractAddress, c => c.ownerOf(mid), 3);
      lastValid = mid;
      low = mid + 1;
    } catch {
      high = mid - 1;
    }
    await new Promise(r => setTimeout(r, 100));
  }

  const startId = startsAtZero ? 0 : 1;
  sendProgress({ type: 'info', message: `Token IDs range from ${startId} to ${lastValid} (scanning for existing tokens)` });
  return { startId, endId: lastValid };
}

export async function analyzeContract(contractAddress, sendProgress, options = {}) {
  const manager = new RpcManager();
  const maxTokens = options.maxTokens || 10000;
  const delayBetweenRequests = options.delay || 300;
  const maxConsecutiveRpcErrors = 10; // Only counts real RPC failures, not missing tokens
  const results = [];

  try {
    // Get contract name / symbol
    let name, symbol;
    try {
      name = await rpcCall(manager, contractAddress, c => c.name());
    } catch { /* ignore */ }
    try {
      symbol = await rpcCall(manager, contractAddress, c => c.symbol());
    } catch { /* ignore */ }

    sendProgress({
      type: 'info',
      message: `Analyzing contract: ${name || 'Unknown'} (${symbol || 'Unknown'}) via ${manager.rpc}`
    });

    // Determine token range
    let startId = 1;
    let endId;

    try {
      const totalSupply = Number(await rpcCall(manager, contractAddress, c => c.totalSupply()));
      endId = totalSupply;
      // Check if tokenByIndex is available (ERC721Enumerable)
      try {
        await rpcCall(manager, contractAddress, c => c.tokenByIndex(0), 3);
        // Has enumerable - we can get exact token IDs
        sendProgress({ type: 'info', message: `Contract has ${totalSupply} tokens (enumerable)` });
      } catch {
        // No enumerable, just iterate 1..totalSupply
      }
    } catch {
      // totalSupply() not supported - discover via probing
      const range = await discoverHighestTokenId(manager, contractAddress, sendProgress);
      startId = range.startId;
      endId = range.endId;
    }

    const scanCount = Math.min(endId - startId + 1, maxTokens);
    let existingTokens = 0;
    let skippedTokens = 0;

    sendProgress({
      type: 'start',
      total: scanCount,
      contract: { address: contractAddress, name, symbol }
    });

    let consecutiveRpcErrors = 0;

    for (let tokenId = startId; tokenId <= endId && results.length < maxTokens; tokenId++) {
      try {
        const tokenURI = await rpcCall(manager, contractAddress, c => c.tokenURI(tokenId));
        consecutiveRpcErrors = 0;
        existingTokens++;

        const metadataHash = extractHashFromUri(tokenURI);
        const metadataStatus = await checkIpfsHash(metadataHash);

        let metadata = null;
        let imageStatus = null;
        let animationStatus = null;
        let imageHash = null;
        let animationHash = null;

        if (metadataStatus && metadataStatus.status === 'online') {
          metadata = await fetchMetadata(tokenURI);
          const hashes = extractHashesFromMetadata(metadata);

          imageHash = hashes.image;
          animationHash = hashes.animation;

          if (imageHash) imageStatus = await checkIpfsHash(imageHash);
          if (animationHash) animationStatus = await checkIpfsHash(animationHash);
        }

        const tokenData = {
          tokenId,
          tokenURI,
          metadataHash,
          metadataStatus: metadataStatus?.status || 'unknown',
          imageHash,
          imageStatus: imageStatus?.status || (imageHash ? 'unknown' : 'none'),
          animationHash,
          animationStatus: animationStatus?.status || (animationHash ? 'unknown' : 'none'),
          metadata
        };

        saveTokenAnalysis.run(contractAddress, tokenId, tokenURI, metadataHash, imageHash, animationHash);
        results.push(tokenData);

        sendProgress({
          type: 'token',
          token: tokenData,
          progress: {
            current: tokenId - startId + 1,
            total: scanCount,
            percentage: Math.round(((tokenId - startId + 1) / scanCount) * 100)
          }
        });

      } catch (error) {
        if (isTokenNotFound(error)) {
          // Token ID doesn't exist (burned or never minted) - just skip it
          skippedTokens++;
          sendProgress({
            type: 'skip',
            tokenId,
            progress: {
              current: tokenId - startId + 1,
              total: scanCount,
              percentage: Math.round(((tokenId - startId + 1) / scanCount) * 100)
            }
          });
        } else {
          // Real RPC error
          consecutiveRpcErrors++;
          console.error(`RPC error token ${tokenId}:`, error.message?.substring(0, 80));

          if (consecutiveRpcErrors >= maxConsecutiveRpcErrors) {
            sendProgress({
              type: 'info',
              message: `Stopped after ${maxConsecutiveRpcErrors} consecutive RPC errors. Found ${existingTokens} tokens, skipped ${skippedTokens} non-existent IDs.`
            });
            break;
          }
        }
      }

      if (delayBetweenRequests > 0) {
        await new Promise(r => setTimeout(r, delayBetweenRequests));
      }
    }

    sendProgress({
      type: 'info',
      message: `Scan complete. Found ${existingTokens} existing tokens, skipped ${skippedTokens} non-existent IDs.`
    });

    sendProgress({ type: 'complete', results });
    return results;

  } catch (error) {
    console.error('Contract analysis failed:', error);
    sendProgress({ type: 'error', error: error.message });
    throw error;
  }
}
