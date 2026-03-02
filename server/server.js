import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { analyzeContract } from './contract.js';
import { recheckOfflineHashes } from './ipfs.js';
import { getContractTokens, getContractAnalysis, getAllContracts, getTokensToRecheck } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3012;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files from dist directory (production build)
app.use(express.static(path.join(__dirname, '../dist')));

// Store active SSE connections
const activeAnalyses = new Map();

// SSE endpoint for real-time updates (also resumes from where it left off)
app.get('/api/analyze/:address', (req, res) => {
  const { address } = req.params;
  const { maxTokens = 10000, delay = 300 } = req.query;
  
  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  
  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: 'connected', address })}\n\n`);
  
  let closed = false;
  const sendProgress = (data) => {
    if (!closed) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };
  
  // Store connection
  activeAnalyses.set(address, { res, sendProgress });
  
  // Handle client disconnect
  req.on('close', () => {
    closed = true;
    activeAnalyses.delete(address);
  });
  
  // Start or resume analysis
  analyzeContract(address, sendProgress, {
    maxTokens: parseInt(maxTokens),
    delay: parseInt(delay)
  }).catch(error => {
    console.error('Analysis error:', error);
    if (!closed) {
      sendProgress({
        type: 'error',
        error: error.message
      });
    }
  });
});

// Get cached analysis state and tokens for a contract
app.get('/api/results/:address', (req, res) => {
  const { address } = req.params;
  const normalized = address.toLowerCase();
  
  try {
    const analysis = getContractAnalysis.get(normalized);
    const tokens = getContractTokens.all(normalized);
    res.json({
      contract: normalized,
      analysis: analysis || null,
      tokens: (tokens || []).map(t => ({
        tokenId: t.token_id,
        tokenURI: t.token_uri,
        metadataHash: t.metadata_hash,
        metadataStatus: t.metadata_status || 'unknown',
        imageHash: t.image_hash,
        imageStatus: t.image_status || 'none',
        animationHash: t.animation_hash,
        animationStatus: t.animation_status || 'none',
      }))
    });
  } catch (error) {
    console.error('Error fetching results:', error);
    res.status(500).json({ error: error.message });
  }
});

// List all previously analyzed contracts
app.get('/api/contracts', (req, res) => {
  try {
    const contracts = getAllContracts.all();
    res.json(contracts || []);
  } catch (error) {
    console.error('Error fetching contracts:', error);
    res.status(500).json({ error: error.message });
  }
});

// SSE endpoint for rechecking offline/unknown IPFS hashes
app.get('/api/recheck/:address', (req, res) => {
  const { address } = req.params;
  const normalized = address.toLowerCase();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let closed = false;
  const send = (data) => {
    if (!closed) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  req.on('close', () => { closed = true; });

  // Fetch tokens that need rechecking
  const tokens = getTokensToRecheck.all(normalized);

  if (!tokens || tokens.length === 0) {
    send({ type: 'info', message: 'No offline or unknown hashes to recheck.' });
    send({ type: 'complete', updated: 0 });
    // Don't call res.end() — let the client close the connection after
    // processing the complete event. Ending server-side causes EventSource
    // to fire onerror before the final message is handled.
    return;
  }

  send({ type: 'info', message: `Rechecking ${tokens.length} tokens with offline/unknown hashes...` });

  recheckOfflineHashes(normalized, tokens, send)
    .then(updated => {
      send({ type: 'complete', updated });
    })
    .catch(err => {
      console.error('Recheck error:', err);
      if (!closed) {
        send({ type: 'error', error: err.message });
      }
    });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get configuration
app.get('/api/config', (req, res) => {
  res.json({
    ipfsGateway: process.env.IPFS_GATEWAY_URL || 'https://ipfs.io/ipfs/'
  });
});

// Serve index.html for all non-API routes (SPA support)
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`IPFS Gateway: ${process.env.IPFS_GATEWAY_URL || 'https://ipfs.io/ipfs/'}`);
});
