# IPFS NFT Checker

A Vue.js + Tailwind CSS application that analyzes Ethereum smart contracts and checks the availability of IPFS hashes for NFT metadata, images, and animations in real-time.

## Features

- **Real-time Analysis**: Uses Server-Sent Events (SSE) to stream analysis progress
- **Smart Contract Integration**: Reads ERC-721 token URIs using ethers.js
- **IPFS Hash Checking**: Verifies availability of metadata, image, and animation URLs (HEAD with GET fallback to handle 403/405 gateways)
- **RPC Failover**: Automatic rotation through multiple Ethereum RPC endpoints when one fails
- **Token Discovery**: Binary-search probing to discover token ID ranges when `totalSupply()` is unavailable
- **Burned/Missing Token Handling**: Gracefully skips non-existent token IDs instead of treating them as errors
- **Recheck Offline/Unknown**: One-click button to force-recheck all hashes with offline or unknown status, streamed via SSE with a dedicated progress bar
- **SQLite Caching**: Stores analysis results to avoid re-checking hashes (24-hour TTL)
- **Responsive UI**: Built with Tailwind CSS with live status messages, skip counters, and per-status summary badges
- **Configurable IPFS Gateway**: Set your preferred gateway via environment variables

## Installation

```bash
cd ipfs-checker
npm install
```

## Configuration

Create a `.env` file in the root directory:

```env
# IPFS Gateway Configuration (default: https://ipfs.io/ipfs/)
IPFS_GATEWAY_URL=https://ipfs.io/ipfs/

# Ethereum RPC Configuration (optional — the app has built-in fallback RPCs)
ETHEREUM_RPC_URL=https://eth.llamarpc.com

# Server Configuration
PORT=3012
VITE_API_URL=http://localhost:3012
```

If `ETHEREUM_RPC_URL` is set it will be tried first; otherwise the app cycles through a built-in list of public RPCs (publicnode, llamarpc, drpc, ankr, etc.) and automatically rotates on failure.

## Usage

### Development Mode

Run both the backend server and frontend development server:

```bash
npm run dev
```

This will start:
- Backend API on http://localhost:3012
- Frontend dev server on http://localhost:5173

### Production Build

```bash
npm run build
```

### Run Server Only

```bash
npm run server
```

## API Endpoints

- `GET /api/analyze/:address` - Start analysis (SSE stream). Query params: `maxTokens` (default 10000), `delay` (ms between requests, default 300)
- `GET /api/recheck/:address` - Force-recheck all offline/unknown IPFS hashes for a contract (SSE stream)
- `GET /api/results/:address` - Get cached results for a contract
- `GET /api/config` - Get current configuration
- `GET /api/health` - Health check

### SSE Event Types

| Type | Description |
|------|-------------|
| `connected` | Initial handshake |
| `info` | Status messages (RPC in use, discovery progress) |
| `start` | Analysis beginning, includes total count and contract info |
| `token` | A token was successfully analyzed |
| `skip` | A token ID was skipped (burned or non-existent) |
| `recheck` | A hash was rechecked (includes updated status and whether it changed) |
| `complete` | Analysis finished |
| `error` | Fatal error |

## How It Works

1. User enters an Ethereum contract address (or an Etherscan URL)
2. The backend connects via the RPC manager, trying the primary RPC first and rotating on failure
3. Token range discovery:
   - Tries `totalSupply()` first
   - If unavailable, uses binary-search probing (`ownerOf`) to find the highest existing token ID
4. For each token ID in the range:
   - Calls `tokenURI(tokenId)` to get the metadata URL
   - If the token doesn't exist (burned/never minted), it is silently skipped
   - Extracts the IPFS hash (and full path for subdirectory URIs like `ipfs://Qm.../1`)
   - Checks hash availability using HEAD, falling back to a ranged GET if the gateway returns 403/405
   - If metadata is online, fetches it and checks `image` and `animation_url` hashes
5. Results stream to the UI in real-time via SSE (including `skip` events for missing tokens)
6. Analysis stops early after 10 consecutive RPC errors to avoid hanging
7. All hash checks are cached in SQLite with a 24-hour TTL
8. After analysis, the user can click **Recheck offline/unknown** to force-recheck all hashes that were marked offline or unknown, bypassing the cache. Updated statuses are persisted and streamed live

## Database Schema

### ipfs_checks
- `hash` (TEXT PRIMARY KEY)
- `status` (TEXT) - online/offline/unknown (unknown = gateway error, content may still exist)
- `last_checked` (INTEGER) - timestamp
- `response_time` (INTEGER) - milliseconds

### token_analysis
- `contract_address` (TEXT)
- `token_id` (INTEGER)
- `token_uri` (TEXT)
- `metadata_hash` (TEXT)
- `image_hash` (TEXT)
- `animation_hash` (TEXT)

## Technology Stack

- **Frontend**: Vue 3 + Vite + Tailwind CSS
- **Backend**: Node.js + Express
- **Blockchain**: ethers.js
- **Database**: better-sqlite3
- **HTTP Client**: axios

## Coolify Deployment

This application is ready for deployment on Coolify:

### Method 1: Dockerfile (Recommended)

1. In Coolify, create a new resource and select "Dockerfile"
2. Set the repository URL to your Git repository
3. Configure environment variables:
   - `IPFS_GATEWAY_URL` - IPFS gateway URL (default: https://ipfs.io/ipfs/)
   - `ETHEREUM_RPC_URL` - Ethereum RPC endpoint (default: https://eth.llamarpc.com)
   - `PORT` - 3012
4. Deploy!

### Method 2: Docker Compose

1. In Coolify, create a new resource and select "Docker Compose"
2. Upload or link the `docker-compose.yaml` file
3. Configure the same environment variables
4. The app will be available on port 3012

### Environment Variables for Production

```env
IPFS_GATEWAY_URL=https://ipfs.io/ipfs/
ETHEREUM_RPC_URL=https://eth.llamarpc.com
PORT=3012
NODE_ENV=production
```

### Build Locally

```bash
docker build -t ipfs-checker .
docker run -p 3012:3012 -e PORT=3012 ipfs-checker
```

### Docker Compose Locally

```bash
docker compose up -d
```

> **Note**: The Docker image uses `node:20-slim` (Debian-based) instead of Alpine to ensure reliable native compilation of `better-sqlite3`.

## Example Contract

Try analyzing this contract:
- Address: `0x87d04ff86cafee75d572691b31509f72c0088c2b`
- Etherscan: https://etherscan.io/address/0x87d04ff86cafee75d572691b31509f72c0088c2b#readContract

## License

MIT
