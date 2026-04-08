#!/usr/bin/env node
/**
 * check-linkedin-otw.mjs — Check LinkedIn profiles for "Open to Work" signal
 * Uses Playwright to load each profile page and detect the OTW frame/badge
 *
 * Usage: node lib/check-linkedin-otw.mjs --urls "url1,url2,url3"
 */
import { chromium } from 'playwright';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const v = argv[i+1] && !argv[i+1].startsWith('--') ? argv[i+1] : true;
      a[k] = v; if (v !== true) i++;
    }
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
const urls = (args.urls || '').split(',').map(s => s.trim()).filter(Boolean);

if (!urls.length) {
  console.error('[OTW] ERROR: --urls "url1,url2" required');
  process.exit(1);
}

async function checkProfiles(urls) {
  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    locale: 'en-US',
  });
  const page = await ctx.newPage();
  const results = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    console.error(`[OTW] Checking ${i+1}/${urls.length}: ${url}`);
    try {
      await page.goto(url, { timeout: 15000, waitUntil: 'domcontentloaded' });
      await sleep(2000);

      const data = await page.evaluate(() => {
        const html  = document.documentElement.innerHTML.toLowerCase();
        const text  = document.body?.innerText || '';

        // Open to Work signals in HTML/JSON-LD
        const otwSignals = [
          html.includes('open to work'),
          html.includes('opentowork'),
          html.includes('#open-to-work'),
          html.includes('"open_to_opportunities"'),
          html.includes('"opentowork"'),
          text.toLowerCase().includes('open to work'),
        ];
        const isOTW = otwSignals.some(Boolean);

        // Extract name from h1 or og:title
        const name  = document.querySelector('h1')?.innerText?.trim() ||
                      document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.replace(/\s*[-|].*$/, '').trim() || '';
        const title = document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';
        const login = html.includes('authwall') || html.includes('sign in to view') || document.title.includes('LinkedIn');

        return { name, title, isOTW, login, otwSignals };
      });

      results.push({
        url,
        name: data.name || 'Unknown',
        headline: data.title,
        open_to_work: data.isOTW,
        requires_login: data.login,
        signals: data.otwSignals,
      });
      console.error(`  → ${data.name || 'Unknown'} | OTW: ${data.isOTW} | Login wall: ${data.login}`);
    } catch (err) {
      console.error(`  → Error: ${err.message}`);
      results.push({ url, name: 'Error', open_to_work: null, error: err.message });
    }
    await sleep(1500);
  }

  await browser.close();
  return results;
}

checkProfiles(urls).then(r => {
  console.log(JSON.stringify(r, null, 2));
}).catch(err => {
  console.error('[OTW] FATAL:', err.message);
  console.log('[]');
});
