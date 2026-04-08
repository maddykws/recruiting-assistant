import { chromium } from 'playwright';

/**
 * Scrapes Healthgrades public doctor search results.
 */

const TIMEOUT = 15000;
const DELAY_MS = 1000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Build Healthgrades search URL.
 */
function buildSearchUrl(specialty, city, state) {
  const what = encodeURIComponent(specialty);
  const where = encodeURIComponent([city, state].filter(Boolean).join(', '));
  return `https://www.healthgrades.com/find-a-doctor/results?what=${what}&where=${where}`;
}

/**
 * Scrape doctor cards from the current page.
 */
async function scrapeDoctorCards(page) {
  return await page.evaluate(() => {
    const candidates = [];

    // Try multiple possible selectors for doctor cards
    const cardSelectors = [
      '[data-qa-target="provider-card"]',
      '[class*="ProviderCard"]',
      '[class*="provider-card"]',
      '[class*="DoctorCard"]',
      '[class*="doctor-card"]',
      'li[class*="result"]',
      'article[class*="provider"]',
    ];

    let cards = [];
    for (const sel of cardSelectors) {
      cards = document.querySelectorAll(sel);
      if (cards.length > 0) break;
    }

    // If no specific cards found, try looking for structured data
    if (cards.length === 0) {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      scripts.forEach(script => {
        try {
          const data = JSON.parse(script.textContent);
          const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
          items.forEach(item => {
            if (item['@type'] === 'Physician' || item['@type'] === 'MedicalBusiness' || item['@type'] === 'Person') {
              candidates.push({
                full_name: item.name || '',
                specialty: item.medicalSpecialty || '',
                hospital_affiliation: item.worksFor?.name || '',
                address: item.address ? `${item.address.streetAddress || ''}, ${item.address.addressLocality || ''}, ${item.address.addressRegion || ''}` : '',
                phone: item.telephone || '',
                healthgrades_url: item.url || window.location.href,
                rating: item.aggregateRating?.ratingValue || null,
                city: item.address?.addressLocality || '',
                state: item.address?.addressRegion || '',
              });
            }
          });
        } catch (_) {}
      });
      return candidates;
    }

    cards.forEach(card => {
      // Name
      const nameEl = card.querySelector(
        'h2, h3, [data-qa-target="provider-name"], [class*="provider-name"], [class*="ProviderName"], [class*="doctor-name"]'
      );

      // Specialty
      const specialtyEl = card.querySelector(
        '[data-qa-target="specialty"], [class*="specialty"], [class*="Specialty"]'
      );

      // Hospital/Practice
      const hospitalEl = card.querySelector(
        '[data-qa-target="affiliation"], [class*="hospital"], [class*="Hospital"], [class*="affiliation"], [class*="Affiliation"], [class*="practice"], [class*="Practice"]'
      );

      // Address
      const addressEl = card.querySelector(
        '[class*="address"], [class*="Address"], [data-qa-target="address"]'
      );

      // Phone
      const phoneEl = card.querySelector(
        'a[href^="tel:"], [class*="phone"], [class*="Phone"], [data-qa-target="phone"]'
      );

      // Rating
      const ratingEl = card.querySelector(
        '[class*="rating"], [class*="Rating"], [aria-label*="rating"], [aria-label*="stars"]'
      );

      // Profile link
      const linkEl = card.querySelector('a[href*="/physicians/"], a[href*="/healthcare-providers/"]') ||
        card.querySelector('a[href]');

      // Extract phone from tel: link or text
      let phone = '';
      if (phoneEl) {
        const href = phoneEl.getAttribute('href') || '';
        if (href.startsWith('tel:')) {
          phone = href.replace('tel:', '').trim();
        } else {
          phone = phoneEl.textContent?.trim() || '';
        }
      }

      // Extract rating value
      let rating = null;
      if (ratingEl) {
        const ariaLabel = ratingEl.getAttribute('aria-label') || '';
        const ratingMatch = ariaLabel.match(/(\d+\.?\d*)\s*(?:out of|\/)\s*5/i) ||
          ratingEl.textContent?.match(/(\d+\.?\d*)/);
        if (ratingMatch) rating = parseFloat(ratingMatch[1]);
      }

      // Parse address for city/state
      const addressText = addressEl?.textContent?.trim() || '';
      const cityStateMatch = addressText.match(/([A-Za-z\s]+),\s*([A-Z]{2})\s*\d*/);

      const name = nameEl?.textContent?.trim();
      if (name) {
        candidates.push({
          full_name: name,
          specialty: specialtyEl?.textContent?.trim() || '',
          hospital_affiliation: hospitalEl?.textContent?.trim() || '',
          address: addressText,
          phone,
          healthgrades_url: linkEl?.href || window.location.href,
          rating,
          city: cityStateMatch ? cityStateMatch[1].trim() : '',
          state: cityStateMatch ? cityStateMatch[2].trim() : '',
        });
      }
    });

    return candidates;
  });
}

/**
 * Main Healthgrades search function.
 * @param {Object} parsedJd - Parsed job description
 * @param {Function} onStatus - Status callback
 * @returns {Promise<Array>} Array of candidate objects
 */
export async function searchHealthgrades(parsedJd, onStatus = () => {}) {
  const { specialty, city, state_code } = parsedJd;

  onStatus(`Searching Healthgrades for ${specialty}${city ? ` in ${city}` : ''}...`);

  let browser;
  const allCandidates = [];

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
    });

    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);

    const url = buildSearchUrl(specialty, city, state_code);
    await page.goto(url, { timeout: TIMEOUT, waitUntil: 'domcontentloaded' });
    await sleep(DELAY_MS);

    // Handle any cookie consent or modals
    await page.evaluate(() => {
      const dismissBtns = document.querySelectorAll(
        '[aria-label="close"], [class*="modal-close"], [class*="dismiss"], button[data-testid="close"]'
      );
      dismissBtns.forEach(btn => btn.click());
    }).catch(() => {});

    await sleep(500);

    // Check if we got a meaningful page
    const pageText = await page.evaluate(() => document.body.innerText.toLowerCase());
    if (pageText.length < 100 || pageText.includes('access denied') || pageText.includes('403')) {
      onStatus('Healthgrades: access denied or empty response');
      return allCandidates;
    }

    // Scrape first page
    let pageCandidates = await scrapeDoctorCards(page);
    allCandidates.push(...pageCandidates);

    onStatus(`Healthgrades: page 1 — found ${pageCandidates.length} doctors`);

    // Try page 2 if we have few results
    if (allCandidates.length < 10 && allCandidates.length > 0) {
      try {
        // Try clicking "Next" or navigating to page 2
        const nextBtn = await page.$('a[aria-label="Next"], button[aria-label="Next"], [class*="pagination"] [class*="next"]');
        if (nextBtn) {
          await nextBtn.click();
          await sleep(DELAY_MS);
          const page2Candidates = await scrapeDoctorCards(page);
          allCandidates.push(...page2Candidates);
          onStatus(`Healthgrades: page 2 — found ${page2Candidates.length} more doctors`);
        }
      } catch (_) {}
    }

    // Normalize results
    const seenNames = new Set();
    const normalized = [];

    for (const c of allCandidates.slice(0, 20)) {
      if (!c.full_name || seenNames.has(c.full_name.toLowerCase())) continue;
      seenNames.add(c.full_name.toLowerCase());

      // Use parsed JD location as fallback
      const candidateCity = c.city || city || '';
      const candidateState = c.state || state_code || '';

      normalized.push({
        source: 'healthgrades',
        npi: null,
        first_name: c.full_name.split(' ')[0] || '',
        last_name: c.full_name.split(' ').slice(-1)[0] || '',
        full_name: c.full_name,
        specialty: c.specialty || specialty,
        credential: extractCredential(c.full_name),
        phone: formatPhone(c.phone),
        city: candidateCity,
        state: candidateState,
        zip: '',
        address: c.address || '',
        doximity_url: null,
        healthgrades_url: c.healthgrades_url || null,
        hospital_affiliation: c.hospital_affiliation || '',
        email: null,
        score: null,
        match_reason: null,
        outreach_line: null,
        rating: c.rating,
      });
    }

    onStatus(`Healthgrades: found ${normalized.length} providers total`);
    return normalized;

  } catch (err) {
    onStatus(`Healthgrades search error: ${err.message}`);
    console.error('[Healthgrades] Fatal error:', err);
    return allCandidates;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

function extractCredential(nameStr) {
  if (!nameStr) return '';
  const credentialPattern = /\b(MD|DO|NP|PA|RN|APRN|CRNA|PA-C|DNP|DPM|OD|DC|PhD|MBBS|FACC|FACS|FACOG)\b/gi;
  const matches = nameStr.match(credentialPattern);
  return matches ? [...new Set(matches.map(m => m.toUpperCase()))].join(', ') : '';
}

function formatPhone(raw) {
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits[0] === '1') {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return raw;
}
