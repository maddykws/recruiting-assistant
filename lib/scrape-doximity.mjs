#!/usr/bin/env node
/**
 * scrape-doximity.mjs — Doximity public directory scraper via search engines
 * Outputs JSON array to stdout. Progress/errors go to stderr.
 *
 * Strategy: Use Google (then DuckDuckGo fallback) to find site:doximity.com/pub pages,
 * then scrape each profile for structured data.
 *
 * Usage:
 *   node lib/scrape-doximity.mjs --specialty "Radiology" --location "New York, NY"
 */

import { chromium } from 'playwright';

const MAX_RESULTS = 15;
const PAGE_TIMEOUT = 15000;
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
  console.error('[Doximity] ERROR: --specialty and --location are required');
  console.error('[Doximity] Example: node lib/scrape-doximity.mjs --specialty "Radiology" --location "New York, NY"');
  process.exit(1);
}

// Parse location into city/state
function parseLocation(loc) {
  const parts = loc.split(',').map(s => s.trim());
  return {
    city: parts[0] || '',
    state: parts[1] || '',
  };
}

const { city, state } = parseLocation(location);

// --- Sleep helper ---
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- Extract Doximity profile URLs from a search results page ---
async function extractDoximityUrls(page) {
  const urls = new Set();

  // Try to find links that match doximity.com/pub/
  const links = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    return anchors.map(a => a.href);
  });

  for (const link of links) {
    if (link.includes('doximity.com/pub/') && !link.includes('?') ) {
      urls.add(link);
    }
    // Also catch redirected links from Google (e.g., /url?q=https://doximity...)
    if (link.includes('url?q=https') && link.includes('doximity.com')) {
      const match = link.match(/url\?q=(https:\/\/www\.doximity\.com\/pub\/[^&]+)/);
      if (match) urls.add(decodeURIComponent(match[1]));
    }
  }

  return [...urls];
}

// --- Scrape a single Doximity profile page ---
async function scrapeProfile(page, url) {
  try {
    await page.goto(url, { timeout: PAGE_TIMEOUT, waitUntil: 'domcontentloaded' });
    await sleep(1000);

    const data = await page.evaluate(() => {
      // Name: usually in h1 or a prominent heading
      const nameEl = document.querySelector('h1') ||
                     document.querySelector('[class*="name"]') ||
                     document.querySelector('[data-testid*="name"]');
      const name = nameEl ? nameEl.innerText.trim() : '';

      // Specialty: look for specialty-related elements
      const specialtyEl = document.querySelector('[class*="specialty"]') ||
                          document.querySelector('[data-testid*="specialty"]') ||
                          document.querySelector('[class*="Specialty"]');
      const specialty = specialtyEl ? specialtyEl.innerText.trim() : '';

      // Hospital/affiliation
      const hospitalEl = document.querySelector('[class*="hospital"]') ||
                         document.querySelector('[class*="affiliation"]') ||
                         document.querySelector('[class*="practice"]') ||
                         document.querySelector('[data-testid*="hospital"]');
      const hospital = hospitalEl ? hospitalEl.innerText.trim() : '';

      // Location
      const locationEl = document.querySelector('[class*="location"]') ||
                         document.querySelector('[class*="city"]') ||
                         document.querySelector('[data-testid*="location"]');
      const loc = locationEl ? locationEl.innerText.trim() : '';

      // Try to grab any structured data from the page
      const metaDesc = document.querySelector('meta[name="description"]');
      const description = metaDesc ? metaDesc.content : '';

      return { name, specialty, hospital, location: loc, description };
    });

    // If we got very little from JS evaluation, try text parsing
    let fullName = data.name;
    let specialtyResult = data.specialty;
    let hospitalResult = data.hospital;
    let locationResult = data.location;

    // Fallback: parse from title tag
    if (!fullName) {
      const title = await page.title();
      // Doximity titles are usually like "Dr. Jane Smith, MD - Radiology | Doximity"
      const titleMatch = title.match(/^(Dr\.\s+)?([^,|]+)/);
      if (titleMatch) fullName = titleMatch[0].replace(/\s*[-|].*$/, '').trim();
    }

    // Fallback: parse specialty from description meta
    if (!specialtyResult && data.description) {
      const descMatch = data.description.match(/(?:is a|specializes in|practice of)\s+([^.]+)/i);
      if (descMatch) specialtyResult = descMatch[1].trim();
    }

    if (!fullName) return null;

    // Parse city/state from location string
    let profileCity = city;
    let profileState = state;
    if (locationResult) {
      const locParts = locationResult.split(',').map(s => s.trim());
      if (locParts.length >= 2) {
        profileCity = locParts[0];
        profileState = locParts[1].split(' ')[0]; // handle "NY 10001" → "NY"
      }
    }

    return {
      source: 'doximity',
      full_name: fullName,
      specialty: specialtyResult || specialty,
      hospital: hospitalResult || '',
      city: profileCity,
      state: profileState,
      doximity_url: url,
    };
  } catch (err) {
    console.error(`[Doximity] Failed to scrape ${url}: ${err.message}`);
    return null;
  }
}

// --- Search Google for Doximity profiles ---
async function searchGoogle(page, query) {
  console.error(`[Doximity] Trying Google: ${query}`);
  try {
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=20`;
    await page.goto(googleUrl, { timeout: PAGE_TIMEOUT, waitUntil: 'domcontentloaded' });
    await sleep(2000);

    // Check if blocked
    const title = await page.title();
    if (title.toLowerCase().includes('blocked') || title.toLowerCase().includes('captcha')) {
      console.error('[Doximity] Google blocked, trying DuckDuckGo');
      return [];
    }

    const urls = await extractDoximityUrls(page);
    console.error(`[Doximity] Google found ${urls.length} Doximity URLs`);
    return urls;
  } catch (err) {
    console.error(`[Doximity] Google search failed: ${err.message}`);
    return [];
  }
}

// --- Search DuckDuckGo for Doximity profiles ---
async function searchDuckDuckGo(page, query) {
  console.error(`[Doximity] Trying DuckDuckGo: ${query}`);
  try {
    const ddgUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&ia=web`;
    await page.goto(ddgUrl, { timeout: PAGE_TIMEOUT, waitUntil: 'domcontentloaded' });
    await sleep(3000);

    const urls = await extractDoximityUrls(page);
    console.error(`[Doximity] DuckDuckGo found ${urls.length} Doximity URLs`);
    return urls;
  } catch (err) {
    console.error(`[Doximity] DuckDuckGo search failed: ${err.message}`);
    return [];
  }
}

// --- Main ---
async function main() {
  console.error(`[Doximity] Searching for ${specialty} in ${location}...`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  const results = [];

  try {
    const searchQuery = `site:doximity.com/pub "${specialty}" "${city}" "${state}"`;

    // Try Google first
    let profileUrls = await searchGoogle(page, searchQuery);

    // Fallback to DuckDuckGo
    if (profileUrls.length === 0) {
      const ddgQuery = `site:doximity.com/pub ${specialty} ${location}`;
      profileUrls = await searchDuckDuckGo(page, ddgQuery);
    }

    // Limit to MAX_RESULTS
    profileUrls = profileUrls.slice(0, MAX_RESULTS);
    console.error(`[Doximity] Will scrape ${profileUrls.length} profiles`);

    // Scrape each profile
    for (let i = 0; i < profileUrls.length; i++) {
      const url = profileUrls[i];
      console.error(`[Doximity] Scraping profile ${i + 1}/${profileUrls.length}: ${url}`);
      await sleep(NAV_DELAY);

      const profile = await scrapeProfile(page, url);
      if (profile) {
        results.push(profile);
        console.error(`[Doximity] Got: ${profile.full_name}`);
      }
    }
  } catch (err) {
    console.error(`[Doximity] Fatal error: ${err.message}`);
  } finally {
    await browser.close();
  }

  console.error(`[Doximity] Done. Returning ${results.length} profiles.`);
  console.log(JSON.stringify(results, null, 2));
}

main().catch(err => {
  console.error(`[Doximity] FATAL: ${err.message}`);
  console.log(JSON.stringify([]));
  process.exit(1);
});
