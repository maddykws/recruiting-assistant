# Recruiting Assistant — Claude Code Skill

## What This Is
An AI-powered healthcare candidate sourcing tool. The user pastes a Job Description (or gives a quick command) and Claude Code:
1. Parses the JD directly (no API — Claude IS the AI)
2. Runs data-fetcher scripts to pull candidates from NPI Registry, LinkedIn, Doximity, Healthgrades
3. Each script uses Apify as primary (proxies + anti-bot) with Playwright as automatic fallback
4. Scores and ranks candidates against the JD
5. Saves a report to output/ and updates data/candidates.md

## Scraper Strategy
- **Apify primary**: handles proxies, anti-bot detection, JS rendering — more reliable
- **Playwright fallback**: kicks in automatically if Apify fails or token is missing
- APIFY_TOKEN is stored in `.env` — scripts load it automatically

## Trigger Patterns
Activate this workflow when the user:
- Pastes a block of text that looks like a job description (has role, location, requirements)
- Says "find me [specialty] in [location]"
- Says "search for candidates" or "source candidates"
- Pastes a BountyJobs / job board URL or JD text

## Workflow

### Step 1 — Parse the JD
Read the JD and extract:
- `job_title` — clean role name (e.g. "Interventional Radiologist")
- `specialty` — NPI taxonomy term (see mapping below)
- `subspecialty` — if any (e.g. "Interventional", "Pediatric")
- `state_code` — 2-letter state (e.g. "NY"). If multiple states, use primary.
- `city` — city name
- `location` — "City, ST" format
- `experience_years` — minimum years required
- `requirements` — bullet list of must-haves
- `nice_to_haves` — bullet list of preferred but not required

### NPI Taxonomy Mapping (use these exact terms for best results)
| Role | NPI taxonomy_description |
|------|--------------------------|
| Radiologist | Radiology |
| Interventional Radiologist | Vascular & Interventional Radiology |
| ER Doctor / Emergency Medicine | Emergency Medicine |
| Hospitalist | Internal Medicine |
| Surgeon | Surgery |
| Cardiologist | Cardiovascular Disease |
| Neurologist | Neurology |
| Psychiatrist | Psychiatry |
| Orthopedic Surgeon | Orthopaedic Surgery |
| Pediatrician | Pediatrics |
| OB/GYN | Obstetrics & Gynecology |
| Anesthesiologist | Anesthesiology |
| Nurse Practitioner | Nurse Practitioner |
| PA / Physician Assistant | Physician Assistant |
| Nurse | Registered Nurse |
| Physical Therapist | Physical Therapy |
| Pharmacist | Pharmacy |

If unsure, use the most common term — NPI search does partial matching.

### Step 2 — Run NPI Search
```bash
node lib/search-npi.mjs --specialty "{specialty}" --state "{state_code}" --limit 50
```
Parse the JSON output. Each result has: npi, full_name, credential, specialty, phone, city, state, address.

### Step 3 — Run LinkedIn Search
```bash
node lib/search-linkedin.mjs --specialty "{specialty}" --location "{city}, {state_code}"
```
Parse JSON output. Each result has: full_name, specialty, hospital, headline, linkedin_url.
Note: Apify actor returns richer profile data. X-Ray fallback returns URL-only (name hint from slug).

### Step 4 — Run Doximity Scrape
```bash
node lib/scrape-doximity.mjs --specialty "{specialty}" --location "{city}, {state_code}"
```
Parse JSON output. Each result has: full_name, specialty, hospital, location, doximity_url.

### Step 5 — Run Healthgrades Scrape
```bash
node lib/scrape-healthgrades.mjs --specialty "{specialty}" --location "{city}, {state_code}"
```
Parse JSON output. Each result has: full_name, specialty, hospital, address, phone, rating, healthgrades_url.

### Step 6 — Merge & Dedup
- Combine all four source arrays (NPI + LinkedIn + Doximity + Healthgrades)
- Dedup by NPI first, then by normalized name (lowercase, no punctuation)
- When merging duplicates: prefer NPI phone, combine all URLs (linkedin_url, doximity_url, healthgrades_url)

### Step 7 — Score Each Candidate (YOU do this — no API needed)
For each candidate, score 1-10 based on:
- **Specialty match** (0-4 pts): Exact match = 4, subspecialty match = 3, related = 2
- **Location** (0-3 pts): Same city = 3, same state = 2, adjacent state = 1
- **Credentials** (0-2 pts): Right credential for role (MD/DO for physician, NP for NP role)
- **Data completeness** (0-1 pt): Has phone AND doximity/healthgrades link

Also write:
- `match_reason` — 1 sentence why they're a strong fit
- `outreach_line` — 1 personalized opener for a cold message (mention their specialty + location + the opportunity)

### Step 8 — Save Report
Write to `output/{YYYY-MM-DD}-{specialty-slug}-{state}.md`:

```markdown
# Candidate Search Report
**Role:** {job_title}
**Specialty:** {specialty}
**Location:** {location}
**Date:** {date}
**Total Found:** {count} ({npi_count} NPI + {linkedin_count} LinkedIn + {doximity_count} Doximity + {healthgrades_count} Healthgrades)

## Top Candidates (Score 7+)
| # | Name | Credential | Specialty | City | Phone | Score | LinkedIn | Doximity | Healthgrades |
|---|------|-----------|-----------|------|-------|-------|----------|--------------|
...

## Worth Contacting (Score 4-6)
| # | Name | Credential | Specialty | City | Phone | Score | Doximity | Healthgrades |
...

## All Candidates (Full Data)
[detailed section with match_reason and outreach_line for top candidates]
```

### Step 9 — Update Tracker
Append new candidates to `data/candidates.md` (skip if NPI already exists in file):

```
| {name} | {credential} | {specialty} | {city}, {state} | {phone} | {score} | {doximity_url} | {healthgrades_url} | {job_title} | {date} |
```

### Step 10 — Show Summary in Chat
Output a clean table of top candidates (score 7+) directly in the chat response, plus a link to the full report file.

---

## Data Files

### data/candidates.md
Running tracker of all candidates ever found. Headers:
`| Name | Credential | Specialty | Location | Phone | Score | Doximity | Healthgrades | Job | Date |`

---

## Commands

| User says | What to do |
|-----------|-----------|
| Pastes JD | Run full workflow above |
| `find [specialty] in [location]` | Skip Step 1, use provided params directly |
| `show candidates` | Read and display data/candidates.md |
| `draft outreach for [name]` | Write a full personalized outreach message for that candidate |
| `export csv` | Convert data/candidates.md to CSV format and show it |
| `clear` | Archive current data/candidates.md and start fresh |

---

## Important Rules
- NEVER hardcode candidate data — always run the scripts fresh
- If a script returns 0 results, say so and suggest alternative taxonomy terms to try
- If Playwright scraping fails (site blocked), note it and continue with other sources
- Practice phone from NPI is a CLINIC phone, not personal — always label it "Practice"
- Doximity profiles are publicly listed — no login required for directory search
- Always remind the user that NPI data is public federal data, Doximity/Healthgrades are public profiles
