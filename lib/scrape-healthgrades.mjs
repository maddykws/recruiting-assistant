#!/usr/bin/env node
/**
 * scrape-healthgrades.mjs — Healthgrades public directory scraper
 *
 * PRIMARY:  Apify Web Scraper actor (handles JS-rendered pages + proxies)
 * FALLBACK: Playwright headless browser
 *
 * Usage:
 *   node lib/scrape-healthgrades.mjs --specialty "Radiology" --location "New York, NY"
 */

import { chromium } from 'playwright';
import { runActor, hasToken } from './apify.mjs';

const MAX_RESULTS  = 20;
const PAGE_TIMEOUT = 20000;
const NAV_DELAY    = 2000;

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

const buildUrl = () =>
  `https://www.healthgrades.com/find-a-doctor/results?what=${encodeURIComponent(specialty)}&where=${encodeURIComponent(location)}`;

// ─── Parse doctor cards (shared between Apify page fn and Playwright) ──────
// This is injected as a string into Apify's pageFunction
const PAGE_FN = `
async function pageFunction({ page, request }) {
  await page.waitForTimeout(2000);

  const selectors = [
    '[data-testid="provider-card"]',
    '[class*="ProviderCard"]',
    '[class*="provider-card"]',
    '[class*="DoctorCard"]',
    'article',
  ];

  let cards = [];
  for (const sel of selectors) {
    cards = Array.from(document.querySelectorAll(sel));
    if (cards.length > 0) break;
  }

  return cards.slice(0, 20).map(card => {
    const t  = s => card.querySelector(s)?.innerText?.trim() || '';
    const hr = card.querySelector('a[href*="/physician/"], a[href*="/doctor/"], a[href]');

    const phoneEl = card.querySelector('a[href^="tel:"]');
    const phone   = phoneEl ? phoneEl.href.replace('tel:', '') : t('[class*="phone"]');

    const ratingEl  = card.querySelector('[aria-label*="star"], [class*="rating"]');
    const ratingTxt = ratingEl?.getAttribute('aria-label') || ratingEl?.innerText || '';
    const ratingNum = parseFloat((ratingTxt.match(/(\\d+\\.?\\d*)/) || [])[1]) || null;

    return {
      name:            t('h2, h3, [class*="name"]'),
      specialty:       t('[class*="specialty"]'),
      hospital:        t('[class*="hospital"], [class*="practice"], [class*="affiliation"]'),
      address:         t('[class*="address"], address'),
      phone,
      rating:          ratingNum,
      healthgrades_url: hr?.href || '',
    };
  }).filter(d => d.name);
}
`;

// ─── PRIMARY: Apify Playwright Scraper ────────────────────────────────────
async function scrapeViaApify() {
  console.error(`[Healthgrades] Apify Playwright Scraper: ${buildUrl()}`);

  const items = await runActor('apify/playwright-scraper', {
    startUrls: [{ url: buildUrl() }],
    pageFunction: PAGE_FN,
    maxRequestsPerCrawl: 1,
    launchContext: {
      launchOptions: { headless: true },
    },
  }, 120);

  // items is flat array of doctor objects (pageFunction returns array, Apify flattens)
  const doctors = items.filter(d => d?.name);
  console.error(`[Healthgrades] Apify returned ${doctors.length} doctor cards`);
  return doctors;
}

// ─── FALLBACK: Playwright ─────────────────────────────────────────────────
async function scrapeViaPlaywright() {
  console.error('[Healthgrades] Playwright fallback...');
  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
  });
  const page = await ctx.newPage();

  try {
    await page.goto(buildUrl(), { timeout: PAGE_TIMEOUT, waitUntil: 'domcontentloaded' });
    await sleep(NAV_DELAY);

    try {
      await page.waitForSelector('[class*="result"], [class*="doctor"], article', { timeout: 8000 });
    } catch { /* parse anyway */ }

    const doctors = await page.evaluate(() => {
      const selectors = [
        '[data-testid="provider-card"]',
        '[class*="ProviderCard"]',
        '[class*="provider-card"]',
        'article',
      ];
      let cards = [];
      for (const sel of selectors) {
        cards = Array.from(document.querySelectorAll(sel));
        if (cards.length) break;
      }
      return cards.slice(0, 20).map(card => {
        const t  = s => card.querySelector(s)?.innerText?.trim() || '';
        const hr = card.querySelector('a[href*="/physician/"], a[href*="/doctor/"], a[href]');
        const phoneEl = card.querySelector('a[href^="tel:"]');
        const phone   = phoneEl ? phoneEl.href.replace('tel:', '') : t('[class*="phone"]');
        const ratingEl  = card.querySelector('[aria-label*="star"], [class*="rating"]');
        const ratingTxt = ratingEl?.getAttribute('aria-label') || ratingEl?.innerText || '';
        const ratingNum = parseFloat((ratingTxt.match(/(\d+\.?\d*)/) || [])[1]) || null;
        return {
          name:            t('h2, h3, [class*="name"]'),
          specialty:       t('[class*="specialty"]'),
          hospital:        t('[class*="hospital"], [class*="practice"]'),
          address:         t('[class*="address"], address'),
          phone, rating: ratingNum,
          healthgrades_url: hr?.href || '',
        };
      }).filter(d => d.name);
    });

    console.error(`[Healthgrades] Playwright found ${doctors.length} cards`);
    return doctors;
  } finally {
    await browser.close();
  }
}

// ─── Format results ────────────────────────────────────────────────────────
function formatDoctors(doctors) {
  return doctors.slice(0, MAX_RESULTS).map(doc => {
    let pCity = city, pState = state;
    if (doc.address) {
      const m = doc.address.match(/([A-Za-z\s]+),\s*([A-Z]{2})/);
      if (m) { pCity = m[1].trim(); pState = m[2]; }
    }
    return {
      source: 'healthgrades',
      full_name: doc.name,
      specialty: doc.specialty || specialty,
      hospital: doc.hospital || '',
      city: pCity, state: pState,
      address: doc.address || '',
      phone: doc.phone || '',
      rating: doc.rating || null,
      healthgrades_url: doc.healthgrades_url || '',
    };
  });
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.error(`[Healthgrades] Searching for ${specialty} in ${location}`);

  let doctors = [];

  if (hasToken()) {
    try {
      doctors = await scrapeViaApify();
    } catch (err) {
      console.error(`[Healthgrades] Apify failed (${err.message}), using Playwright fallback`);
    }
  } else {
    console.error('[Healthgrades] No Apify token — using Playwright fallback');
  }

  if (doctors.length === 0) {
    try {
      doctors = await scrapeViaPlaywright();
    } catch (err) {
      console.error('[Healthgrades] Playwright also failed:', err.message);
    }
  }

  const results = formatDoctors(doctors);
  console.error(`[Healthgrades] Done — ${results.length} providers`);
  console.log(JSON.stringify(results, null, 2));
}

main().catch(err => {
  console.error('[Healthgrades] FATAL:', err.message);
  console.log('[]');
  process.exit(1);
});
