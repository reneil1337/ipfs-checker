import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { analyzeContract } from './contract.js';
import { getContractTokens } from './db.js';

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

// SSE endpoint for real-time updates
app.get('/api/analyze/:address', (req, res) => {
  const { address } = req.params;
  const { maxTokens = 10000, delay = 100 } = req.query;
  
  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx/proxy buffering
  res.flushHeaders();
  
  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: 'connected', address })}\n\n`);
  
  const sendProgress = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  
  // Store connection
  activeAnalyses.set(address, { res, sendProgress });
  
  // Handle client disconnect
  req.on('close', () => {
    activeAnalyses.delete(address);
  });
  
  // Start analysis
  analyzeContract(address, sendProgress, {
    maxTokens: parseInt(maxTokens),
    delay: parseInt(delay)
  }).catch(error => {
    console.error('Analysis error:', error);
    sendProgress({
      type: 'error',
      error: error.message
    });
  });
});

// Get cached results for a contract
app.get('/api/results/:address', (req, res) => {
  const { address } = req.params;
  
  try {
    const tokens = getContractTokens.all(address);
    res.json({
      contract: address,
      tokens: tokens || []
    });
  } catch (error) {
    console.error('Error fetching results:', error);
    res.status(500).json({ error: error.message });
  }
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
  // Skip API routes
  if (req.path.startsWith('/api/')) {
    return next();
  }
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`IPFS Gateway: ${process.env.IPFS_GATEWAY_URL || 'https://ipfs.io/ipfs/'}`);
});
