/**
 * db.mjs — SQLite database layer for recruiting-assistant
 *
 * Database: data/recruiting.db
 * Open with: DB Browser for SQLite → File > Open Database → data/recruiting.db
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dir, '..', 'data', 'recruiting.db');

// Ensure data/ folder exists
mkdirSync(join(__dir, '..', 'data'), { recursive: true });

let _db = null;

export function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  return _db;
}

/**
 * Create all tables (idempotent — safe to run multiple times)
 */
export function initDb() {
  const db = getDb();

  db.exec(`
    -- ─────────────────────────────────────────────────────────────────────
    -- jobs: Job descriptions that were searched
    -- ─────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS jobs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      title           TEXT    NOT NULL,
      specialty       TEXT    NOT NULL,
      subspecialty    TEXT,
      state_code      TEXT    NOT NULL,
      city            TEXT    NOT NULL,
      location        TEXT    NOT NULL,           -- "City, ST"
      experience_years INTEGER,
      requirements    TEXT,                        -- JSON array
      nice_to_haves   TEXT,                        -- JSON array
      raw_jd          TEXT,                        -- full JD text
      source          TEXT    DEFAULT 'manual',    -- 'manual' | 'bountyjobs' | etc
      created_at      TEXT    DEFAULT (datetime('now'))
    );

    -- ─────────────────────────────────────────────────────────────────────
    -- searches: Each time scripts were run for a job
    -- ─────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS searches (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id          INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
      specialty       TEXT    NOT NULL,
      state_code      TEXT    NOT NULL,
      city            TEXT    NOT NULL,
      npi_count       INTEGER DEFAULT 0,
      linkedin_count  INTEGER DEFAULT 0,
      doximity_count  INTEGER DEFAULT 0,
      healthgrades_count INTEGER DEFAULT 0,
      total_count     INTEGER DEFAULT 0,
      ran_at          TEXT    DEFAULT (datetime('now'))
    );

    -- ─────────────────────────────────────────────────────────────────────
    -- candidates: Every unique healthcare professional found
    -- ─────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS candidates (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      npi             TEXT    UNIQUE,              -- NPI number (dedup key)
      full_name       TEXT    NOT NULL,
      first_name      TEXT,
      last_name       TEXT,
      credential      TEXT,                        -- MD, DO, NP, PA, etc.
      specialty       TEXT,
      subspecialty    TEXT,
      hospital        TEXT,
      city            TEXT,
      state           TEXT,
      zip             TEXT,
      address         TEXT,
      phone           TEXT,                        -- practice phone from NPI
      email           TEXT,                        -- if found later
      linkedin_url    TEXT,
      doximity_url    TEXT,
      healthgrades_url TEXT,
      rating          REAL,                        -- healthgrades rating
      headline        TEXT,                        -- linkedin headline
      sources         TEXT,                        -- JSON array: ["npi","doximity",...]
      created_at      TEXT    DEFAULT (datetime('now')),
      updated_at      TEXT    DEFAULT (datetime('now'))
    );

    -- ─────────────────────────────────────────────────────────────────────
    -- candidate_scores: Score per candidate per job search
    -- ─────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS candidate_scores (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id    INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      search_id       INTEGER NOT NULL REFERENCES searches(id)   ON DELETE CASCADE,
      job_id          INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
      score           INTEGER NOT NULL CHECK (score BETWEEN 1 AND 10),
      specialty_pts   INTEGER,                     -- 0-4
      location_pts    INTEGER,                     -- 0-3
      credential_pts  INTEGER,                     -- 0-2
      completeness_pts INTEGER,                    -- 0-1
      match_reason    TEXT,
      outreach_line   TEXT,
      scored_at       TEXT    DEFAULT (datetime('now')),
      UNIQUE(candidate_id, search_id)
    );

    -- ─────────────────────────────────────────────────────────────────────
    -- outreach: Track contact attempts to candidates
    -- ─────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS outreach (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id    INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      job_id          INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
      channel         TEXT    NOT NULL,            -- 'linkedin' | 'email' | 'phone' | 'doximity'
      status          TEXT    NOT NULL DEFAULT 'draft',  -- 'draft' | 'sent' | 'opened' | 'replied' | 'declined'
      message         TEXT,
      sent_at         TEXT,
      replied_at      TEXT,
      reply_text      TEXT,
      notes           TEXT,
      created_at      TEXT    DEFAULT (datetime('now'))
    );

    -- ─────────────────────────────────────────────────────────────────────
    -- Indexes for fast lookups
    -- ─────────────────────────────────────────────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_candidates_npi        ON candidates(npi);
    CREATE INDEX IF NOT EXISTS idx_candidates_name       ON candidates(full_name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_candidates_specialty  ON candidates(specialty);
    CREATE INDEX IF NOT EXISTS idx_candidates_state      ON candidates(state);
    CREATE INDEX IF NOT EXISTS idx_scores_search         ON candidate_scores(search_id);
    CREATE INDEX IF NOT EXISTS idx_scores_candidate      ON candidate_scores(candidate_id);
    CREATE INDEX IF NOT EXISTS idx_scores_score          ON candidate_scores(score DESC);
    CREATE INDEX IF NOT EXISTS idx_outreach_candidate    ON outreach(candidate_id);
    CREATE INDEX IF NOT EXISTS idx_outreach_status       ON outreach(status);
  `);

  console.log('[DB] Schema initialized —', DB_PATH);
  return db;
}

// ─── Upsert a candidate (insert or update by NPI / normalized name) ────────
export function upsertCandidate(c) {
  const db = getDb();

  // Merge sources array
  const sourcesJson = JSON.stringify(
    [...new Set([c.source].filter(Boolean))]
  );

  if (c.npi) {
    // NPI-keyed upsert
    const existing = db.prepare('SELECT id, sources FROM candidates WHERE npi = ?').get(c.npi);
    if (existing) {
      const merged = JSON.stringify([...new Set([
        ...(JSON.parse(existing.sources || '[]')),
        c.source,
      ].filter(Boolean))]);
      db.prepare(`
        UPDATE candidates SET
          full_name        = COALESCE(NULLIF(?, ''), full_name),
          credential       = COALESCE(NULLIF(?, ''), credential),
          specialty        = COALESCE(NULLIF(?, ''), specialty),
          hospital         = COALESCE(NULLIF(?, ''), hospital),
          city             = COALESCE(NULLIF(?, ''), city),
          state            = COALESCE(NULLIF(?, ''), state),
          zip              = COALESCE(NULLIF(?, ''), zip),
          address          = COALESCE(NULLIF(?, ''), address),
          phone            = COALESCE(NULLIF(?, ''), phone),
          linkedin_url     = COALESCE(NULLIF(?, ''), linkedin_url),
          doximity_url     = COALESCE(NULLIF(?, ''), doximity_url),
          healthgrades_url = COALESCE(NULLIF(?, ''), healthgrades_url),
          rating           = COALESCE(?, rating),
          headline         = COALESCE(NULLIF(?, ''), headline),
          sources          = ?,
          updated_at       = datetime('now')
        WHERE npi = ?
      `).run(
        c.full_name, c.credential, c.specialty, c.hospital,
        c.city, c.state, c.zip, c.address, c.phone,
        c.linkedin_url, c.doximity_url, c.healthgrades_url,
        c.rating || null, c.headline, merged, c.npi
      );
      return existing.id;
    }
  } else {
    // Name-based dedup (no NPI)
    const normName = (c.full_name || '').toLowerCase().replace(/[^a-z\s]/g, '').trim();
    const existing = db.prepare(
      "SELECT id, sources FROM candidates WHERE LOWER(REPLACE(REPLACE(full_name,'.',' '),',',' ')) LIKE ?"
    ).get(`%${normName.split(' ').slice(0, 2).join('%')}%`);
    if (existing) {
      const merged = JSON.stringify([...new Set([
        ...(JSON.parse(existing.sources || '[]')),
        c.source,
      ].filter(Boolean))]);
      db.prepare(`
        UPDATE candidates SET
          linkedin_url     = COALESCE(NULLIF(?, ''), linkedin_url),
          doximity_url     = COALESCE(NULLIF(?, ''), doximity_url),
          healthgrades_url = COALESCE(NULLIF(?, ''), healthgrades_url),
          rating           = COALESCE(?, rating),
          hospital         = COALESCE(NULLIF(?, ''), hospital),
          headline         = COALESCE(NULLIF(?, ''), headline),
          sources          = ?,
          updated_at       = datetime('now')
        WHERE id = ?
      `).run(
        c.linkedin_url, c.doximity_url, c.healthgrades_url,
        c.rating || null, c.hospital, c.headline, merged, existing.id
      );
      return existing.id;
    }
  }

  // Insert new candidate
  const result = db.prepare(`
    INSERT INTO candidates (
      npi, full_name, first_name, last_name, credential,
      specialty, hospital, city, state, zip, address,
      phone, linkedin_url, doximity_url, healthgrades_url,
      rating, headline, sources
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    c.npi || null, c.full_name, c.first_name || null, c.last_name || null,
    c.credential || null, c.specialty || null, c.hospital || null,
    c.city || null, c.state || null, c.zip || null, c.address || null,
    c.phone || null, c.linkedin_url || null, c.doximity_url || null,
    c.healthgrades_url || null, c.rating || null, c.headline || null,
    sourcesJson
  );
  return result.lastInsertRowid;
}

// ─── Insert a job ──────────────────────────────────────────────────────────
export function insertJob(j) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO jobs (title, specialty, subspecialty, state_code, city, location,
                      experience_years, requirements, nice_to_haves, raw_jd, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    j.title, j.specialty, j.subspecialty || null, j.state_code, j.city, j.location,
    j.experience_years || null,
    Array.isArray(j.requirements) ? JSON.stringify(j.requirements) : j.requirements || null,
    Array.isArray(j.nice_to_haves) ? JSON.stringify(j.nice_to_haves) : j.nice_to_haves || null,
    j.raw_jd || null, j.source || 'manual'
  );
  return result.lastInsertRowid;
}

// ─── Insert a search run ───────────────────────────────────────────────────
export function insertSearch(s) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO searches (job_id, specialty, state_code, city,
                          npi_count, linkedin_count, doximity_count, healthgrades_count, total_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    s.job_id || null, s.specialty, s.state_code, s.city,
    s.npi_count || 0, s.linkedin_count || 0,
    s.doximity_count || 0, s.healthgrades_count || 0,
    (s.npi_count || 0) + (s.linkedin_count || 0) + (s.doximity_count || 0) + (s.healthgrades_count || 0)
  );
  return result.lastInsertRowid;
}

// ─── Insert a candidate score ──────────────────────────────────────────────
export function insertScore(s) {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO candidate_scores
      (candidate_id, search_id, job_id, score,
       specialty_pts, location_pts, credential_pts, completeness_pts,
       match_reason, outreach_line)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    s.candidate_id, s.search_id, s.job_id || null, s.score,
    s.specialty_pts || null, s.location_pts || null,
    s.credential_pts || null, s.completeness_pts || null,
    s.match_reason || null, s.outreach_line || null
  );
}

export { DB_PATH };
