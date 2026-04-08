#!/usr/bin/env node
/**
 * scrape-healthgrades.mjs — Healthgrades public directory scraper
 * Outputs JSON array to stdout. Progress/errors go to stderr.
 *
 * Usage:
 *   node lib/scrape-healthgrades.mjs --specialty "Radiology" --location "New York, NY"
 */

import { chromium } from 'playwright';

const MAX_RESULTS = 20;
const PAGE_TIMEOUT = 20000;
const NAV_DELAY = 2000;

// --- Parse CLI args ---
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
      args[key] = val;
      if (val !== true) i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const specialty = args.specialty;
const location = args.location;

if (!specialty || !location) {
  console.error('[Healthgrades] ERROR: --specialty and --location are required');
  console.error('[Healthgrades] Example: node lib/scrape-healthgrades.mjs --specialty "Radiology" --location "New York, NY"');
  process.exit(1);
}

// Parse location
function parseLocation(loc) {
  const parts = loc.split(',').map(s => s.trim());
  return { city: parts[0] || '', state: parts[1] || '' };
}

const { city, state } = parseLocation(location);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- Scrape doctor cards from a Healthgrades results page ---
async function scrapeResults(page) {
  const doctors = await page.evaluate(() => {
    const results = [];

    // Healthgrades uses various card selectors — try multiple approaches
    const cardSelectors = [
      '[data-testid="provider-card"]',
      '[class*="ProviderCard"]',
      '[class*="provider-card"]',
      '[class*="DoctorCard"]',
      '[class*="doctor-card"]',
      '.result-item',
      '[role="listitem"]',
    ];

    let cards = [];
    for (const sel of cardSelectors) {
      cards = Array.from(document.querySelectorAll(sel));
      if (cards.length > 0) break;
    }

    // If no specific card elements, try article tags
    if (cards.length === 0) {
      cards = Array.from(document.querySelectorAll('article'));
    }

    for (const card of cards) {
      try {
        // Name
        const nameEl = card.querySelector('h2, h3, [class*="name"], [data-testid*="name"]');
        const name = nameEl ? nameEl.innerText.trim() : '';
        if (!name) continue;

        // Specialty
        const specialtyEl = card.querySelector('[class*="specialty"], [data-testid*="specialty"]');
        const specialty = specialtyEl ? specialtyEl.innerText.trim() : '';

        // Hospital / Practice
        const hospitalEl = card.querySelector('[class*="hospital"], [class*="practice"], [class*="affiliation"], [data-testid*="hospital"]');
        const hospital = hospitalEl ? hospitalEl.innerText.trim() : '';

        // Address
        const addressEl = card.querySelector('[class*="address"], address, [data-testid*="address"]');
        const address = addressEl ? addressEl.innerText.trim() : '';

        // Phone
        const phoneEl = card.querySelector('a[href^="tel:"], [class*="phone"]');
        const phone = phoneEl
          ? (phoneEl.href ? phoneEl.href.replace('tel:', '') : phoneEl.innerText.trim())
          : '';

        // Rating
        const ratingEl = card.querySelector('[class*="rating"], [aria-label*="star"], [data-testid*="rating"]');
        const ratingText = ratingEl
          ? (ratingEl.getAttribute('aria-label') || ratingEl.innerText || '').trim()
          : '';
        const ratingMatch = ratingText.match(/(\d+\.?\d*)/);
        const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

        // Profile URL
        const linkEl = card.querySelector('a[href*="/physician/"], a[href*="/doctor/"]') ||
                       card.querySelector('a[href]');
        const profileUrl = linkEl ? linkEl.href : '';

        results.push({ name, specialty, hospital, address, phone, rating, profileUrl });
      } catch (e) {
        // skip malformed card
      }
    }

    return results;
  });

  return doctors;
}

// --- Main ---
async function main() {
  console.error(`[Healthgrades] Searching for ${specialty} in ${location}...`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  const results = [];

  try {
    // Build Healthgrades search URL
    const searchUrl = `https://www.healthgrades.com/find-a-doctor/results?what=${encodeURIComponent(specialty)}&where=${encodeURIComponent(location)}`;
    console.error(`[Healthgrades] Navigating to: ${searchUrl}`);

    await page.goto(searchUrl, { timeout: PAGE_TIMEOUT, waitUntil: 'domcontentloaded' });
    await sleep(NAV_DELAY);

    // Check page loaded
    const title = await page.title();
    console.error(`[Healthgrades] Page title: ${title}`);

    // Wait for results to appear
    try {
      await page.waitForSelector('[class*="result"], [class*="doctor"], article', { timeout: 8000 });
    } catch {
      console.error('[Healthgrades] Results selector timeout — trying to parse anyway');
    }

    const doctors = await scrapeResults(page);
    console.error(`[Healthgrades] Found ${doctors.length} doctor cards`);

    if (doctors.length === 0) {
      // Try alternative: search via URL with different format
      const altUrl = `https://www.healthgrades.com/find-a-doctor/results?specialty=${encodeURIComponent(specialty)}&city=${encodeURIComponent(city)}&state=${encodeURIComponent(state)}`;
      console.error(`[Healthgrades] No results, trying alternative URL: ${altUrl}`);
      await page.goto(altUrl, { timeout: PAGE_TIMEOUT, waitUntil: 'domcontentloaded' });
      await sleep(NAV_DELAY);

      const altDoctors = await scrapeResults(page);
      console.error(`[Healthgrades] Alternative found ${altDoctors.length} cards`);
      doctors.push(...altDoctors);
    }

    // Convert to output format
    for (const doc of doctors.slice(0, MAX_RESULTS)) {
      // Parse city from address if available
      let profileCity = city;
      let profileState = state;
      if (doc.address) {
        // Try to find "City, ST" in address text
        const addrMatch = doc.address.match(/([A-Za-z\s]+),\s*([A-Z]{2})/);
        if (addrMatch) {
          profileCity = addrMatch[1].trim();
          profileState = addrMatch[2];
        }
      }

      results.push({
        source: 'healthgrades',
        full_name: doc.name,
        specialty: doc.specialty || specialty,
        hospital: doc.hospital || '',
        city: profileCity,
        state: profileState,
        address: doc.address || '',
        phone: doc.phone || '',
        rating: doc.rating || null,
        healthgrades_url: doc.profileUrl || '',
      });
    }
  } catch (err) {
    console.error(`[Healthgrades] Fatal error: ${err.message}`);
  } finally {
    await browser.close();
  }

  console.error(`[Healthgrades] Done. Returning ${results.length} providers.`);
  console.log(JSON.stringify(results, null, 2));
}

main().catch(err => {
  console.error(`[Healthgrades] FATAL: ${err.message}`);
  console.log(JSON.stringify([]));
  process.exit(1);
});
