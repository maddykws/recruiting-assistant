#!/usr/bin/env node
/**
 * search-linkedin.mjs — LinkedIn people search for healthcare professionals
 *
 * PRIMARY:  Apify Google Search Scraper → site:linkedin.com/in X-Ray
 * FALLBACK: Playwright Google X-Ray
 *
 * Usage:
 *   node lib/search-linkedin.mjs --specialty "Radiology" --location "New York, NY"
 */

import { chromium } from 'playwright';
import { runActor, hasToken } from './apify.mjs';

const MAX_RESULTS  = 20;
const PAGE_TIMEOUT = 15000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── CLI args ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
      a[k] = v;
      if (v !== true) i++;
    }
  }
  return a;
}
const args      = parseArgs(process.argv.slice(2));
const specialty = args.specialty;
const location  = args.location;

if (!specialty || !location) {
  console.error('[LinkedIn] ERROR: --specialty and --location are required');
  process.exit(1);
}

const [city, stateRaw] = location.split(',').map(s => s.trim());
const state = stateRaw || '';

// ─── Extract name hint from LinkedIn URL slug ──────────────────────────────
function nameFromSlug(url) {
  const slug  = url.split('/in/')[1]?.split('?')[0]?.replace(/[^a-z-]/gi, '') || '';
  const parts = slug.split('-').filter(p => p.length > 1 && isNaN(p));
  return parts.slice(0, 3).map(p => p[0].toUpperCase() + p.slice(1)).join(' ');
}

// ─── Parse LinkedIn URLs from raw link list ────────────────────────────────
function extractLinkedInUrls(links) {
  const urls = new Set();
  for (const l of links) {
    const m1 = l.match(/(https?:\/\/(?:www\.)?linkedin\.com\/in\/[^?&"#\s]+)/);
    if (m1 && !l.includes('google.com')) urls.add(m1[1].replace(/\/$/, ''));
    const m2 = l.match(/url\?q=(https?:\/\/(?:www\.)?linkedin\.com\/in\/[^&]+)/);
    if (m2) urls.add(decodeURIComponent(m2[1]).replace(/\/$/, ''));
  }
  return [...urls];
}

// ─── PRIMARY: Apify Google Search → LinkedIn URLs ─────────────────────────
async function searchViaApify() {
  const query = `site:linkedin.com/in "${specialty}" "${city}" "${state}"`;
  console.error(`[LinkedIn] Apify Google X-Ray: ${query}`);

  const items = await runActor('apify/google-search-scraper', {
    queries: query,
    resultsPerPage: 20,
    maxPagesPerQuery: 1,
    languageCode: 'en',
    countryCode: 'us',
  }, 90);

  const urls = [];
  for (const item of items) {
    for (const r of (item.organicResults || [])) {
      if (r.url?.includes('linkedin.com/in/')) urls.push(r.url);
    }
  }
  console.error(`[LinkedIn] Apify found ${urls.length} LinkedIn URLs`);
  return [...new Set(urls)];
}

// ─── FALLBACK: Playwright Google X-Ray ────────────────────────────────────
async function searchViaPlaywright() {
  console.error('[LinkedIn] Playwright Google X-Ray fallback');
  const query = `site:linkedin.com/in "${specialty}" "${city}" "${state}"`;
  const urls  = new Set();

  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
  });
  const page = await ctx.newPage();

  try {
    // Try Google
    try {
      await page.goto(
        `https://www.google.com/search?q=${encodeURIComponent(query)}&num=20`,
        { timeout: PAGE_TIMEOUT }
      );
      await sleep(2000);
      const links = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href]')).map(a => a.href)
      );
      for (const u of extractLinkedInUrls(links)) urls.add(u);
    } catch (e) { console.error('[LinkedIn] Google failed:', e.message); }

    // DuckDuckGo if Google empty
    if (urls.size === 0) {
      try {
        await page.goto(
          `https://duckduckgo.com/?q=${encodeURIComponent(query)}&ia=web`,
          { timeout: PAGE_TIMEOUT }
        );
        await sleep(3000);
        const links = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a[href]')).map(a => a.href)
        );
        for (const u of extractLinkedInUrls(links)) urls.add(u);
      } catch (e) { console.error('[LinkedIn] DDG failed:', e.message); }
    }
  } finally {
    await browser.close();
  }

  console.error(`[LinkedIn] Playwright found ${urls.size} LinkedIn URLs`);
  return [...urls];
}

// ─── Convert URLs to result objects ───────────────────────────────────────
function urlsToResults(urls) {
  return urls.slice(0, MAX_RESULTS).map(url => ({
    source: 'linkedin',
    full_name: nameFromSlug(url) || 'Unknown',
    specialty,
    hospital: '',
    city, state,
    linkedin_url: url,
    note: 'Name extracted from URL slug — verify on LinkedIn',
  })).filter(r => r.full_name && r.full_name !== 'Unknown');
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.error(`[LinkedIn] Searching for ${specialty} in ${location}`);

  let urls = [];

  if (hasToken()) {
    try {
      urls = await searchViaApify();
    } catch (err) {
      console.error(`[LinkedIn] Apify failed (${err.message}), using Playwright fallback`);
    }
  } else {
    console.error('[LinkedIn] No Apify token — using Playwright fallback');
  }

  if (urls.length === 0) {
    urls = await searchViaPlaywright();
  }

  const results = urlsToResults(urls);
  console.error(`[LinkedIn] Done — ${results.length} profiles`);
  console.log(JSON.stringify(results, null, 2));
}

main().catch(err => {
  console.error('[LinkedIn] FATAL:', err.message);
  console.log('[]');
  process.exit(1);
});
