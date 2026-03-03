import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const db = new Database(path.join(__dirname, 'ipfs_cache.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS ipfs_checks (
    hash TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    last_checked INTEGER NOT NULL,
    response_time INTEGER
  );

  CREATE TABLE IF NOT EXISTS contract_analysis (
    contract_address TEXT PRIMARY KEY,
    name TEXT,
    symbol TEXT,
    start_id INTEGER NOT NULL DEFAULT 1,
    end_id INTEGER NOT NULL DEFAULT 0,
    last_scanned_id INTEGER NOT NULL DEFAULT 0,
    tokens_found INTEGER NOT NULL DEFAULT 0,
    tokens_skipped INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    last_updated INTEGER NOT NULL,
    contract_uri TEXT,
    contract_uri_hash TEXT,
    contract_uri_status TEXT
  );

  CREATE TABLE IF NOT EXISTS token_analysis (
    contract_address TEXT NOT NULL,
    token_id INTEGER NOT NULL,
    token_uri TEXT,
    metadata_hash TEXT,
    metadata_status TEXT,
    image_hash TEXT,
    image_status TEXT,
    animation_hash TEXT,
    animation_status TEXT,
    last_checked INTEGER NOT NULL,
    PRIMARY KEY (contract_address, token_id)
  );

  CREATE TABLE IF NOT EXISTS skipped_tokens (
    contract_address TEXT NOT NULL,
    token_id INTEGER NOT NULL,
    PRIMARY KEY (contract_address, token_id)
  );
`);

// Migration: add contract_uri columns to existing databases
try {
  db.exec(`ALTER TABLE contract_analysis ADD COLUMN contract_uri TEXT`);
} catch { /* column already exists */ }
try {
  db.exec(`ALTER TABLE contract_analysis ADD COLUMN contract_uri_hash TEXT`);
} catch { /* column already exists */ }
try {
  db.exec(`ALTER TABLE contract_analysis ADD COLUMN contract_uri_status TEXT`);
} catch { /* column already exists */ }

// --- IPFS hash checks ---
export const getHashStatus = db.prepare('SELECT * FROM ipfs_checks WHERE hash = ?');
export const saveHashStatus = db.prepare(`
  INSERT INTO ipfs_checks (hash, status, last_checked, response_time)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(hash) DO UPDATE SET
    status = excluded.status,
    last_checked = excluded.last_checked,
    response_time = excluded.response_time
`);

// --- Contract analysis ---
export const getContractAnalysis = db.prepare(
  'SELECT * FROM contract_analysis WHERE contract_address = ?'
);

export const saveContractAnalysis = db.prepare(`
  INSERT INTO contract_analysis (
    contract_address, name, symbol, start_id, end_id, last_scanned_id,
    tokens_found, tokens_skipped, status, last_updated,
    contract_uri, contract_uri_hash, contract_uri_status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(contract_address) DO UPDATE SET
    name = excluded.name,
    symbol = excluded.symbol,
    start_id = excluded.start_id,
    end_id = excluded.end_id,
    last_scanned_id = excluded.last_scanned_id,
    tokens_found = excluded.tokens_found,
    tokens_skipped = excluded.tokens_skipped,
    status = excluded.status,
    last_updated = excluded.last_updated,
    contract_uri = excluded.contract_uri,
    contract_uri_hash = excluded.contract_uri_hash,
    contract_uri_status = excluded.contract_uri_status
`);

export const updateContractProgress = db.prepare(`
  UPDATE contract_analysis
  SET last_scanned_id = ?, tokens_found = ?, tokens_skipped = ?, status = ?, last_updated = ?
  WHERE contract_address = ?
`);

export const updateContractUri = db.prepare(`
  UPDATE contract_analysis
  SET contract_uri = ?, contract_uri_hash = ?, contract_uri_status = ?, last_updated = ?
  WHERE contract_address = ?
`);

// --- Token analysis ---
export const saveTokenAnalysis = db.prepare(`
  INSERT INTO token_analysis (
    contract_address, token_id, token_uri, metadata_hash, metadata_status,
    image_hash, image_status, animation_hash, animation_status, last_checked
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(contract_address, token_id) DO UPDATE SET
    token_uri = excluded.token_uri,
    metadata_hash = excluded.metadata_hash,
    metadata_status = excluded.metadata_status,
    image_hash = excluded.image_hash,
    image_status = excluded.image_status,
    animation_hash = excluded.animation_hash,
    animation_status = excluded.animation_status,
    last_checked = excluded.last_checked
`);

export const getTokenAnalysis = db.prepare(
  'SELECT * FROM token_analysis WHERE contract_address = ? AND token_id = ?'
);

export const getContractTokens = db.prepare(
  'SELECT * FROM token_analysis WHERE contract_address = ? ORDER BY token_id'
);

// --- Skipped tokens ---
export const saveSkippedToken = db.prepare(`
  INSERT OR IGNORE INTO skipped_tokens (contract_address, token_id) VALUES (?, ?)
`);

export const isTokenSkipped = db.prepare(
  'SELECT 1 FROM skipped_tokens WHERE contract_address = ? AND token_id = ?'
);

export const getSkippedTokens = db.prepare(
  'SELECT token_id FROM skipped_tokens WHERE contract_address = ? ORDER BY token_id'
);

// --- Tokens needing recheck (offline or unknown on any hash) ---
export const getTokensToRecheck = db.prepare(`
  SELECT * FROM token_analysis
  WHERE contract_address = ?
    AND (
      metadata_status IN ('offline', 'unknown')
      OR image_status IN ('offline', 'unknown')
      OR animation_status IN ('offline', 'unknown')
    )
  ORDER BY token_id
`);

// --- Listings ---
export const getAllContracts = db.prepare(
  'SELECT * FROM contract_analysis ORDER BY last_updated DESC'
);

export const close = () => db.close();
