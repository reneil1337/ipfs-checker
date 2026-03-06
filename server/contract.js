import { ethers } from 'ethers';
import { fetchMetadata, extractHashesFromMetadata, checkIpfsHash, extractHashFromUri } from './ipfs.js';
import {
  saveTokenAnalysis, saveContractAnalysis, updateContractProgress, updateContractUri,
  getContractAnalysis, getContractTokens, getTokenAnalysis, saveSkippedToken, isTokenSkipped,
  SKIP_TTL_MS, countExpiredSkips
} from './db.js';

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
  'function contractURI() view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function symbol() view returns (string)',
  'function name() view returns (string)'
];

function getRpcList() {
  if (PRIMARY_RPC) {
    return [PRIMARY_RPC, ...FALLBACK_RPCS.filter(r => r !== PRIMARY_RPC)];
  }
  return FALLBACK_RPCS;
}

function createProvider(rpcUrl) {
  return new ethers.JsonRpcProvider(rpcUrl, 1, { staticNetwork: true });
}

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

function isTokenNotFound(error) {
  const msg = (error.message || '').toLowerCase();
  return msg.includes('invalid token id') ||
         msg.includes('nonexistent token') ||
         msg.includes('uri query for nonexistent') ||
         msg.includes('owner query for nonexistent') ||
         msg.includes('token does not exist') ||
         msg.includes('query for nonexistent') ||
         msg.includes('erc721nonexistenttoken') ||
         msg.includes('erc721: invalid') ||
         msg.includes('token id does not exist') ||
         msg.includes('not been minted');
}

async function rpcCall(rpcManager, contractAddress, callFn, maxAttempts = 6) {
  let lastError;
  let tokenNotFoundCount = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const contract = rpcManager.getContract(contractAddress);
    try {
      return await callFn(contract);
    } catch (error) {
      lastError = error;
      const msg = error.message || '';

      if (isTokenNotFound(error)) {
        tokenNotFoundCount++;
        // Confirm with a second RPC before treating as truly not found
        if (tokenNotFoundCount >= 2) {
          throw error;
        }
        rpcManager.rotate();
        await new Promise(r => setTimeout(r, 200));
        continue;
      }

      console.log(`RPC call failed (${rpcManager.rpc}): ${msg.substring(0, 80)}`);
      rpcManager.recordFailure();
      await new Promise(r => setTimeout(r, 300));
    }
  }
  throw lastError;
}

async function discoverHighestTokenId(rpcManager, contractAddress, sendProgress) {
  sendProgress({ type: 'info', message: 'totalSupply() not available, discovering token range...' });

  const GAP_LOOKAHEAD = 20; // probe this many IDs past the last known valid to find tokens beyond gaps

  let startsAtZero = false;
  try {
    await rpcCall(rpcManager, contractAddress, c => c.tokenURI(0), 3);
    startsAtZero = true;
  } catch { /* starts at 1 or 0 doesn't exist */ }

  let low = startsAtZero ? 0 : 1;
  let high = 20000;
  let lastValid = low;

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

  // Lookahead past gaps: probe the next GAP_LOOKAHEAD IDs beyond lastValid.
  // If any exist, update lastValid and repeat from the new position.
  // Stop when GAP_LOOKAHEAD consecutive IDs are all nonexistent.
  let foundMore = true;
  while (foundMore) {
    foundMore = false;
    for (let id = lastValid + 1; id <= lastValid + GAP_LOOKAHEAD; id++) {
      try {
        await rpcCall(rpcManager, contractAddress, c => c.ownerOf(id), 3);
        lastValid = id;
        foundMore = true;
      } catch { /* doesn't exist */ }
      await new Promise(r => setTimeout(r, 100));
    }
  }

  const startId = startsAtZero ? 0 : 1;
  sendProgress({ type: 'info', message: `Token IDs range from ${startId} to ${lastValid}` });
  return { startId, endId: lastValid };
}

/**
 * Fetch and check the contractURI for a given address.
 * Returns { contractURI, contractURIHash, contractURIStatus } or null.
 */
export async function fetchContractURI(contractAddress) {
  const manager = new RpcManager();
  try {
    const uri = await rpcCall(manager, contractAddress, c => c.contractURI(), 3);
    if (!uri) return null;
    const hash = extractHashFromUri(uri);
    if (!hash) return { contractURI: uri, contractURIHash: null, contractURIStatus: 'non-ipfs' };
    const check = await checkIpfsHash(hash);
    return {
      contractURI: uri,
      contractURIHash: hash,
      contractURIStatus: check?.status || 'unknown'
    };
  } catch {
    return null; // contractURI() not supported
  }
}

export async function analyzeContract(contractAddress, sendProgress, options = {}) {
  const manager = new RpcManager();
  const maxTokens = options.maxTokens || 10000;
  const delayBetweenRequests = options.delay || 300;
  const maxConsecutiveRpcErrors = 10;
  const results = [];

  // Normalize address to lowercase for consistent DB keys
  contractAddress = contractAddress.toLowerCase();

  try {
    // Check for existing analysis to resume
    const existing = getContractAnalysis.get(contractAddress);
    let name, symbol, startId, endId, resumeFromId;
    let existingTokens = 0;
    let skippedTokens = 0;

    let contractURI = null;
    let contractURIHash = null;
    let contractURIStatus = null;

    if (existing && existing.end_id > 0) {
      // Resume from where we left off
      name = existing.name;
      symbol = existing.symbol;
      startId = existing.start_id;
      endId = existing.end_id;
      resumeFromId = existing.last_scanned_id + 1;
      existingTokens = existing.tokens_found;
      skippedTokens = existing.tokens_skipped;
      contractURI = existing.contract_uri || null;
      contractURIHash = existing.contract_uri_hash || null;
      contractURIStatus = existing.contract_uri_status || null;

      sendProgress({
        type: 'info',
        message: `Resuming analysis of ${name || 'Unknown'} (${symbol || 'Unknown'}) from token #${resumeFromId}`
      });

      // Send existing tokens first so UI shows previous results immediately
      const savedTokens = getContractTokens.all(contractAddress);
      for (const t of savedTokens) {
        const tokenData = {
          tokenId: t.token_id,
          tokenURI: t.token_uri,
          metadataHash: t.metadata_hash,
          metadataStatus: t.metadata_status || 'unknown',
          imageHash: t.image_hash,
          imageStatus: t.image_status || 'none',
          animationHash: t.animation_hash,
          animationStatus: t.animation_status || 'none',
        };
        results.push(tokenData);
      }

      // If already complete, check if any skipped tokens have expired TTL and need re-probing
      if (existing.status === 'complete') {
        const expired = countExpiredSkips.get(contractAddress, Date.now() - SKIP_TTL_MS);
        const hasExpiredSkips = expired && expired.count > 0;

        if (!hasExpiredSkips) {
          // Truly complete, no expired skips — return cached results
          sendProgress({
            type: 'start',
            total: endId - startId + 1,
            contract: { address: contractAddress, name, symbol, contractURI, contractURIHash, contractURIStatus }
          });

          for (const tokenData of results) {
            sendProgress({
              type: 'token',
              token: tokenData,
              progress: {
                current: endId - startId + 1,
                total: endId - startId + 1,
                percentage: 100
              }
            });
          }

          sendProgress({
            type: 'info',
            message: `Analysis already complete. ${existingTokens} tokens found, ${skippedTokens} empty IDs skipped.`
          });
          sendProgress({ type: 'complete', results });
          return results;
        }

        // Has expired skips — re-scan from the beginning to re-probe them
        sendProgress({
          type: 'info',
          message: `${expired.count} previously skipped token(s) will be re-probed...`
        });
        resumeFromId = startId;
      }

      // Send previously found tokens to the UI
      if (results.length > 0) {
        sendProgress({
          type: 'start',
          total: endId - startId + 1,
          contract: { address: contractAddress, name, symbol, contractURI, contractURIHash, contractURIStatus }
        });
        for (const tokenData of results) {
          sendProgress({
            type: 'token',
            token: tokenData,
            progress: {
              current: resumeFromId - startId,
              total: endId - startId + 1,
              percentage: Math.round(((resumeFromId - startId) / (endId - startId + 1)) * 100)
            }
          });
        }
        sendProgress({
          type: 'info',
          message: `Loaded ${results.length} cached tokens, continuing scan from #${resumeFromId}...`
        });
      }
    } else {
      // Fresh analysis
      try {
        name = await rpcCall(manager, contractAddress, c => c.name());
      } catch { /* ignore */ }
      try {
        symbol = await rpcCall(manager, contractAddress, c => c.symbol());
      } catch { /* ignore */ }

      // Fetch contractURI (collection-level metadata)
      try {
        contractURI = await rpcCall(manager, contractAddress, c => c.contractURI(), 3);
        if (contractURI) {
          contractURIHash = extractHashFromUri(contractURI);
          if (contractURIHash) {
            sendProgress({ type: 'info', message: `Checking contractURI: ${contractURI}` });
            const uriCheck = await checkIpfsHash(contractURIHash);
            contractURIStatus = uriCheck?.status || 'unknown';
          } else {
            contractURIStatus = 'non-ipfs';
          }
        }
      } catch { /* contractURI() not supported */ }

      sendProgress({
        type: 'info',
        message: `Analyzing contract: ${name || 'Unknown'} (${symbol || 'Unknown'}) via ${manager.rpc}`
      });

      try {
        const totalSupply = Number(await rpcCall(manager, contractAddress, c => c.totalSupply()));
        startId = 1;
        endId = totalSupply;
        try {
          await rpcCall(manager, contractAddress, c => c.tokenByIndex(0), 3);
          sendProgress({ type: 'info', message: `Contract has ${totalSupply} tokens (enumerable)` });
        } catch { /* not enumerable */ }
      } catch {
        const range = await discoverHighestTokenId(manager, contractAddress, sendProgress);
        startId = range.startId;
        endId = range.endId;
      }

      resumeFromId = startId;

      // Save initial contract state
      saveContractAnalysis.run(
        contractAddress, name || null, symbol || null,
        startId, endId, startId - 1, 0, 0, 'in_progress', Date.now(),
        contractURI || null, contractURIHash || null, contractURIStatus || null
      );
    }

    const scanCount = endId - startId + 1;

    if (!results.length) {
      sendProgress({
        type: 'start',
        total: scanCount,
        contract: { address: contractAddress, name, symbol, contractURI, contractURIHash, contractURIStatus }
      });
    }

    let consecutiveRpcErrors = 0;

    for (let tokenId = resumeFromId; tokenId <= endId && existingTokens < maxTokens; tokenId++) {
      // Skip tokens that were already successfully analyzed (avoids redundant RPC calls on re-probe runs)
      if (getTokenAnalysis.get(contractAddress, tokenId)) {
        existingTokens++;
        continue;
      }

      // Skip tokens we already know don't exist (re-probe after TTL expires)
      if (isTokenSkipped.get(contractAddress, tokenId, Date.now() - SKIP_TTL_MS)) {
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
        // Update progress in DB periodically (every 10 skips)
        if (skippedTokens % 10 === 0) {
          updateContractProgress.run(tokenId, existingTokens, skippedTokens, 'in_progress', Date.now(), contractAddress);
        }
        continue;
      }

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

        // Save token to DB immediately
        saveTokenAnalysis.run(
          contractAddress, tokenId, tokenURI,
          metadataHash, metadataStatus?.status || 'unknown',
          imageHash, imageStatus?.status || (imageHash ? 'unknown' : 'none'),
          animationHash, animationStatus?.status || (animationHash ? 'unknown' : 'none'),
          Date.now()
        );

        // Update contract progress in DB
        updateContractProgress.run(tokenId, existingTokens, skippedTokens, 'in_progress', Date.now(), contractAddress);

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
          skippedTokens++;
          saveSkippedToken.run(contractAddress, tokenId, Date.now());

          sendProgress({
            type: 'skip',
            tokenId,
            progress: {
              current: tokenId - startId + 1,
              total: scanCount,
              percentage: Math.round(((tokenId - startId + 1) / scanCount) * 100)
            }
          });

          // Update progress in DB
          updateContractProgress.run(tokenId, existingTokens, skippedTokens, 'in_progress', Date.now(), contractAddress);
        } else {
          consecutiveRpcErrors++;
          console.error(`RPC error token ${tokenId}:`, error.message?.substring(0, 80));

          // Save progress before potentially stopping
          updateContractProgress.run(tokenId - 1, existingTokens, skippedTokens, 'paused', Date.now(), contractAddress);

          if (consecutiveRpcErrors >= maxConsecutiveRpcErrors) {
            sendProgress({
              type: 'info',
              message: `Paused after ${maxConsecutiveRpcErrors} consecutive RPC errors. Found ${existingTokens} tokens, skipped ${skippedTokens} empty IDs. Resume anytime.`
            });
            break;
          }
        }
      }

      if (delayBetweenRequests > 0) {
        await new Promise(r => setTimeout(r, delayBetweenRequests));
      }
    }

    // Mark as complete if we scanned everything
    const lastScanned = Math.min(endId, resumeFromId + scanCount - 1);
    const isComplete = lastScanned >= endId;
    updateContractProgress.run(
      lastScanned, existingTokens, skippedTokens,
      isComplete ? 'complete' : 'paused',
      Date.now(), contractAddress
    );

    sendProgress({
      type: 'info',
      message: isComplete
        ? `Scan complete. ${existingTokens} tokens found, ${skippedTokens} empty IDs skipped.`
        : `Scan paused at #${lastScanned}. ${existingTokens} tokens found so far. Resume anytime.`
    });

    sendProgress({ type: 'complete', results });
    return results;

  } catch (error) {
    console.error('Contract analysis failed:', error);
    sendProgress({ type: 'error', error: error.message });
    throw error;
  }
}
