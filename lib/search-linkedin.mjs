#!/usr/bin/env node
/**
 * search-linkedin.mjs — LinkedIn people search for healthcare professionals
 *
 * PRIMARY:  Apify LinkedIn People Search actor (handles auth + proxies)
 * FALLBACK: Google X-Ray (site:linkedin.com/in) via Playwright
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

// ─── PRIMARY: Apify LinkedIn People Search ─────────────────────────────────
async function searchViaApify() {
  // Build LinkedIn people search URL
  const keywords  = encodeURIComponent(`${specialty} ${city} ${state}`);
  const searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${keywords}&origin=GLOBAL_SEARCH_HEADER`;

  console.error(`[LinkedIn] Apify search: ${specialty} in ${location}`);

  const items = await runActor('curious_coder/linkedin-search-scraper', {
    searchUrl,
    count: MAX_RESULTS,
  }, 120);

  // Each item: { name, headline, location, profileUrl, ... }
  console.error(`[LinkedIn] Apify returned ${items.length} profiles`);
  return items;
}

// ─── FALLBACK: Google X-Ray via Playwright ─────────────────────────────────
async function searchViaXRay() {
  console.error('[LinkedIn] Playwright Google X-Ray fallback');

  const query   = `site:linkedin.com/in "${specialty}" "${city}" "${state}"`;
  const urls    = new Set();
  const results = [];

  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
  });
  const page = await ctx.newPage();

  try {
    // Google
    await page.goto(
      `https://www.google.com/search?q=${encodeURIComponent(query)}&num=20`,
      { timeout: PAGE_TIMEOUT }
    );
    await sleep(2000);

    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]')).map(a => a.href)
    );
    for (const l of links) {
      if (l.includes('linkedin.com/in/') && !l.includes('google.com')) {
        const m = l.match(/(https:\/\/www\.linkedin\.com\/in\/[^?&"]+)/);
        if (m) urls.add(m[1]);
      }
      const m2 = l.match(/url\?q=(https:\/\/www\.linkedin\.com\/in\/[^&]+)/);
      if (m2) urls.add(decodeURIComponent(m2[1]));
    }

    console.error(`[LinkedIn] X-Ray found ${urls.size} profile URLs`);

    // Return URL-only results (can't scrape LinkedIn profiles without auth)
    for (const url of [...urls].slice(0, MAX_RESULTS)) {
      // Extract name hint from URL slug (e.g., john-smith-md-12345 → John Smith)
      const slug  = url.split('/in/')[1]?.replace(/[^a-z-]/gi, '') || '';
      const parts = slug.split('-').filter(p => p.length > 1 && isNaN(p));
      const nameHint = parts.slice(0, 3).map(p => p[0].toUpperCase() + p.slice(1)).join(' ');

      results.push({
        source: 'linkedin-xray',
        full_name: nameHint || 'Unknown',
        specialty,
        hospital: '',
        city, state,
        linkedin_url: url,
        note: 'Name extracted from URL — verify on LinkedIn',
      });
    }
  } catch (err) {
    console.error('[LinkedIn] X-Ray failed:', err.message);
  } finally {
    await browser.close();
  }

  return results;
}

// ─── Format Apify results ──────────────────────────────────────────────────
function formatApifyResults(items) {
  return items.slice(0, MAX_RESULTS).map(item => {
    // Apify LinkedIn scraper field names vary by actor version
    const name     = item.name || item.fullName || item.firstName + ' ' + item.lastName || '';
    const headline = item.headline || item.title || '';
    const loc      = item.location || item.geoRegion || '';
    const url      = item.profileUrl || item.url || item.linkedInUrl || '';

    // Parse city/state from location string like "New York, New York, United States"
    let pCity = city, pState = state;
    if (loc) {
      const parts = loc.split(',').map(s => s.trim());
      if (parts.length >= 1) pCity = parts[0];
    }

    // Extract hospital/employer from headline or current position
    const hospital = item.currentCompany || item.company ||
      (headline.includes(' at ') ? headline.split(' at ').pop().trim() : '') || '';

    return {
      source: 'linkedin',
      full_name: name.trim(),
      specialty: item.specialty || specialty,
      hospital,
      headline,
      city: pCity, state: pState,
      linkedin_url: url,
      note: '',
    };
  }).filter(r => r.full_name);
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.error(`[LinkedIn] Searching for ${specialty} in ${location}`);

  let results = [];

  if (hasToken()) {
    try {
      const items = await searchViaApify();
      results = formatApifyResults(items);
    } catch (err) {
      console.error(`[LinkedIn] Apify failed (${err.message}), using X-Ray fallback`);
    }
  } else {
    console.error('[LinkedIn] No Apify token — using X-Ray fallback');
  }

  if (results.length === 0) {
    results = await searchViaXRay();
  }

  console.error(`[LinkedIn] Done — ${results.length} profiles`);
  console.log(JSON.stringify(results, null, 2));
}

main().catch(err => {
  console.error('[LinkedIn] FATAL:', err.message);
  console.log('[]');
  process.exit(1);
});
