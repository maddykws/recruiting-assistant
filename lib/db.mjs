/**
 * SQLite database layer using sql.js (pure WebAssembly — no native build required).
 * Data is persisted to disk via Node.js fs.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '..', 'data');
const DB_PATH = join(DATA_DIR, 'candidates.db');

// Ensure data directory exists
mkdirSync(DATA_DIR, { recursive: true });

// Lazy-loaded db instance
let _db = null;
let _SQL = null;
let _dirty = false; // Track if we need to save to disk

async function getDb() {
  if (_db) return _db;

  // Dynamic import of sql.js
  const require = createRequire(import.meta.url);
  _SQL = await require('sql.js')();

  // Load existing database from disk if it exists
  if (existsSync(DB_PATH)) {
    try {
      const fileBuffer = readFileSync(DB_PATH);
      _db = new _SQL.Database(fileBuffer);
    } catch (_) {
      _db = new _SQL.Database();
    }
  } else {
    _db = new _SQL.Database();
  }

  // Create schema
  _db.run(`
    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      npi TEXT,
      full_name TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      specialty TEXT,
      credential TEXT,
      phone TEXT,
      email TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      address TEXT,
      doximity_url TEXT,
      healthgrades_url TEXT,
      hospital_affiliation TEXT,
      score REAL,
      match_reason TEXT,
      outreach_line TEXT,
      source TEXT,
      job_title TEXT,
      rating REAL,
      search_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  _db.run(`CREATE INDEX IF NOT EXISTS idx_npi ON candidates(npi)`);
  _db.run(`CREATE INDEX IF NOT EXISTS idx_name_city ON candidates(full_name, city)`);
  _db.run(`CREATE INDEX IF NOT EXISTS idx_score ON candidates(score)`);

  return _db;
}

/**
 * Persist the in-memory database to disk.
 */
function saveToDisk() {
  if (!_db || !_dirty) return;
  try {
    const data = _db.export();
    writeFileSync(DB_PATH, Buffer.from(data));
    _dirty = false;
  } catch (err) {
    console.error('[DB] Failed to save to disk:', err.message);
  }
}

/**
 * Execute a query that modifies data, then mark dirty.
 */
function run(db, sql, params = []) {
  db.run(sql, params);
  _dirty = true;
}

/**
 * Execute a SELECT and return all rows as array of objects.
 */
function all(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

/**
 * Execute a SELECT and return the first row as an object, or null.
 */
function get(db, sql, params = []) {
  const rows = all(db, sql, params);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Upsert a candidate by NPI (if available) or by name+city.
 */
export async function upsertCandidate(candidate, searchId = null) {
  const db = await getDb();

  const fields = {
    npi: candidate.npi || null,
    full_name: candidate.full_name || 'Unknown',
    first_name: candidate.first_name || null,
    last_name: candidate.last_name || null,
    specialty: candidate.specialty || null,
    credential: candidate.credential || null,
    phone: candidate.phone || null,
    email: candidate.email || null,
    city: candidate.city || null,
    state: candidate.state || null,
    zip: candidate.zip || null,
    address: candidate.address || null,
    doximity_url: candidate.doximity_url || null,
    healthgrades_url: candidate.healthgrades_url || null,
    hospital_affiliation: candidate.hospital_affiliation || null,
    score: candidate.score != null ? candidate.score : null,
    match_reason: candidate.match_reason || null,
    outreach_line: candidate.outreach_line || null,
    source: candidate.source || null,
    job_title: candidate.job_title || null,
    rating: candidate.rating != null ? candidate.rating : null,
    search_id: searchId,
  };

  // Check for existing record
  let existing = null;
  if (fields.npi) {
    existing = get(db, 'SELECT id FROM candidates WHERE npi = ?', [fields.npi]);
  }
  if (!existing && fields.full_name && fields.city) {
    existing = get(db, 'SELECT id FROM candidates WHERE full_name = ? AND city = ?', [fields.full_name, fields.city]);
  }

  const vals = Object.values(fields);

  if (existing) {
    const setClauses = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    run(db, `UPDATE candidates SET ${setClauses} WHERE id = ?`, [...vals, existing.id]);
    saveToDisk();
    return existing.id;
  } else {
    const cols = Object.keys(fields).join(', ');
    const placeholders = Object.keys(fields).map(() => '?').join(', ');
    run(db, `INSERT INTO candidates (${cols}) VALUES (${placeholders})`, vals);
    saveToDisk();
    // Get the last inserted ID
    const result = get(db, 'SELECT last_insert_rowid() as id');
    return result ? result.id : null;
  }
}

/**
 * Get candidates with optional filters.
 */
export async function getCandidates(filters = {}) {
  const db = await getDb();

  let query = 'SELECT * FROM candidates WHERE 1=1';
  const params = [];

  if (filters.specialty) {
    query += ' AND specialty LIKE ?';
    params.push(`%${filters.specialty}%`);
  }
  if (filters.state) {
    query += ' AND state = ?';
    params.push(filters.state);
  }
  if (filters.search_id) {
    query += ' AND search_id = ?';
    params.push(filters.search_id);
  }
  if (filters.min_score != null) {
    query += ' AND score >= ?';
    params.push(filters.min_score);
  }

  query += ' ORDER BY score DESC, id DESC';

  if (filters.limit) {
    query += ' LIMIT ?';
    params.push(filters.limit);
  }

  return all(db, query, params);
}

/**
 * Get all candidates ordered by score.
 */
export async function getAllCandidates() {
  const db = await getDb();
  return all(db, 'SELECT * FROM candidates ORDER BY score DESC, id DESC');
}

/**
 * Clear all candidates for a fresh search.
 */
export async function clearSearch() {
  const db = await getDb();
  run(db, 'DELETE FROM candidates');
  saveToDisk();
}

/**
 * Close and save the database.
 */
export function closeDb() {
  saveToDisk();
  if (_db) {
    _db.close();
    _db = null;
  }
}
