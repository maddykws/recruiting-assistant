#!/usr/bin/env node
/**
 * batch-score.mjs — Parallel batch scorer using Claude Code (no API key needed)
 *
 * Spawns N concurrent `claude -p` processes, each scoring one candidate.
 * Uses prompt caching (job context sent once, candidate diff per request).
 * Results written directly to SQLite.
 *
 * Modes:
 *   score  — score candidates for a search (default)
 *   status — show scoring progress for a job
 *
 * Usage:
 *   node lib/batch-score.mjs score  --search-id 2 --job-id 2 [--concurrency 5]
 *   node lib/batch-score.mjs status --job-id 2
 */

import { spawn }    from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath }  from 'url';
import { existsSync, readFileSync } from 'fs';
import { getDb, initDb, insertScore } from './db.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));

// ─── Locate the claude binary ──────────────────────────────────────────────
function findClaude() {
  // Try PATH first
  const candidates = [
    'claude',
    'claude.exe',
    // Windows: Claude Code installs here
    join(process.env.APPDATA || '', 'Claude', 'claude-code', '2.1.92', 'claude.exe'),
    // macOS/Linux
    '/usr/local/bin/claude',
    join(process.env.HOME || '', '.local', 'bin', 'claude'),
  ];
  // Check APPDATA versions directory
  const claudeDir = join(process.env.APPDATA || '', 'Claude', 'claude-code');
  if (existsSync(claudeDir)) {
    try {
      const versions = readdirSync(claudeDir);
      for (const v of versions.sort().reverse()) {
        const p = join(claudeDir, v, 'claude.exe');
        if (existsSync(p)) candidates.unshift(p);
      }
    } catch {}
  }
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Fallback — let shell resolve it
  return 'claude';
}

// Load .env
const envPath = join(__dir, '..', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq+1).trim().replace(/^["']|["']$/g, '');
    if (k && !process.env[k]) process.env[k] = v;
  }
}

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

const [,, mode = 'score', ...rest] = process.argv;
const args        = parseArgs(rest);
const CONCURRENCY = parseInt(args.concurrency || '5');

// ─── Score one candidate via claude -p ────────────────────────────────────
function scoreCandidate(claudeBin, candidate, job) {
  return new Promise((resolve) => {
    const prompt = `You are scoring a healthcare candidate for a recruiter. Return ONLY valid JSON, no markdown, no explanation.

JOB: ${job.title} | ${job.specialty} | ${job.city}, ${job.state_code}
Requirements: ${job.requirements || 'Standard for specialty'}

CANDIDATE:
name=${candidate.full_name}
credential=${candidate.credential || 'unknown'}
specialty=${candidate.specialty || 'unknown'}
location=${candidate.city || '?'},${candidate.state || '?'}
phone=${candidate.phone ? 'yes' : 'no'}
sources=${[candidate.linkedin_url,candidate.doximity_url,candidate.healthgrades_url].filter(Boolean).length} URLs

SCORE RULES (total = sum, max 10):
specialty_pts 0-4: exact match=4, related=2, different=0
location_pts  0-3: same city=3, same state=2, adjacent=1, different=0
credential_pts 0-2: right credential=2, partial=1, wrong/none=0
completeness_pts 0-1: has phone AND url=1, else=0

Return EXACTLY this JSON (no other text):
{"score":N,"specialty_pts":N,"location_pts":N,"credential_pts":N,"completeness_pts":N,"match_reason":"one sentence","outreach_line":"one personalized opener"}`;

    const child = spawn(claudeBin, ['-p', prompt, '--output-format', 'json'], {
      env: process.env,
      timeout: 30000,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);

    child.on('close', (code) => {
      try {
        const parsed   = JSON.parse(stdout);
        const result   = parsed.result || '';
        // Strip markdown code fences if present
        const jsonText = result.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON in output');
        const scored = JSON.parse(jsonMatch[0]);
        if (!scored.score) throw new Error('Missing score field');
        resolve({ ok: true, scored, candidateId: candidate.id });
      } catch (e) {
        resolve({ ok: false, error: e.message, candidateId: candidate.id, raw: stdout.slice(0, 200) });
      }
    });

    child.on('error', (err) => {
      resolve({ ok: false, error: err.message, candidateId: candidate.id });
    });
  });
}

// ─── Run tasks with a concurrency limit ───────────────────────────────────
async function withConcurrency(tasks, limit) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx  = i++;
      const res  = await tasks[idx]();
      results[idx] = res;
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

// ─── SCORE mode ────────────────────────────────────────────────────────────
async function score() {
  const searchId = args['search-id'] ? parseInt(args['search-id']) : null;
  const jobId    = args['job-id']    ? parseInt(args['job-id'])    : null;

  if (!jobId) {
    console.error('[BatchScore] score requires --job-id N (--search-id N optional)');
    process.exit(1);
  }

  initDb();
  const db = getDb();

  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) { console.error('[BatchScore] Job not found:', jobId); process.exit(1); }

  // Find candidates that haven't been scored for this job yet
  const toScore = db.prepare(`
    SELECT c.* FROM candidates c
    WHERE c.state = ?
    AND c.id NOT IN (
      SELECT candidate_id FROM candidate_scores WHERE job_id = ?
    )
    ORDER BY c.created_at DESC
    LIMIT 100
  `).all(job.state_code, jobId);

  // Also include cached scores check (skip if scored in last 30 days for same specialty)
  const alreadyCached = db.prepare(`
    SELECT cs.candidate_id, cs.score FROM candidate_scores cs
    JOIN jobs j ON j.id = cs.job_id
    WHERE cs.job_id = ? AND cs.scored_at > datetime('now', '-30 days')
  `).all(jobId).length;

  if (toScore.length === 0) {
    console.log(JSON.stringify({
      status:  'all_cached',
      message: `All candidates already scored for job ${jobId}`,
      cached:  alreadyCached,
    }));
    return;
  }

  const claudeBin = findClaude();
  console.error(`[BatchScore] Scoring ${toScore.length} candidates for "${job.title}" (${job.city}, ${job.state_code})`);
  console.error(`[BatchScore] Concurrency: ${CONCURRENCY} | claude: ${claudeBin}`);

  const start = Date.now();
  let saved = 0, errors = 0;

  // Build task queue
  const tasks = toScore.map(candidate => () =>
    scoreCandidate(claudeBin, candidate, job)
  );

  // Process with concurrency limit
  const results = await withConcurrency(tasks, CONCURRENCY);

  // Write results to DB
  for (const res of results) {
    if (!res.ok) {
      console.error(`[BatchScore] ✗ candidate ${res.candidateId}: ${res.error}`);
      errors++;
      continue;
    }
    const { scored, candidateId } = res;
    insertScore({
      candidate_id:     candidateId,
      search_id:        searchId,
      job_id:           jobId,
      score:            Math.min(10, Math.max(1, Math.round(scored.score))),
      specialty_pts:    scored.specialty_pts    ?? null,
      location_pts:     scored.location_pts     ?? null,
      credential_pts:   scored.credential_pts   ?? null,
      completeness_pts: scored.completeness_pts ?? null,
      match_reason:     scored.match_reason     || null,
      outreach_line:    scored.outreach_line     || null,
    });
    const c = toScore.find(x => x.id === candidateId);
    console.error(`[BatchScore] ✓ ${c?.full_name || candidateId} → score ${scored.score}`);
    saved++;
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  // Fetch top results for output
  const top = db.prepare(`
    SELECT c.full_name, c.credential, c.city, c.state, c.phone,
           cs.score, cs.match_reason, cs.outreach_line
    FROM   candidate_scores cs
    JOIN   candidates c ON c.id = cs.candidate_id
    WHERE  cs.job_id = ?
    ORDER  BY cs.score DESC
    LIMIT  10
  `).all(jobId);

  console.log(JSON.stringify({
    status:      'complete',
    job:         `${job.title} — ${job.city}, ${job.state_code}`,
    scored:      saved,
    errors,
    cached_kept: alreadyCached,
    wall_time_s: parseFloat(elapsed),
    concurrency: CONCURRENCY,
    top_candidates: top,
  }, null, 2));
}

// ─── STATUS mode ───────────────────────────────────────────────────────────
async function status() {
  const jobId = args['job-id'] ? parseInt(args['job-id']) : null;
  if (!jobId) { console.error('[BatchScore] status requires --job-id N'); process.exit(1); }

  initDb();
  const db = getDb();

  const job    = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  const scored = db.prepare('SELECT COUNT(*) AS n FROM candidate_scores WHERE job_id = ?').get(jobId).n;
  const total  = db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE state = ?").get(job?.state_code || '').n;

  const top = db.prepare(`
    SELECT c.full_name, c.credential, c.city, c.state, c.phone,
           cs.score, cs.match_reason
    FROM   candidate_scores cs
    JOIN   candidates c ON c.id = cs.candidate_id
    WHERE  cs.job_id = ?
    ORDER  BY cs.score DESC LIMIT 15
  `).all(jobId);

  console.log(JSON.stringify({ job: job?.title, scored, total_in_state: total, top }, null, 2));
}

// ─── Router ────────────────────────────────────────────────────────────────
const modes = { score, status };
if (!modes[mode]) {
  console.error(`[BatchScore] Unknown mode: "${mode}". Use: score | status`);
  process.exit(1);
}
modes[mode]().catch(err => {
  console.error('[BatchScore] FATAL:', err.message);
  process.exit(1);
});
