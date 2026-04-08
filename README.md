# Recruiting Assistant

AI-powered healthcare candidate sourcing tool built as a Claude Code native skill. No Anthropic API key required — Claude Code IS the AI.

## What It Does

1. You paste a job description (or say "find me [specialty] in [location]")
2. Claude Code parses the JD and extracts role, specialty, location, and requirements
3. Scripts fetch candidates from three public data sources:
   - **NPI Registry** — free federal database of all licensed US healthcare providers
   - **Doximity** — public physician directory (largest in the US)
   - **Healthgrades** — public patient-facing doctor directory with ratings
4. Claude Code scores and ranks every candidate against the JD (1-10 scale)
5. A full report is saved to `output/` and the tracker in `data/candidates.md` is updated

## Setup

```bash
npm install
npm run install-browsers
```

That's it. No API keys, no `.env` file.

## Usage

Open this folder in Claude Code:

```bash
claude
```

Then either:
- **Paste a job description** — Claude Code runs the full sourcing workflow automatically
- **Type a quick command** — `find Radiologist in Dallas, TX`

## Commands

| What you say | What happens |
|---|---|
| Paste JD text | Full workflow: parse → fetch → score → report → tracker |
| `find [specialty] in [location]` | Skip JD parsing, run search directly |
| `show candidates` | Display the full candidates tracker |
| `draft outreach for [name]` | Write a personalized cold outreach message |
| `export csv` | Export candidates tracker as CSV |
| `clear` | Archive current tracker and start fresh |

## Data Sources

### NPI Registry
The National Provider Identifier (NPI) registry is a free, public federal database maintained by CMS (Centers for Medicare & Medicaid Services). It contains all licensed healthcare providers in the US, including their specialty taxonomy, practice address, and practice phone number.

API: `https://npiregistry.cms.hhs.gov/api/`

### Doximity
Doximity is the largest professional network for US physicians. Provider directory profiles are publicly accessible without login. The scraper uses Google/DuckDuckGo to find `doximity.com/pub/` profile pages and extracts name, specialty, hospital affiliation, and location.

### Healthgrades
Healthgrades is a public healthcare provider directory. The scraper navigates the search results page for the given specialty and location and extracts provider cards including name, specialty, practice, address, phone, and star rating.

## Output

- `output/{date}-{specialty}-{state}.md` — full search report with ranked candidate table
- `data/candidates.md` — running tracker of all candidates ever found (gitignored)

## Scripts

| Script | What it does |
|---|---|
| `lib/search-npi.mjs` | Fetches providers from NPI Registry API → stdout JSON |
| `lib/scrape-doximity.mjs` | Scrapes Doximity via search engine → stdout JSON |
| `lib/scrape-healthgrades.mjs` | Scrapes Healthgrades results page → stdout JSON |

All scripts output JSON to stdout and progress/errors to stderr — making them composable with Claude Code's bash tool.

## Privacy Note

All data sourced is publicly available federal or professional directory data. NPI Registry is a US government public database. Doximity and Healthgrades profiles are publicly listed by providers. Practice phone numbers are clinic/office numbers, not personal contacts.
