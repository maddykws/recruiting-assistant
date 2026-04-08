#!/usr/bin/env node
/**
 * search-abret.mjs — ABRET resume bank scraper
 * jobs.abret.org/employer/resumes/results/?q=&state=OR
 * Anonymous profiles shown without login (contact costs $35/connection)
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
const args     = parseArgs(process.argv.slice(2));
const state    = args.state || 'OR';
const keyword  = args.keyword || '';
const MAX = 30;

async function scrape() {
  const url = `https://jobs.abret.org/employer/resumes/results/?q=${encodeURIComponent(keyword)}&state=${state}&pp=20`;
  console.error(`[ABRET] Scraping resume bank: ${url}`);

  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  });
  const page = await ctx.newPage();

  const results = [];
  try {
    await page.goto(url, { timeout: 20000, waitUntil: 'domcontentloaded' });
    await sleep(2000);

    // Check if login wall
    const loginCheck = await page.evaluate(() =>
      document.body?.innerText?.toLowerCase().includes('sign in') ||
      document.body?.innerText?.toLowerCase().includes('log in') ||
      !!document.querySelector('input[type="password"]')
    );
    if (loginCheck) {
      console.error('[ABRET] Login required to view resumes');
      await browser.close();
      return [];
    }

    const total = await page.evaluate(() => {
      const t = document.body?.innerText?.match(/(\d[\d,]*)\s+results?/i);
      return t ? t[1].replace(',','') : '?';
    });
    console.error(`[ABRET] Total results shown: ${total}`);

    // Parse candidate cards
    const candidates = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll(
        '[class*="resume"], [class*="candidate"], [class*="result-item"], .listRow, li[class*="row"]'
      ));
      if (!cards.length) {
        // fallback: grab all visible text blocks
        return [{ raw: document.body?.innerText?.slice(0, 2000) }];
      }
      return cards.slice(0, 30).map(c => {
        const t = s => c.querySelector(s)?.innerText?.trim() || '';
        return {
          title:    t('[class*="title"], h2, h3, strong'),
          location: t('[class*="location"], [class*="city"]'),
          company:  t('[class*="company"], [class*="employer"]'),
          updated:  t('[class*="date"], [class*="update"]'),
          relocate: t('[class*="relocat"]'),
          raw:      c.innerText?.trim().slice(0, 300),
        };
      });
    });

    console.error(`[ABRET] Parsed ${candidates.length} candidate entries`);

    for (const c of candidates) {
      if (c.raw && !c.title) {
        // fallback raw text
        results.push({ source: 'abret', raw: c.raw, state, note: 'Raw extract — ABRET may require login for structured data' });
      } else {
        results.push({
          source: 'abret',
          full_name: 'Anonymous',
          specialty: c.title || 'Neurodiagnostic Technologist',
          city: c.location?.split(',')[0] || '',
          state: c.location?.split(',')[1]?.trim() || state,
          company: c.company || '',
          updated: c.updated || '',
          willing_to_relocate: c.relocate || '',
          abret_url: 'https://jobs.abret.org/employer/resumes/results/',
          note: 'ABRET anonymous profile — $35 to connect via jobs.abret.org',
        });
      }
    }
  } catch (err) {
    console.error('[ABRET] Error:', err.message);
  } finally {
    await browser.close();
  }
  return results;
}

scrape().then(r => {
  console.error(`[ABRET] Done — ${r.length} profiles`);
  console.log(JSON.stringify(r, null, 2));
}).catch(err => {
  console.error('[ABRET] FATAL:', err.message);
  console.log('[]');
});
