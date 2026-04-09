#!/usr/bin/env node
/**
 * run-search.mjs — Parallel search orchestrator
 *
 * Runs all 4 scrapers concurrently, merges + deduplicates results,
 * compresses to slim JSON for Claude (reduces token usage ~65%),
 * saves raw candidates to SQLite, and prints the slim summary to stdout.
 *
 * Usage:
 *   node lib/run-search.mjs --specialty "Radiology" --state "NY" --city "New York" [--job-id 1] [--limit 50]
 *
 * Output (stdout): slim JSON array — one compact object per unique candidate
 * Progress (stderr): timing + per-source counts
 */

import { spawn }  from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { upsertCandidate, insertSearch, getDb, initDb } from './db.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));

// ─── CLI args ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const v = argv[i+1] && !argv[i+1].startsWith('--') ? argv[i+1] : true;
      a[k] = v; if (v !== true) i++;
    }
  }
  return a;
}
const args      = parseArgs(process.argv.slice(2));
const specialty = args.specialty;
const state     = args.state;
const city      = args.city;
const jobId     = args['job-id'] ? parseInt(args['job-id']) : null;
const limit     = args.limit || '50';

if (!specialty || !state || !city) {
  console.error('[Search] ERROR: --specialty, --state, and --city are required');
  process.exit(1);
}

const location = `${city}, ${state}`;

// ─── Run a child script, collect stdout as parsed JSON ─────────────────────
function runScript(scriptName, extraArgs = []) {
  return new Promise((resolve) => {
    const start = Date.now();
    const scriptPath = join(__dir, scriptName);
    const child = spawn('node', [scriptPath, ...extraArgs], {
      cwd: join(__dir, '..'),
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);

    child.on('close', (code) => {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      try {
        const results = JSON.parse(stdout || '[]');
        console.error(`[Search] ✓ ${scriptName} — ${results.length} results in ${elapsed}s`);
        resolve(results);
      } catch {
        console.error(`[Search] ✗ ${scriptName} — parse failed in ${elapsed}s (exit ${code})`);
        if (stderr) console.error(stderr.slice(-200));
        resolve([]);
      }
    });

    child.on('error', (err) => {
      console.error(`[Search] ✗ ${scriptName} — spawn error: ${err.message}`);
      resolve([]);
    });
  });
}

// ─── Slim a candidate down to compact scoring payload ─────────────────────
// Full record: ~100 tokens. Slim record: ~30 tokens. ~65% reduction.
function slim(c, id) {
  return {
    id,
    n:    c.full_name,
    cr:   c.credential  || '',
    sp:   c.specialty   || '',
    loc:  `${c.city || ''}, ${c.state || ''}`.trim().replace(/^,\s*/, ''),
    ph:   c.phone       ? 'yes' : 'no',
    src:  Array.isArray(c.sources) ? c.sources : [c.source].filter(Boolean),
    urls: [c.linkedin_url, c.doximity_url, c.healthgrades_url].filter(Boolean).length,
  };
}

// ─── Dedup: NPI first, then normalized name ────────────────────────────────
function dedup(arrays) {
  const byNpi  = new Map();
  const byName = new Map();
  const order  = [];

  for (const records of arrays) {
    for (const r of records) {
      // NPI dedup
      if (r.npi) {
        if (byNpi.has(r.npi)) {
          const existing = byNpi.get(r.npi);
          // Merge URLs
          existing.linkedin_url     = existing.linkedin_url     || r.linkedin_url;
          existing.doximity_url     = existing.doximity_url     || r.doximity_url;
          existing.healthgrades_url = existing.healthgrades_url || r.healthgrades_url;
          existing.phone            = existing.phone            || r.phone;
          if (!existing.sources) existing.sources = [];
          if (r.source && !existing.sources.includes(r.source)) existing.sources.push(r.source);
          continue;
        }
        r.sources = [r.source].filter(Boolean);
        byNpi.set(r.npi, r);
        byName.set(normName(r.full_name), r);
        order.push(r);
        continue;
      }

      // Name dedup
      const key = normName(r.full_name);
      if (byName.has(key)) {
        const existing = byName.get(key);
        existing.linkedin_url     = existing.linkedin_url     || r.linkedin_url;
        existing.doximity_url     = existing.doximity_url     || r.doximity_url;
        existing.healthgrades_url = existing.healthgrades_url || r.healthgrades_url;
        existing.phone            = existing.phone            || r.phone;
        existing.hospital         = existing.hospital         || r.hospital;
        if (!existing.sources) existing.sources = [];
        if (r.source && !existing.sources.includes(r.source)) existing.sources.push(r.source);
        continue;
      }

      r.sources = [r.source].filter(Boolean);
      byName.set(key, r);
      order.push(r);
    }
  }

  return order;
}

function normName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\b(dr|mr|ms|mrs|prof)\.?\s*/gi, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const wallStart = Date.now();
  console.error(`[Search] Starting parallel search: "${specialty}" in ${location}`);
  console.error('[Search] Firing all 4 scrapers concurrently...');

  // ── Fire all scrapers in parallel ────────────────────────────────────────
  const [npiRaw, linkedinRaw, doximityRaw, healthgradesRaw] = await Promise.all([
    runScript('search-npi.mjs',        ['--specialty', specialty, '--state', state, '--limit', limit]),
    runScript('search-linkedin.mjs',   ['--specialty', specialty, '--location', location]),
    runScript('scrape-doximity.mjs',   ['--specialty', specialty, '--location', location]),
    runScript('scrape-healthgrades.mjs',['--specialty', specialty, '--location', location]),
  ]);

  const elapsed = ((Date.now() - wallStart) / 1000).toFixed(1);
  console.error(`[Search] All scrapers done in ${elapsed}s`);
  console.error(`[Search] Raw counts — NPI:${npiRaw.length} LinkedIn:${linkedinRaw.length} Doximity:${doximityRaw.length} Healthgrades:${healthgradesRaw.length}`);

  // ── Merge + dedup ─────────────────────────────────────────────────────────
  const merged = dedup([npiRaw, linkedinRaw, doximityRaw, healthgradesRaw]);
  console.error(`[Search] After dedup: ${merged.length} unique candidates (was ${npiRaw.length + linkedinRaw.length + doximityRaw.length + healthgradesRaw.length} raw)`);

  // ── Persist to SQLite ─────────────────────────────────────────────────────
  initDb();
  const db = getDb();

  // Check score cache — skip already-scored candidates for same specialty
  const cached = new Set(
    db.prepare(`
      SELECT c.id FROM candidate_scores cs
      JOIN candidates c ON c.id = cs.candidate_id
      JOIN jobs j ON j.id = cs.job_id
      WHERE j.specialty = ? AND cs.scored_at > datetime('now', '-30 days')
    `).all(specialty).map(r => r.id)
  );

  const searchId = insertSearch({
    job_id:             jobId,
    specialty,
    state_code:         state,
    city,
    npi_count:          npiRaw.length,
    linkedin_count:     linkedinRaw.length,
    doximity_count:     doximityRaw.length,
    healthgrades_count: healthgradesRaw.length,
  });

  const idMap = {};
  for (const c of merged) {
    idMap[c.full_name] = upsertCandidate(c);
  }

  const cacheHits = merged.filter(c => cached.has(idMap[c.full_name])).length;
  console.error(`[Search] Saved ${merged.length} candidates to DB (${cacheHits} have cached scores from last 30 days)`);

  // ── Build slim output for Claude ──────────────────────────────────────────
  const slimCandidates = merged.map(c => {
    const dbId = idMap[c.full_name];
    const s    = slim(c, dbId);
    // Flag cached scores so Claude skips re-scoring them
    if (cached.has(dbId)) s.cached = true;
    return s;
  });

  // ── Summary metadata ──────────────────────────────────────────────────────
  const summary = {
    search_id:    searchId,
    job_id:       jobId,
    specialty,
    location,
    total:        merged.length,
    by_source: {
      npi:          npiRaw.length,
      linkedin:     linkedinRaw.length,
      doximity:     doximityRaw.length,
      healthgrades: healthgradesRaw.length,
    },
    deduped_from: npiRaw.length + linkedinRaw.length + doximityRaw.length + healthgradesRaw.length,
    cache_hits:   cacheHits,
    wall_time_s:  parseFloat(elapsed),
    candidates:   slimCandidates,
  };

  console.error(`[Search] Done — emitting slim JSON (${JSON.stringify(slimCandidates).length} bytes vs raw ~${JSON.stringify(merged).length} bytes)`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(err => {
  console.error('[Search] FATAL:', err.message);
  process.exit(1);
});
