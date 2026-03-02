import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const db = new Database(path.join(__dirname, 'ipfs_cache.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS ipfs_checks (
    hash TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    last_checked INTEGER NOT NULL,
    response_time INTEGER
  );

  CREATE TABLE IF NOT EXISTS contract_analysis (
    contract_address TEXT PRIMARY KEY,
    total_tokens INTEGER,
    last_analyzed INTEGER
  );

  CREATE TABLE IF NOT EXISTS token_analysis (
    contract_address TEXT,
    token_id INTEGER,
    token_uri TEXT,
    metadata_hash TEXT,
    image_hash TEXT,
    animation_hash TEXT,
    PRIMARY KEY (contract_address, token_id)
  );
`);

export const getHashStatus = db.prepare('SELECT * FROM ipfs_checks WHERE hash = ?');
export const saveHashStatus = db.prepare(`
  INSERT INTO ipfs_checks (hash, status, last_checked, response_time)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(hash) DO UPDATE SET
    status = excluded.status,
    last_checked = excluded.last_checked,
    response_time = excluded.response_time
`);

export const saveTokenAnalysis = db.prepare(`
  INSERT INTO token_analysis (
    contract_address, token_id, token_uri, metadata_hash, image_hash, animation_hash
  ) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(contract_address, token_id) DO UPDATE SET
    token_uri = excluded.token_uri,
    metadata_hash = excluded.metadata_hash,
    image_hash = excluded.image_hash,
    animation_hash = excluded.animation_hash
`);

export const getTokenAnalysis = db.prepare(`
  SELECT * FROM token_analysis WHERE contract_address = ? AND token_id = ?
`);

export const getContractTokens = db.prepare(`
  SELECT * FROM token_analysis WHERE contract_address = ? ORDER BY token_id
`);

export const close = () => db.close();
