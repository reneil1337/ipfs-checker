import axios from 'axios';
import { getHashStatus, saveHashStatus } from './db.js';

export const IPFS_GATEWAY = process.env.IPFS_GATEWAY_URL || 'https://ipfs.io/ipfs/';

export function extractHashFromUri(uri) {
  if (!uri) return null;
  
  // Handle ipfs:// protocol
  if (uri.startsWith('ipfs://')) {
    return uri.replace('ipfs://', '');
  }
  
  // Handle gateway URLs
  const gatewayMatch = uri.match(/\/ipfs\/(Qm[a-zA-Z0-9]+|bafy[a-zA-Z0-9]+)/);
  if (gatewayMatch) {
    return gatewayMatch[1];
  }
  
  // Direct hash
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
  
  const startTime = Date.now();
  
  try {
    const response = await axios.head(`${IPFS_GATEWAY}${hash}`, {
      timeout: 10000,
      validateStatus: (status) => status < 400
    });
    
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
    const status = 'offline';
    
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
  const hash = extractHashFromUri(uri);
  if (!hash) return null;
  
  try {
    const response = await axios.get(`${IPFS_GATEWAY}${hash}`, {
      timeout: 10000
    });
    return response.data;
  } catch (error) {
    console.error(`Failed to fetch metadata for ${uri}:`, error.message);
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
