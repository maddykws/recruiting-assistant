/**
 * apify.mjs — Shared Apify API helper
 * Runs actors synchronously and returns dataset items.
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Load .env from project root
const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dir, '..', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (k && !process.env[k]) process.env[k] = v;
  }
}

const TOKEN = process.env.APIFY_TOKEN;

/**
 * Run an Apify actor and return its dataset items.
 * @param {string} actorId  e.g. 'apify/google-search-scraper'
 * @param {object} input    Actor input JSON
 * @param {number} timeout  Seconds to wait (default 120)
 */
export async function runActor(actorId, input, timeout = 120) {
  if (!TOKEN) throw new Error('APIFY_TOKEN not set in .env');

  // Actor IDs use ~ in URL path (apify/foo → apify~foo)
  const slug = actorId.replace('/', '~');
  const url = `https://api.apify.com/v2/acts/${slug}/run-sync-get-dataset-items?token=${TOKEN}&timeout=${timeout}`;

  console.error(`[Apify] Running ${actorId}...`);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout((timeout + 10) * 1000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Apify ${actorId} HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const items = await res.json();
  console.error(`[Apify] ${actorId} returned ${Array.isArray(items) ? items.length : 0} items`);
  return Array.isArray(items) ? items : [];
}

export const hasToken = () => !!TOKEN;
