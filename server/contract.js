import { ethers } from 'ethers';
import { fetchMetadata, extractHashesFromMetadata, checkIpfsHash, extractHashFromUri, IPFS_GATEWAY } from './ipfs.js';
import { saveTokenAnalysis } from './db.js';

const RPC_URL = process.env.ETHEREUM_RPC_URL || 'https://eth.llamarpc.com';

const ERC721_ABI = [
  'function totalSupply() view returns (uint256)',
  'function tokenByIndex(uint256 index) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function symbol() view returns (string)',
  'function name() view returns (string)'
];

const ERC1155_ABI = [
  'function uri(uint256 id) view returns (string)',
  'function totalSupply(uint256 id) view returns (uint256)'
];

export async function analyzeContract(contractAddress, sendProgress, options = {}) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const contract = new ethers.Contract(contractAddress, ERC721_ABI, provider);
  
  const results = [];
  const maxTokens = options.maxTokens || 10000;
  const delayBetweenRequests = options.delay || 100;
  
  try {
    // Get contract info
    let name, symbol;
    try {
      name = await contract.name();
      symbol = await contract.symbol();
    } catch (e) {
      console.log('Could not get contract name/symbol');
    }
    
    sendProgress({
      type: 'info',
      message: `Analyzing contract: ${name || 'Unknown'} (${symbol || 'Unknown'})`
    });

    // Determine total supply
    let totalSupply;
    try {
      totalSupply = await contract.totalSupply();
      totalSupply = Number(totalSupply);
    } catch (e) {
      // Fallback: iterate through token IDs
      totalSupply = maxTokens;
    }
    
    const tokenCount = Math.min(totalSupply, maxTokens);
    
    sendProgress({
      type: 'start',
      total: tokenCount,
      contract: { address: contractAddress, name, symbol }
    });

    // Analyze each token
    for (let i = 0; i < tokenCount; i++) {
      const tokenId = i + 1; // Most ERC721 start at 1
      
      try {
        // Get token URI
        const tokenURI = await contract.tokenURI(tokenId);
        const metadataHash = extractHashFromUri(tokenURI);
        
        // Check metadata hash status
        const metadataStatus = await checkIpfsHash(metadataHash);
        
        // Fetch metadata if available
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
          
          if (imageHash) {
            imageStatus = await checkIpfsHash(imageHash);
          }
          
          if (animationHash) {
            animationStatus = await checkIpfsHash(animationHash);
          }
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
        
        // Save to database
        saveTokenAnalysis.run(
          contractAddress,
          tokenId,
          tokenURI,
          metadataHash,
          imageHash,
          animationHash
        );
        
        results.push(tokenData);
        
        sendProgress({
          type: 'token',
          token: tokenData,
          progress: {
            current: i + 1,
            total: tokenCount,
            percentage: Math.round(((i + 1) / tokenCount) * 100)
          }
        });
        
        // Delay to avoid rate limiting
        if (delayBetweenRequests > 0) {
          await new Promise(resolve => setTimeout(resolve, delayBetweenRequests));
        }
        
      } catch (error) {
        console.error(`Error processing token ${tokenId}:`, error.message);
        
        const tokenData = {
          tokenId,
          error: error.message,
          tokenURI: null,
          metadataHash: null,
          metadataStatus: 'error',
          imageHash: null,
          imageStatus: 'none',
          animationHash: null,
          animationStatus: 'none'
        };
        
        results.push(tokenData);
        
        sendProgress({
          type: 'token',
          token: tokenData,
          progress: {
            current: i + 1,
            total: tokenCount,
            percentage: Math.round(((i + 1) / tokenCount) * 100)
          }
        });
      }
    }
    
    sendProgress({
      type: 'complete',
      results
    });
    
    return results;
    
  } catch (error) {
    console.error('Contract analysis failed:', error);
    sendProgress({
      type: 'error',
      error: error.message
    });
    throw error;
  }
}
