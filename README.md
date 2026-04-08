# Healthcare Recruiting Assistant

AI-powered tool that takes a job description and finds matching healthcare professionals from free public data sources — ranked by fit using Claude.

## What It Does

1. **Parses your JD** with Claude Haiku to extract specialty, location, and requirements
2. **Searches three sources in parallel:**
   - **NPI Registry** (US government database — free, no auth, 7M+ providers)
   - **Doximity** public physician directory (scraped via Playwright)
   - **Healthgrades** public doctor search (scraped via Playwright)
3. **Scores each candidate 1–10** with a match reason and personalized outreach opener
4. **Streams results live** to the browser as they're found
5. **Exports to CSV** for use in your ATS or outreach tool

## Setup

### 1. Install dependencies

```bash
npm install
npx playwright install chromium
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and add your Anthropic API key:

```
ANTHROPIC_API_KEY=sk-ant-...
PORT=3336
```

### 3. Start the server

```bash
npm start
# or for development with auto-reload:
npm run dev
```

Open **http://localhost:3336** in your browser.

## Usage

1. Open the app in your browser
2. Paste a full job description in the textarea
3. Click **Search Candidates** (or press `Ctrl+Enter`)
4. Watch candidates stream in from all three sources
5. Click **Export CSV** to download results

## Data Sources

### NPI Registry (Tier 1 — Free, No Auth)

The [National Provider Identifier](https://npiregistry.cms.hhs.gov/) registry is maintained by the US government (CMS). It contains over 7 million individual healthcare providers in the US with:

- Full name and credentials (MD, DO, NP, PA, RN, etc.)
- Medical specialty (using NPI taxonomy codes)
- Practice address and **practice phone number**
- NPI number (unique identifier)

**Important:** NPI provides the **practice/clinic phone**, not a personal number. Always label it as "Practice Phone" when reaching out.

API endpoint used: `https://npiregistry.cms.hhs.gov/api/?version=2.1`

No API key required. Rate limit is generous (no documented limit for reasonable use).

### Doximity (Tier 2 — Scraped)

Doximity is the largest professional network for US physicians. The public directory at `doximity.com/directory` is scraped via Playwright. If Doximity requires login or blocks the request, the tool automatically falls back to a **Google X-Ray search** (`site:doximity.com/pub`) to find public profile URLs.

### Healthgrades (Tier 2 — Scraped)

Healthgrades public doctor search is scraped from `healthgrades.com/find-a-doctor/results`. Provides name, specialty, hospital affiliation, address, phone, and patient rating.

## Candidate Scoring

Candidates are scored 1–10 by Claude Haiku based on:

- **Specialty match** (exact match = higher score)
- **Location match** (same city/state = higher score)
- **Credential fit** (required credential vs. what the provider holds)

Each candidate also gets:
- `match_reason` — one-sentence explanation
- `outreach_line` — personalized cold message opener

## Tech Stack

- **Node.js ESM** — all `.mjs` files
- **Express.js** — backend on port 3336
- **Playwright** — headless Chromium for scraping
- **`@anthropic-ai/sdk`** — JD parsing + candidate scoring
- **`better-sqlite3`** — local candidate cache
- **Server-Sent Events (SSE)** — real-time streaming to browser
- **Vanilla JS + CSS** — no framework, dark UI

## Project Structure

```
recruiting-assistant/
├── server.mjs              # Express server + SSE endpoint
├── lib/
│   ├── parse-jd.mjs        # Claude JD parser
│   ├── search-npi.mjs      # NPI Registry API search
│   ├── search-doximity.mjs # Doximity scraper
│   ├── search-healthgrades.mjs  # Healthgrades scraper
│   ├── score-candidates.mjs     # Claude scoring
│   └── db.mjs              # SQLite cache
├── public/
│   ├── index.html          # App UI
│   ├── style.css           # Dark theme
│   └── app.js              # Frontend JS
├── data/                   # SQLite DB (gitignored)
├── .env                    # API keys (gitignored)
└── .env.example            # Template
```

## Notes

- Results are cached in `data/candidates.db` (SQLite). Each new search clears the cache.
- Playwright operations time out after 15 seconds per page.
- Scoring batches up to 10 candidates per Claude call to reduce cost.
- The `claude-haiku-4-5` model is used for both JD parsing and scoring (fast + cheap).
