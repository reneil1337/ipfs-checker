# IPFS NFT Checker

A Vue.js + Tailwind CSS application that analyzes Ethereum smart contracts and checks the availability of IPFS hashes for NFT metadata, images, and animations in real-time.

## Features

- **Real-time Analysis**: Uses Server-Sent Events (SSE) to stream analysis progress
- **Smart Contract Integration**: Reads ERC-721 token URIs using ethers.js
- **IPFS Hash Checking**: Verifies availability of metadata, image, and animation URLs
- **SQLite Caching**: Stores analysis results to avoid re-checking hashes unnecessarily
- **Responsive UI**: Built with Tailwind CSS
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

# Ethereum RPC Configuration
ETHEREUM_RPC_URL=https://eth.llamarpc.com

# Server Configuration
PORT=3001
VITE_API_URL=http://localhost:3001
```

## Usage

### Development Mode

Run both the backend server and frontend development server:

```bash
npm run dev
```

This will start:
- Backend API on http://localhost:3001
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

- `GET /api/analyze/:address` - Start analysis (SSE stream)
- `GET /api/results/:address` - Get cached results for a contract
- `GET /api/config` - Get current configuration
- `GET /api/health` - Health check

## How It Works

1. User enters an Ethereum contract address
2. System connects to the contract using ethers.js
3. For each token:
   - Calls `tokenURI(tokenId)` to get metadata URL
   - Extracts IPFS hash from the URL
   - Checks if the metadata hash is available (with 24-hour caching)
   - If available, fetches metadata and extracts `image` and `animation_url` hashes
   - Checks availability of image and animation hashes
4. Results stream to the UI in real-time via SSE
5. All results are cached in SQLite for future reference

## Database Schema

### ipfs_checks
- `hash` (TEXT PRIMARY KEY)
- `status` (TEXT) - online/offline
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
   - `PORT` - 3000
4. Deploy!

### Method 2: Docker Compose

1. In Coolify, create a new resource and select "Docker Compose"
2. Upload or link the `docker-compose.yml` file
3. Configure the same environment variables
4. The app will be available on port 3000

### Environment Variables for Production

```env
IPFS_GATEWAY_URL=https://ipfs.io/ipfs/
ETHEREUM_RPC_URL=https://eth.llamarpc.com
PORT=3000
NODE_ENV=production
```

### Build Locally

```bash
docker build -t ipfs-checker .
docker run -p 3000:3000 -e PORT=3000 ipfs-checker
```

### Docker Compose Locally

```bash
docker-compose up -d
```

## Example Contract

Try analyzing this contract:
- Address: `0x87d04ff86cafee75d572691b31509f72c0088c2b`
- Etherscan: https://etherscan.io/address/0x87d04ff86cafee75d572691b31509f72c0088c2b#readContract

## License

MIT
