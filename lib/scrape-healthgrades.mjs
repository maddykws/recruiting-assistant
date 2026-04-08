#!/usr/bin/env node
/**
 * scrape-healthgrades.mjs — Healthgrades public directory scraper
 *
 * PRIMARY:  Apify Google Search Scraper → finds site:healthgrades.com/physician URLs
 *           then Playwright scrapes each profile page
 * FALLBACK: Playwright Google / DuckDuckGo X-Ray for URL discovery
 *
 * Usage:
 *   node lib/scrape-healthgrades.mjs --specialty "Radiology" --location "New York, NY"
 */

import { chromium } from 'playwright';
import { runActor, hasToken } from './apify.mjs';

const MAX_RESULTS  = 15;
const PAGE_TIMEOUT = 15000;
const NAV_DELAY    = 1200;

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
  console.error('[Healthgrades] ERROR: --specialty and --location are required');
  process.exit(1);
}

const [city, stateRaw] = location.split(',').map(s => s.trim());
const state = stateRaw || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── PRIMARY: Apify Google Search → Healthgrades doctor URLs ──────────────
async function searchViaApify() {
  const query = `site:healthgrades.com/physician "${specialty}" "${city}"`;
  console.error(`[Healthgrades] Apify Google search: ${query}`);

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
      if (r.url?.includes('healthgrades.com/physician/')) urls.push(r.url.split('?')[0]);
    }
  }
  console.error(`[Healthgrades] Apify found ${urls.length} Healthgrades URLs`);
  return [...new Set(urls)];
}

// ─── FALLBACK: Playwright Google / DuckDuckGo X-Ray ──────────────────────
async function searchViaPlaywright(page) {
  const query = `site:healthgrades.com/physician "${specialty}" "${city}"`;
  const urls  = new Set();

  const extractUrls = async () => {
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]')).map(a => a.href)
    );
    for (const l of links) {
      if (l.includes('healthgrades.com/physician/') && !l.includes('google.com')) urls.add(l.split('?')[0]);
      const m = l.match(/url\?q=(https:\/\/www\.healthgrades\.com\/physician\/[^&]+)/);
      if (m) urls.add(decodeURIComponent(m[1]).split('?')[0]);
    }
  };

  // Google
  try {
    console.error('[Healthgrades] Playwright fallback: Google');
    await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}&num=20`, { timeout: PAGE_TIMEOUT });
    await sleep(2000);
    await extractUrls();
  } catch (e) { console.error('[Healthgrades] Google failed:', e.message); }

  // DuckDuckGo if Google returned nothing
  if (urls.size === 0) {
    try {
      console.error('[Healthgrades] Playwright fallback: DuckDuckGo');
      await page.goto(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&ia=web`, { timeout: PAGE_TIMEOUT });
      await sleep(3000);
      await extractUrls();
    } catch (e) { console.error('[Healthgrades] DDG failed:', e.message); }
  }

  console.error(`[Healthgrades] Playwright found ${urls.size} URLs`);
  return [...urls];
}

// ─── Scrape individual Healthgrades doctor profile ────────────────────────
async function scrapeProfile(page, url) {
  try {
    await page.goto(url, { timeout: PAGE_TIMEOUT, waitUntil: 'domcontentloaded' });
    await sleep(NAV_DELAY);

    const data = await page.evaluate(() => {
      const text = s => document.querySelector(s)?.innerText?.trim() || '';
      const meta = name => document.querySelector(`meta[name="${name}"], meta[property="${name}"]`)?.getAttribute('content') || '';

      // Try JSON-LD first (best source for structured data)
      let jsonld = {};
      try {
        const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
        for (const s of scripts) {
          const obj = JSON.parse(s.textContent);
          if (obj['@type'] === 'Physician' || obj['@type'] === 'MedicalBusiness' || obj.name) {
            jsonld = obj; break;
          }
        }
      } catch {}

      const name =
        jsonld.name ||
        text('h1[class*="name"], h1[itemprop="name"], [data-qa*="name"]') ||
        text('h1') ||
        meta('og:title')?.replace(/\s*[-|].*$/, '').trim() || '';

      const specialty =
        jsonld.medicalSpecialty ||
        text('[class*="specialty"], [itemprop="medicalSpecialty"]') || '';

      const hospital =
        jsonld.worksFor?.name || jsonld.hospital ||
        text('[class*="hospital"], [class*="affiliation"], [class*="practice"]') || '';

      const address = jsonld.address
        ? `${jsonld.address.streetAddress || ''}, ${jsonld.address.addressLocality || ''}, ${jsonld.address.addressRegion || ''}`.replace(/^,\s*/, '')
        : text('[class*="address"], address, [itemprop="address"]');

      const phoneEl = document.querySelector('a[href^="tel:"]');
      const phone   = jsonld.telephone || (phoneEl ? phoneEl.href.replace('tel:', '') : text('[class*="phone"]'));

      const ratingEl  = document.querySelector('[class*="rating"], [itemprop="ratingValue"]');
      const ratingTxt = ratingEl?.getAttribute('content') || ratingEl?.innerText || '';
      const rating    = parseFloat((ratingTxt.match(/(\d+\.?\d*)/) || [])[1]) || null;

      return { name, specialty, hospital, address, phone, rating };
    });

    let fullName = data.name;
    if (!fullName) {
      const title = await page.title();
      fullName = title.replace(/\s*[-|].*$/, '').trim();
    }
    if (!fullName) return null;

    // Parse city/state from address
    let pCity = city, pState = state;
    if (data.address) {
      const m = data.address.match(/([A-Za-z\s]+),\s*([A-Z]{2})/);
      if (m) { pCity = m[1].trim(); pState = m[2]; }
    }

    return {
      source: 'healthgrades',
      full_name: fullName,
      specialty: data.specialty || specialty,
      hospital: data.hospital || '',
      city: pCity, state: pState,
      address: data.address || '',
      phone: data.phone || '',
      rating: data.rating || null,
      healthgrades_url: url,
    };
  } catch (err) {
    console.error(`[Healthgrades] Profile scrape failed ${url}: ${err.message}`);
    return null;
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.error(`[Healthgrades] Searching for ${specialty} in ${location}`);

  let profileUrls = [];

  if (hasToken()) {
    try {
      profileUrls = await searchViaApify();
    } catch (err) {
      console.error(`[Healthgrades] Apify failed (${err.message}), falling back to Playwright`);
    }
  } else {
    console.error('[Healthgrades] No Apify token — using Playwright fallback');
  }

  // Launch Playwright (needed for profile scraping + fallback search)
  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
  });
  const page = await ctx.newPage();

  try {
    if (profileUrls.length === 0) {
      profileUrls = await searchViaPlaywright(page);
    }

    profileUrls = [...new Set(profileUrls)].slice(0, MAX_RESULTS);
    console.error(`[Healthgrades] Scraping ${profileUrls.length} profiles...`);

    const results = [];
    for (let i = 0; i < profileUrls.length; i++) {
      console.error(`[Healthgrades] Profile ${i + 1}/${profileUrls.length}`);
      await sleep(NAV_DELAY);
      const p = await scrapeProfile(page, profileUrls[i]);
      if (p) { results.push(p); console.error(`  → ${p.full_name}`); }
    }

    console.error(`[Healthgrades] Done — ${results.length} providers`);
    console.log(JSON.stringify(results, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('[Healthgrades] FATAL:', err.message);
  console.log('[]');
  process.exit(1);
});
