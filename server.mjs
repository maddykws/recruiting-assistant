import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync } from 'fs';
import { createRequire } from 'module';

// Load .env with explicit path resolution (works regardless of cwd)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Manually parse .env file since dotenv path can be tricky with ESM
const envPath = join(__dirname, '.env');
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    const value = trimmed.substring(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  }
} else {
  // Try dotenv as fallback
  try {
    const { default: dotenv } = await import('dotenv');
    dotenv.config({ path: join(__dirname, '.env') });
  } catch (_) {}
}

import Anthropic from '@anthropic-ai/sdk';
import { parseJobDescription } from './lib/parse-jd.mjs';
import { searchNpi } from './lib/search-npi.mjs';
import { searchDoximity } from './lib/search-doximity.mjs';
import { searchHealthgrades } from './lib/search-healthgrades.mjs';
import { scoreCandidates } from './lib/score-candidates.mjs';
import { upsertCandidate, getAllCandidates, clearSearch } from './lib/db.mjs';

const app = express();
const PORT = process.env.PORT || 3336;

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(join(__dirname, 'public')));

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

/**
 * POST /api/search — Main SSE endpoint.
 * Accepts { jd: string }, streams results via Server-Sent Events.
 */
app.post('/api/search', async (req, res) => {
  const { jd } = req.body;

  if (!jd || typeof jd !== 'string' || jd.trim().length < 10) {
    return res.status(400).json({ error: 'Please provide a job description (at least 10 characters).' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set. Please add it to your .env file.' });
  }

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  // Helper to send SSE events
  const send = (data) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (_) {}
  };

  const sendStatus = (message, source = null) => {
    send({ type: 'status', message, source });
  };

  const sendCandidate = (candidate) => {
    send({ type: 'candidate', candidate });
  };

  const sendError = (message) => {
    send({ type: 'error', message });
  };

  // Generate a search ID for this session
  const searchId = `search_${Date.now()}`;

  // Clear previous results
  await clearSearch();

  // Track all found candidates
  let allCandidates = [];
  let totalSent = 0;

  try {
    // Step 1: Parse the JD
    sendStatus('Parsing job description with Claude...', 'parse');

    let parsedJd;
    try {
      parsedJd = await parseJobDescription(jd, anthropic);
      sendStatus(`Looking for: ${parsedJd.job_title}${parsedJd.location ? ` in ${parsedJd.location}` : ''} (${parsedJd.specialty})`, 'parse');
    } catch (err) {
      sendError(`Failed to parse job description: ${err.message}`);
      res.end();
      return;
    }

    // Step 2: NPI search (fastest — no scraping)
    sendStatus(`Searching NPI Registry for ${parsedJd.specialty}...`, 'npi');

    let npiCandidates = [];
    try {
      npiCandidates = await searchNpi(parsedJd, (msg) => sendStatus(msg, 'npi'));
      sendStatus(`NPI Registry: ${npiCandidates.length} providers found`, 'npi');
    } catch (err) {
      sendStatus(`NPI Registry error: ${err.message}`, 'npi');
    }

    // Step 3: Run Doximity and Healthgrades in parallel
    sendStatus('Starting Doximity and Healthgrades searches...', null);

    const [doximityCandidates, healthgradesCandidates] = await Promise.allSettled([
      searchDoximity(parsedJd, (msg) => sendStatus(msg, 'doximity')),
      searchHealthgrades(parsedJd, (msg) => sendStatus(msg, 'healthgrades')),
    ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : []));

    sendStatus(`Doximity: ${doximityCandidates.length} profiles found`, 'doximity');
    sendStatus(`Healthgrades: ${healthgradesCandidates.length} providers found`, 'healthgrades');

    // Step 4: Merge and dedup candidates
    allCandidates = [...npiCandidates, ...doximityCandidates, ...healthgradesCandidates];

    // Dedup by NPI (if available) then by normalized name
    const seen = new Map();
    const deduped = [];

    for (const c of allCandidates) {
      const key = c.npi || normalizeName(c.full_name);
      if (!seen.has(key)) {
        seen.set(key, true);
        deduped.push({ ...c, job_title: parsedJd.job_title });
      } else if (c.npi) {
        // Merge URLs from duplicate sources
        const existing = deduped.find(e => e.npi === c.npi);
        if (existing) {
          if (!existing.doximity_url && c.doximity_url) existing.doximity_url = c.doximity_url;
          if (!existing.healthgrades_url && c.healthgrades_url) existing.healthgrades_url = c.healthgrades_url;
          if (!existing.phone && c.phone) existing.phone = c.phone;
        }
      }
    }

    allCandidates = deduped;
    sendStatus(`Total unique candidates: ${allCandidates.length}. Scoring with Claude...`, null);

    // Step 5: Score all candidates
    let scoredCandidates;
    try {
      scoredCandidates = await scoreCandidates(
        parsedJd,
        allCandidates,
        anthropic,
        (msg) => sendStatus(msg, 'scoring')
      );
    } catch (err) {
      sendStatus(`Scoring error: ${err.message}`, 'scoring');
      scoredCandidates = allCandidates.map(c => ({ ...c, score: 5, match_reason: '', outreach_line: '' }));
    }

    // Step 6: Save to DB and stream to client
    sendStatus('Saving results and streaming...', null);

    for (const candidate of scoredCandidates) {
      await upsertCandidate(candidate, searchId);
      sendCandidate(candidate);
      totalSent++;
    }

    send({ type: 'done', total: totalSent, parsed_jd: parsedJd });

  } catch (err) {
    console.error('[Server] Search error:', err);
    sendError(`Search failed: ${err.message}`);
  } finally {
    res.end();
  }
});

/**
 * GET /api/candidates — Return all saved candidates as JSON.
 */
app.get('/api/candidates', async (req, res) => {
  try {
    const candidates = await getAllCandidates();
    res.json({ candidates, total: candidates.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/export/csv — Export candidates as CSV.
 */
app.get('/api/export/csv', async (req, res) => {
  try {
    const candidates = await getAllCandidates();

    const headers = [
      'Name', 'Specialty', 'Credential', 'NPI', 'Practice Phone', 'Email',
      'City', 'State', 'Address', 'Hospital Affiliation',
      'Doximity', 'Healthgrades', 'Rating',
      'Score', 'Match Reason', 'Outreach Line', 'Source', 'Job Title',
    ];

    const rows = candidates.map(c => [
      csvEscape(c.full_name),
      csvEscape(c.specialty),
      csvEscape(c.credential),
      csvEscape(c.npi),
      csvEscape(c.phone),
      csvEscape(c.email),
      csvEscape(c.city),
      csvEscape(c.state),
      csvEscape(c.address),
      csvEscape(c.hospital_affiliation),
      csvEscape(c.doximity_url),
      csvEscape(c.healthgrades_url),
      c.rating != null ? c.rating : '',
      c.score != null ? c.score : '',
      csvEscape(c.match_reason),
      csvEscape(c.outreach_line),
      csvEscape(c.source),
      csvEscape(c.job_title),
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="candidates-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function csvEscape(val) {
  if (val == null || val === '') return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function normalizeName(name) {
  if (!name) return '';
  return name.toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Start server
app.listen(PORT, () => {
  console.log(`\n🏥 Healthcare Recruiting Assistant`);
  console.log(`   Running at: http://localhost:${PORT}`);
  console.log(`   API key:    ${process.env.ANTHROPIC_API_KEY ? '✅ Found' : '❌ Missing — add to .env'}`);
  console.log(`\n   Press Ctrl+C to stop.\n`);
});
