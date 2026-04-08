#!/usr/bin/env node
/**
 * scrape-doximity.mjs — Doximity public profile scraper
 *
 * PRIMARY:  Apify Google Search Scraper → finds site:doximity.com/pub URLs
 *           then Playwright scrapes each profile page
 * FALLBACK: Playwright-only Google / DuckDuckGo X-Ray (if Apify unavailable)
 *
 * Usage:
 *   node lib/scrape-doximity.mjs --specialty "Radiology" --location "New York, NY"
 */

import { chromium } from 'playwright';
import { runActor, hasToken } from './apify.mjs';

const MAX_RESULTS   = 15;
const PAGE_TIMEOUT  = 15000;
const NAV_DELAY     = 1500;

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
  console.error('[Doximity] ERROR: --specialty and --location are required');
  process.exit(1);
}

const [city, stateRaw] = location.split(',').map(s => s.trim());
const state = stateRaw || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Profile scraper (Playwright) ─────────────────────────────────────────
async function scrapeProfile(page, url) {
  try {
    await page.goto(url, { timeout: PAGE_TIMEOUT, waitUntil: 'domcontentloaded' });
    await sleep(800);

    const data = await page.evaluate(() => {
      const text = s => document.querySelector(s)?.innerText?.trim() || '';
      const attr = (s, a) => document.querySelector(s)?.getAttribute(a) || '';

      const name =
        text('h1') ||
        text('[class*="name"]') ||
        text('[data-qa="profile-name"]');

      const specialty =
        text('[class*="specialty"]') ||
        text('[data-qa="specialty"]') ||
        text('[class*="Specialty"]');

      const hospital =
        text('[class*="hospital"]') ||
        text('[class*="affiliation"]') ||
        text('[class*="practice"]') ||
        text('[data-qa="affiliation"]');

      const loc =
        text('[class*="location"]') ||
        text('[class*="city"]') ||
        text('[data-qa="location"]');

      const desc = attr('meta[name="description"]', 'content');

      return { name, specialty, hospital, location: loc, desc };
    });

    // Fallback name from title
    let fullName = data.name;
    if (!fullName) {
      const title = await page.title();
      fullName = title.replace(/\s*[-|].*$/, '').trim();
    }
    if (!fullName) return null;

    // Parse city/state from location string
    let pCity = city, pState = state;
    if (data.location) {
      const parts = data.location.split(',').map(s => s.trim());
      if (parts.length >= 2) { pCity = parts[0]; pState = parts[1].split(' ')[0]; }
    }

    return {
      source: 'doximity',
      full_name: fullName,
      specialty: data.specialty || specialty,
      hospital: data.hospital || '',
      city: pCity,
      state: pState,
      doximity_url: url,
    };
  } catch (err) {
    console.error(`[Doximity] Profile scrape failed ${url}: ${err.message}`);
    return null;
  }
}

// ─── PRIMARY: Apify Google Search → Doximity URLs ─────────────────────────
async function searchViaApify() {
  const query = `site:doximity.com/pub "${specialty}" "${city}" "${state}"`;
  console.error(`[Doximity] Apify Google search: ${query}`);

  const items = await runActor('apify/google-search-scraper', {
    queries: query,
    resultsPerPage: 20,
    maxPagesPerQuery: 1,
    languageCode: 'en',
    countryCode: 'us',
  }, 90);

  // Each item has organicResults[] with .url
  const urls = [];
  for (const item of items) {
    for (const r of (item.organicResults || [])) {
      if (r.url?.includes('doximity.com/pub/')) urls.push(r.url);
    }
  }
  console.error(`[Doximity] Apify found ${urls.length} Doximity URLs`);
  return [...new Set(urls)];
}

// ─── FALLBACK: Playwright Google / DuckDuckGo X-Ray ───────────────────────
async function searchViaPlaywright(page) {
  const query = `site:doximity.com/pub "${specialty}" "${city}" "${state}"`;
  const urls  = new Set();

  const extractUrls = async () => {
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]')).map(a => a.href)
    );
    for (const l of links) {
      if (l.includes('doximity.com/pub/') && !l.includes('?')) urls.add(l);
      const m = l.match(/url\?q=(https:\/\/www\.doximity\.com\/pub\/[^&]+)/);
      if (m) urls.add(decodeURIComponent(m[1]));
    }
  };

  // Google
  try {
    console.error('[Doximity] Playwright fallback: Google');
    await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}&num=20`, { timeout: PAGE_TIMEOUT });
    await sleep(2000);
    await extractUrls();
  } catch (e) { console.error('[Doximity] Google failed:', e.message); }

  // DuckDuckGo if Google returned nothing
  if (urls.size === 0) {
    try {
      console.error('[Doximity] Playwright fallback: DuckDuckGo');
      await page.goto(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&ia=web`, { timeout: PAGE_TIMEOUT });
      await sleep(3000);
      await extractUrls();
    } catch (e) { console.error('[Doximity] DDG failed:', e.message); }
  }

  console.error(`[Doximity] Playwright found ${urls.size} URLs`);
  return [...urls];
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.error(`[Doximity] Searching for ${specialty} in ${location}`);

  let profileUrls = [];

  // Try Apify first
  if (hasToken()) {
    try {
      profileUrls = await searchViaApify();
    } catch (err) {
      console.error(`[Doximity] Apify failed (${err.message}), falling back to Playwright`);
    }
  } else {
    console.error('[Doximity] No Apify token — using Playwright fallback');
  }

  // Launch Playwright (needed for profile scraping regardless + fallback search)
  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
  });
  const page = await ctx.newPage();

  try {
    // Playwright fallback for URL discovery
    if (profileUrls.length === 0) {
      profileUrls = await searchViaPlaywright(page);
    }

    profileUrls = [...new Set(profileUrls)].slice(0, MAX_RESULTS);
    console.error(`[Doximity] Scraping ${profileUrls.length} profiles...`);

    const results = [];
    for (let i = 0; i < profileUrls.length; i++) {
      console.error(`[Doximity] Profile ${i + 1}/${profileUrls.length}`);
      await sleep(NAV_DELAY);
      const p = await scrapeProfile(page, profileUrls[i]);
      if (p) { results.push(p); console.error(`  → ${p.full_name}`); }
    }

    console.error(`[Doximity] Done — ${results.length} profiles`);
    console.log(JSON.stringify(results, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('[Doximity] FATAL:', err.message);
  console.log('[]');
  process.exit(1);
});
