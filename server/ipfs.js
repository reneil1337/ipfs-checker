import axios from 'axios';
import { getHashStatus, saveHashStatus, saveTokenAnalysis } from './db.js';

export const IPFS_GATEWAY = process.env.IPFS_GATEWAY_URL || 'https://ipfs.io/ipfs/';

// Use a plain User-Agent -- ipfs.io blocks non-browser agents via Cloudflare
const httpClient = axios.create({
  headers: {
    'User-Agent': 'curl/8.0',
    'Accept': '*/*'
  }
});

export function extractHashFromUri(uri) {
  if (!uri) return null;
  
  // Handle ipfs:// protocol
  if (uri.startsWith('ipfs://')) {
    return uri.replace('ipfs://', '');
  }
  
  // Handle gateway URLs (with optional path after hash)
  const gatewayMatch = uri.match(/\/ipfs\/(Qm[a-zA-Z0-9]+|bafy[a-zA-Z0-9]+)/);
  if (gatewayMatch) {
    return gatewayMatch[1];
  }
  
  // Direct hash (possibly with path suffix like /1)
  const directMatch = uri.match(/^(Qm[a-zA-Z0-9]+|bafy[a-zA-Z0-9]+)/);
  if (directMatch) {
    return directMatch[1];
  }
  
  return null;
}

// Extract full path from URI (hash + any path suffix like /1, /metadata.json)
export function extractFullPath(uri) {
  if (!uri) return null;
  
  if (uri.startsWith('ipfs://')) {
    return uri.replace('ipfs://', '');
  }
  
  const gatewayMatch = uri.match(/\/ipfs\/((?:Qm[a-zA-Z0-9]+|bafy[a-zA-Z0-9]+)(?:\/.*)?)/);
  if (gatewayMatch) {
    return gatewayMatch[1];
  }
  
  if (/^(Qm[a-zA-Z0-9]+|bafy[a-zA-Z0-9]+)/.test(uri)) {
    return uri;
  }
  
  return null;
}

export async function checkIpfsHash(hash, forceCheck = false) {
  if (!hash) return null;
  
  // Check cache first
  if (!forceCheck) {
    const cached = getHashStatus.get(hash);
    if (cached) {
      const age = Date.now() - cached.last_checked;
      // Cache for 24 hours
      if (age < 24 * 60 * 60 * 1000) {
        return {
          hash,
          status: cached.status,
          responseTime: cached.response_time,
          cached: true
        };
      }
    }
  }
  
  const url = `${IPFS_GATEWAY}${hash}`;
  const startTime = Date.now();
  
  try {
    // Use HEAD first, fall back to GET if HEAD fails with 403/405
    let response;
    try {
      response = await httpClient.head(url, {
        timeout: 15000,
        maxRedirects: 5,
        validateStatus: (status) => status < 400
      });
    } catch (headError) {
      const headStatus = headError.response?.status;
      // Some gateways block HEAD or return 403 - try GET with range header
      if (headStatus === 403 || headStatus === 405 || !headStatus) {
        response = await httpClient.get(url, {
          timeout: 15000,
          maxRedirects: 5,
          headers: { 'Range': 'bytes=0-0' },
          validateStatus: (status) => status < 400 || status === 416
        });
      } else {
        throw headError;
      }
    }
    
    const responseTime = Date.now() - startTime;
    const status = 'online';
    
    saveHashStatus.run(hash, status, Date.now(), responseTime);
    
    return {
      hash,
      status,
      responseTime,
      cached: false
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    
    // If we got a response at all (even 4xx/5xx), the content exists on IPFS
    // but the gateway is having issues. Only mark offline for timeouts/network errors.
    const httpStatus = error.response?.status;
    const isGatewayError = httpStatus && httpStatus >= 500;
    const isNotFound = httpStatus === 404 || httpStatus === 410;
    
    let status;
    if (isNotFound) {
      status = 'offline';
    } else if (isGatewayError) {
      status = 'unknown'; // Gateway issue, not necessarily offline
    } else {
      status = 'offline';
    }
    
    saveHashStatus.run(hash, status, Date.now(), responseTime);
    
    return {
      hash,
      status,
      responseTime,
      error: error.message,
      cached: false
    };
  }
}

export async function fetchMetadata(uri) {
  const fullPath = extractFullPath(uri);
  if (!fullPath) return null;
  
  try {
    const response = await httpClient.get(`${IPFS_GATEWAY}${fullPath}`, {
      timeout: 15000,
      maxRedirects: 5
    });
    return response.data;
  } catch (error) {
    console.error(`Failed to fetch metadata for ${uri}:`, error.message?.substring(0, 80));
    return null;
  }
}

export function extractHashesFromMetadata(metadata) {
  if (!metadata) return {};
  
  return {
    image: extractHashFromUri(metadata.image),
    animation: extractHashFromUri(metadata.animation_url)
  };
}

/**
 * Recheck all offline/unknown hashes for a set of token rows.
 * Each hash is force-checked (bypasses cache). Updated statuses are
 * persisted to both ipfs_checks and token_analysis tables.
 * Progress is streamed via the sendProgress callback.
 *
 * Returns the number of tokens whose status changed.
 */
export async function recheckOfflineHashes(contractAddress, tokenRows, sendProgress) {
  let updated = 0;
  const total = tokenRows.length;

  for (let i = 0; i < tokenRows.length; i++) {
    const t = tokenRows[i];
    let changed = false;
    let newMetadataStatus = t.metadata_status;
    let newImageStatus = t.image_status;
    let newAnimationStatus = t.animation_status;

    // Recheck metadata hash if offline/unknown
    if (t.metadata_hash && (t.metadata_status === 'offline' || t.metadata_status === 'unknown')) {
      const result = await checkIpfsHash(t.metadata_hash, true);
      if (result && result.status !== t.metadata_status) {
        newMetadataStatus = result.status;
        changed = true;
      }

      // If metadata just came online, try to fetch image/animation hashes
      if (result && result.status === 'online' && (!t.image_hash && !t.animation_hash)) {
        const metadata = await fetchMetadata(t.token_uri);
        if (metadata) {
          const hashes = extractHashesFromMetadata(metadata);
          if (hashes.image) {
            t.image_hash = hashes.image;
            const imgResult = await checkIpfsHash(hashes.image, true);
            newImageStatus = imgResult?.status || 'unknown';
            changed = true;
          }
          if (hashes.animation) {
            t.animation_hash = hashes.animation;
            const animResult = await checkIpfsHash(hashes.animation, true);
            newAnimationStatus = animResult?.status || 'unknown';
            changed = true;
          }
        }
      }
    }

    // Recheck image hash if offline/unknown
    if (t.image_hash && (t.image_status === 'offline' || t.image_status === 'unknown')) {
      const result = await checkIpfsHash(t.image_hash, true);
      if (result && result.status !== t.image_status) {
        newImageStatus = result.status;
        changed = true;
      }
    }

    // Recheck animation hash if offline/unknown
    if (t.animation_hash && (t.animation_status === 'offline' || t.animation_status === 'unknown')) {
      const result = await checkIpfsHash(t.animation_hash, true);
      if (result && result.status !== t.animation_status) {
        newAnimationStatus = result.status;
        changed = true;
      }
    }

    if (changed) {
      updated++;
      // Persist updated statuses to token_analysis
      saveTokenAnalysis.run(
        contractAddress, t.token_id, t.token_uri,
        t.metadata_hash, newMetadataStatus,
        t.image_hash, newImageStatus,
        t.animation_hash, newAnimationStatus,
        Date.now()
      );
    }

    // Send progress for every token regardless of change
    sendProgress({
      type: 'recheck',
      token: {
        tokenId: t.token_id,
        tokenURI: t.token_uri,
        metadataHash: t.metadata_hash,
        metadataStatus: newMetadataStatus,
        imageHash: t.image_hash,
        imageStatus: newImageStatus || (t.image_hash ? 'unknown' : 'none'),
        animationHash: t.animation_hash,
        animationStatus: newAnimationStatus || (t.animation_hash ? 'unknown' : 'none'),
      },
      changed,
      progress: {
        current: i + 1,
        total,
        percentage: Math.round(((i + 1) / total) * 100)
      }
    });

    // Small delay between checks to avoid hammering the gateway
    await new Promise(r => setTimeout(r, 300));
  }

  return updated;
}
