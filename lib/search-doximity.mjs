import { chromium } from 'playwright';

/**
 * Scrapes public Doximity physician directory profiles.
 * Falls back to Google X-Ray search if Doximity blocks direct access.
 */

const TIMEOUT = 15000;
const DELAY_MS = 1500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Attempt direct Doximity directory search.
 */
async function searchDoximityDirect(specialty, city, state, page) {
  const location = [city, state].filter(Boolean).join(', ');
  const encodedSpecialty = encodeURIComponent(specialty);
  const encodedLocation = encodeURIComponent(location);

  const url = `https://www.doximity.com/directory/doctors?specialty=${encodedSpecialty}&location=${encodedLocation}`;

  try {
    await page.goto(url, { timeout: TIMEOUT, waitUntil: 'domcontentloaded' });
    await sleep(DELAY_MS);

    // Check if we got redirected to login
    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/sign_in')) {
      console.log('[Doximity] Redirected to login, will use fallback');
      return null;
    }

    // Check for CAPTCHA or auth wall
    const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());
    if (bodyText.includes('sign in') && bodyText.includes('create account') && !bodyText.includes('md') && !bodyText.includes('doctor')) {
      console.log('[Doximity] Auth wall detected, will use fallback');
      return null;
    }

    // Try to scrape doctor cards
    const candidates = await page.evaluate(() => {
      const cards = document.querySelectorAll(
        '[data-testid="physician-card"], .physician-card, .doctor-card, [class*="PhysicianCard"], [class*="DoctorCard"]'
      );

      const results = [];
      cards.forEach(card => {
        const nameEl = card.querySelector('h2, h3, [class*="name"], [class*="Name"]');
        const specialtyEl = card.querySelector('[class*="specialty"], [class*="Specialty"]');
        const locationEl = card.querySelector('[class*="location"], [class*="Location"]');
        const affiliationEl = card.querySelector('[class*="affiliation"], [class*="hospital"], [class*="Hospital"]');
        const linkEl = card.querySelector('a[href*="/pub/"]') || card.querySelector('a');

        if (nameEl) {
          results.push({
            full_name: nameEl.textContent?.trim(),
            specialty: specialtyEl?.textContent?.trim() || '',
            location: locationEl?.textContent?.trim() || '',
            hospital_affiliation: affiliationEl?.textContent?.trim() || '',
            doximity_url: linkEl?.href || null,
          });
        }
      });

      return results;
    });

    if (candidates.length > 0) {
      return candidates;
    }

    // Try alternative selectors for different page layouts
    const altCandidates = await page.evaluate(() => {
      const results = [];
      // Try finding any links to /pub/ profiles
      const profileLinks = document.querySelectorAll('a[href*="doximity.com/pub/"], a[href*="/pub/"]');
      const seen = new Set();

      profileLinks.forEach(link => {
        const href = link.href;
        if (seen.has(href)) return;
        seen.add(href);

        const container = link.closest('li, article, [class*="card"], [class*="Card"], div');
        const text = container?.innerText || link.innerText || '';
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

        if (lines.length > 0) {
          results.push({
            full_name: lines[0],
            specialty: lines[1] || '',
            location: lines[2] || '',
            hospital_affiliation: lines[3] || '',
            doximity_url: href,
          });
        }
      });

      return results;
    });

    return altCandidates.length > 0 ? altCandidates : null;

  } catch (err) {
    console.error('[Doximity] Direct search error:', err.message);
    return null;
  }
}

/**
 * Google X-Ray fallback: search site:doximity.com/pub for profiles.
 */
async function searchDoximityGoogleXray(specialty, city, state, page) {
  const location = [city, state].filter(Boolean).join(' ');
  const query = `site:doximity.com/pub "${specialty}" "${location}"`;
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=20`;

  try {
    await page.goto(searchUrl, { timeout: TIMEOUT, waitUntil: 'domcontentloaded' });
    await sleep(DELAY_MS);

    const candidates = await page.evaluate(() => {
      const results = [];
      // Google search result items
      const items = document.querySelectorAll('div.g, div[data-hveid]');

      items.forEach(item => {
        const linkEl = item.querySelector('a[href*="doximity.com/pub/"]');
        if (!linkEl) return;

        const titleEl = item.querySelector('h3');
        const snippetEl = item.querySelector('[class*="snippet"], [data-sncf], .VwiC3b, span');

        const href = linkEl.href;
        const title = titleEl?.textContent?.trim() || '';
        const snippet = snippetEl?.textContent?.trim() || '';

        // Parse name and specialty from title (usually "Dr. John Smith, MD - Cardiologist | Doximity")
        const titleParts = title.replace(' | Doximity', '').split(' - ');
        const nameCredPart = titleParts[0] || '';
        const specialtyPart = titleParts[1] || '';

        // Extract location from snippet
        const locationMatch = snippet.match(/([A-Z][a-z]+(?:\s[A-Z][a-z]+)*),\s*([A-Z]{2})/);

        if (nameCredPart) {
          results.push({
            full_name: nameCredPart.trim(),
            specialty: specialtyPart.trim(),
            location: locationMatch ? `${locationMatch[1]}, ${locationMatch[2]}` : '',
            hospital_affiliation: '',
            doximity_url: href,
          });
        }
      });

      return results;
    });

    return candidates;

  } catch (err) {
    console.error('[Doximity] Google X-Ray error:', err.message);
    return [];
  }
}

/**
 * Main Doximity search function.
 * @param {Object} parsedJd - Parsed job description
 * @param {Function} onStatus - Status callback
 * @returns {Promise<Array>} Array of candidate objects
 */
export async function searchDoximity(parsedJd, onStatus = () => {}) {
  const { specialty, city, state_code } = parsedJd;

  onStatus(`Searching Doximity for ${specialty} physicians...`);

  let browser;
  const candidates = [];

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);

    // Try direct Doximity search first
    let results = await searchDoximityDirect(specialty, city, state_code, page);
    let source = 'doximity';

    // Fall back to Google X-Ray if direct search failed or returned nothing
    if (!results || results.length === 0) {
      onStatus('Doximity direct search unavailable, trying Google X-Ray...');
      results = await searchDoximityGoogleXray(specialty, city, state_code, page);
      source = 'doximity-xray';
    }

    if (results && results.length > 0) {
      // Normalize results
      for (const r of results.slice(0, 20)) {
        if (!r.full_name) continue;

        // Parse city/state from location string
        const locationParts = (r.location || '').split(',').map(s => s.trim());
        const parsedCity = locationParts[0] || city || '';
        const parsedState = locationParts[1] || state_code || '';

        candidates.push({
          source,
          npi: null,
          first_name: r.full_name.split(' ')[0] || '',
          last_name: r.full_name.split(' ').slice(-1)[0] || '',
          full_name: r.full_name,
          specialty: r.specialty || specialty,
          credential: extractCredential(r.full_name),
          phone: '',
          city: parsedCity,
          state: parsedState,
          zip: '',
          address: r.location || '',
          doximity_url: r.doximity_url || null,
          healthgrades_url: null,
          hospital_affiliation: r.hospital_affiliation || '',
          email: null,
          score: null,
          match_reason: null,
          outreach_line: null,
          rating: null,
        });
      }

      onStatus(`Doximity: found ${candidates.length} profiles (${source})`);
    } else {
      onStatus('Doximity: no profiles found');
    }

  } catch (err) {
    onStatus(`Doximity search error: ${err.message}`);
    console.error('[Doximity] Fatal error:', err);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }

  return candidates;
}

/**
 * Extract credential abbreviation from name string (e.g., "MD", "DO", "NP").
 */
function extractCredential(nameStr) {
  if (!nameStr) return '';
  const credentialPattern = /\b(MD|DO|NP|PA|RN|APRN|CRNA|PA-C|DNP|DPM|OD|DC|PhD|MBBS|FACC|FACS|FACOG)\b/gi;
  const matches = nameStr.match(credentialPattern);
  return matches ? [...new Set(matches.map(m => m.toUpperCase()))].join(', ') : '';
}
