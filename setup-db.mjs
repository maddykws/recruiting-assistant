#!/usr/bin/env node
/**
 * setup-db.mjs — Initialize SQLite database and seed with sample data
 *
 * Run:  node setup-db.mjs
 * DB:   data/recruiting.db  (open with DB Browser for SQLite)
 */

import { initDb, insertJob, insertSearch, upsertCandidate, insertScore, getDb, DB_PATH } from './lib/db.mjs';

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Recruiting Assistant — Database Setup');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// 1. Create all tables
initDb();

const db = getDb();

// ─── Seed: Sample job (Radiologist in New York) ────────────────────────────
console.log('\n[1/4] Seeding jobs...');

const jobId = insertJob({
  title: 'Diagnostic Radiologist',
  specialty: 'Radiology',
  subspecialty: 'Diagnostic Radiology',
  state_code: 'NY',
  city: 'New York',
  location: 'New York, NY',
  experience_years: 3,
  requirements: [
    'MD or DO degree',
    'Board certified or board eligible in Radiology',
    'Active NY medical license',
    '3+ years post-residency experience',
    'Proficiency in CT, MRI, X-ray interpretation',
  ],
  nice_to_haves: [
    'Fellowship training in a subspecialty',
    'Experience with interventional procedures',
    'Academic or teaching hospital experience',
  ],
  raw_jd: 'Seeking a skilled Diagnostic Radiologist for a leading New York hospital. The ideal candidate is board-certified with 3+ years of experience interpreting CT, MRI, and X-ray studies.',
  source: 'manual',
});
console.log(`  → Job #${jobId}: Diagnostic Radiologist (New York, NY)`);

// ─── Seed: Search run record ───────────────────────────────────────────────
console.log('\n[2/4] Seeding search history...');

const searchId = insertSearch({
  job_id: jobId,
  specialty: 'Radiology',
  state_code: 'NY',
  city: 'New York',
  npi_count: 10,
  linkedin_count: 10,
  doximity_count: 10,
  healthgrades_count: 10,
});
console.log(`  → Search #${searchId}: 40 total candidates found`);

// ─── Seed: Candidates from live test run ──────────────────────────────────
console.log('\n[3/4] Seeding candidates...');

const candidateData = [
  // NPI Registry results
  { source: 'npi', npi: '1760407068', full_name: 'Dr. Adel Abadir', first_name: 'Adel', last_name: 'Abadir', credential: 'MD', specialty: 'Radiology', city: 'Middletown', state: 'NY', zip: '10940', address: '707 E Main St, Orange Regional Medical Center', phone: '8453331258' },
  { source: 'npi', npi: '1710305081', full_name: 'Dr. Valentino Abballe', first_name: 'Valentino', last_name: 'Abballe', credential: 'M.D.', specialty: 'Radiology', city: 'New York', state: 'NY', zip: '10016', address: '550 1st Ave, NYU Langone Medical Center', phone: '2122635506' },
  // Doximity results
  { source: 'doximity', full_name: 'David Paul Naidich MD', credential: 'MD', specialty: 'Radiology', city: 'New York', state: 'NY', doximity_url: 'https://www.doximity.com/pub/david-naidich-md' },
  { source: 'doximity', full_name: 'Julie Sharon Mitnick MD', credential: 'MD', specialty: 'Radiology', city: 'New York', state: 'NY', doximity_url: 'https://www.doximity.com/pub/julie-mitnick-md' },
  { source: 'doximity', full_name: 'Jerold Kurzban MD', credential: 'MD', specialty: 'Radiology', city: 'New York', state: 'NY', doximity_url: 'https://www.doximity.com/pub/jerold-kurzban-md' },
  { source: 'doximity', full_name: 'Ami A Shah MD', credential: 'MD', specialty: 'Radiology', city: 'New York', state: 'NY', doximity_url: 'https://www.doximity.com/pub/ami-shah-md' },
  { source: 'doximity', full_name: 'Michael Joseph King MD', credential: 'MD', specialty: 'Radiology', city: 'New York', state: 'NY', doximity_url: 'https://www.doximity.com/pub/michael-king-md-4f6f7fa7' },
  { source: 'doximity', full_name: 'John K Lyo MD', credential: 'MD', specialty: 'Radiology', city: 'New York', state: 'NY', doximity_url: 'https://www.doximity.com/pub/john-lyo-md' },
  { source: 'doximity', full_name: 'H Charles Pfaff MD', credential: 'MD', specialty: 'Radiology', city: 'New York', state: 'NY', doximity_url: 'https://www.doximity.com/pub/h-pfaff-md' },
  { source: 'doximity', full_name: 'Joshua L Chaim DO', credential: 'DO', specialty: 'Radiology', city: 'New York', state: 'NY', doximity_url: 'https://www.doximity.com/pub/joshua-chaim-do' },
  { source: 'doximity', full_name: 'Ariel Lewis MD', credential: 'MD', specialty: 'Radiology', city: 'New York', state: 'NY', doximity_url: 'https://www.doximity.com/pub/ariel-lewis-md' },
  { source: 'doximity', full_name: 'Danny Kim MD MMM', credential: 'MD', specialty: 'Radiology', city: 'New York', state: 'NY', doximity_url: 'https://www.doximity.com/pub/danny-kim-md' },
  // Healthgrades results
  { source: 'healthgrades', full_name: 'Dr. Martin Fleischer', credential: 'MD', specialty: 'Radiology', city: 'New York', state: 'NY', address: '11 E 68th St #8W, New York, NY 10065', phone: '2122888008', healthgrades_url: 'https://www.healthgrades.com/physician/dr-martin-fleischer-wddsb' },
  { source: 'healthgrades', full_name: 'Dr. Barbara Edelstein', credential: 'MD', specialty: 'Diagnostic Radiology', city: 'New York', state: 'NY', address: '1045 Park Ave, New York, NY 10028', phone: '2128607700', rating: 5.0, healthgrades_url: 'https://www.healthgrades.com/physician/dr-barbara-edelstein-2r5wg' },
  { source: 'healthgrades', full_name: 'Dr. Richard Katz', credential: 'MD', specialty: 'Radiology', city: 'New York', state: 'NY', address: '519 E 72nd St, New York, NY 10021', phone: '2122881575', healthgrades_url: 'https://www.healthgrades.com/physician/dr-richard-katz-3ky8k' },
  { source: 'healthgrades', full_name: 'Dr. David Inkeles', credential: 'MD', specialty: 'Radiology', city: 'New York', state: 'NY', address: '230 W 17th St, New York, NY 10011', phone: '2129898999', healthgrades_url: 'https://www.healthgrades.com/physician/dr-david-inkeles-xyxbm' },
  { source: 'healthgrades', full_name: 'Dr. Rajesh Patel', credential: 'MD', specialty: 'Vascular & Interventional Radiology', city: 'New York', state: 'NY', address: '1 Gustave L Levy Pl, New York, NY 10029', phone: '2122418395', healthgrades_url: 'https://www.healthgrades.com/physician/dr-rajesh-patel-yg8j2' },
  { source: 'healthgrades', full_name: 'Dr. Ruth Rosenblatt', credential: 'MD', specialty: 'Radiology', city: 'New York', state: 'NY', address: '525 E 68th St #141, New York, NY 10065', phone: '2127462059', healthgrades_url: 'https://www.healthgrades.com/physician/dr-ruth-rosenblatt-xf9g6' },
  { source: 'healthgrades', full_name: 'Dr. Elizabeth Deperi', credential: 'MD', specialty: 'Radiology', city: 'New York', state: 'NY', address: '61 E 77th St, New York, NY 10075', phone: '2122570075', rating: 5.0, healthgrades_url: 'https://www.healthgrades.com/physician/dr-elizabeth-deperi-yw9ys' },
  { source: 'healthgrades', full_name: 'Dr. Marc Schiffman', credential: 'MD', specialty: 'Radiology', city: 'New York', state: 'NY', address: '525 E 68th St, New York, NY 10065', phone: '3473805834', rating: 5.0, healthgrades_url: 'https://www.healthgrades.com/physician/dr-marc-schiffman-y8km4' },
  { source: 'healthgrades', full_name: 'Dr. Y Gobin', credential: 'MD', specialty: 'Radiology', city: 'New York', state: 'NY', address: '525 E 68th St, New York, NY 10065', phone: '2127464998', rating: 5.0, healthgrades_url: 'https://www.healthgrades.com/physician/dr-y-gobin-x7m8l' },
  { source: 'healthgrades', full_name: 'Dr. Charles Goldfarb', credential: 'MD', specialty: 'Radiology', city: 'New York', state: 'NY', address: '55 E 34th St, New York, NY 10016', phone: '2122570075', healthgrades_url: 'https://www.healthgrades.com/physician/dr-charles-goldfarb-x7lc5' },
  // LinkedIn X-Ray results
  { source: 'linkedin', full_name: 'William Johnson MD', specialty: 'Radiologist', city: 'New York', state: 'NY', linkedin_url: 'https://www.linkedin.com/in/william-johnson-md-9414137' },
  { source: 'linkedin', full_name: 'Laura Bassett Madsen MD', specialty: 'Radiologist', city: 'New York', state: 'NY', linkedin_url: 'https://www.linkedin.com/in/laura-bassett-madsen-md-b5033861' },
  { source: 'linkedin', full_name: 'Charlotte Charbel', specialty: 'Radiologist', city: 'New York', state: 'NY', linkedin_url: 'https://www.linkedin.com/in/charlotte-charbel-170984101' },
  { source: 'linkedin', full_name: 'Jin Ah Kim', specialty: 'Radiologist', city: 'New York', state: 'NY', linkedin_url: 'https://www.linkedin.com/in/jin-ah-kim-03b999110' },
  { source: 'linkedin', full_name: 'Bruce Saffran MD PhD', specialty: 'Radiologist', city: 'New York', state: 'NY', linkedin_url: 'https://www.linkedin.com/in/bruce-saffran-md-ph-d-08032847' },
  { source: 'linkedin', full_name: 'Susan Lee MD', specialty: 'Radiologist', city: 'New York', state: 'NY', linkedin_url: 'https://www.linkedin.com/in/susan-c-lee-md-40149b24' },
  { source: 'linkedin', full_name: 'Richard Friedland FACR', specialty: 'Radiologist', city: 'New York', state: 'NY', linkedin_url: 'https://www.linkedin.com/in/richard-friedland-m-d-facr-269510162' },
];

const idMap = {};
for (const c of candidateData) {
  const id = upsertCandidate(c);
  idMap[c.full_name] = id;
}
console.log(`  → ${Object.keys(idMap).length} candidates inserted/merged`);

// ─── Seed: Scores for top candidates ──────────────────────────────────────
console.log('\n[4/4] Seeding candidate scores...');

const scores = [
  { name: 'Dr. Barbara Edelstein',    score: 9, sp: 4, loc: 3, cr: 2, comp: 0, match: 'Board-certified NYC radiologist with 5-star rating, perfect specialty and location match.', outreach: 'Hi Dr. Edelstein — I\'m recruiting for a Diagnostic Radiology role at a leading New York hospital and your profile at 1045 Park Ave caught my eye.' },
  { name: 'Dr. Elizabeth Deperi',     score: 9, sp: 4, loc: 3, cr: 2, comp: 0, match: 'NYC radiologist with 5-star Healthgrades rating, strong specialty match in Manhattan.', outreach: 'Hi Dr. Deperi — your 5-star Healthgrades profile and NYC practice make you a great fit for a Diagnostic Radiology opportunity I\'m filling in Manhattan.' },
  { name: 'Dr. Marc Schiffman',       score: 9, sp: 4, loc: 3, cr: 2, comp: 0, match: 'Weill Cornell-affiliated radiologist, 5-star rating, multiple NYC locations.', outreach: 'Hi Dr. Schiffman — your work at 525 E 68th St and your 5-star Healthgrades rating stood out for a senior Radiology position I\'m filling nearby.' },
  { name: 'David Paul Naidich MD',    score: 8, sp: 4, loc: 3, cr: 2, comp: 0, match: 'Well-known academic radiologist in New York with Doximity profile confirming active practice.', outreach: 'Hi Dr. Naidich — I\'m reaching out about a Diagnostic Radiology opportunity in New York that aligns well with your academic and clinical background.' },
  { name: 'Dr. Valentino Abballe',    score: 8, sp: 4, loc: 3, cr: 2, comp: 1, match: 'NYU Langone radiologist with NPI and verifiable contact info — strong institutional pedigree.', outreach: 'Hi Dr. Abballe — your role at NYU Langone and your Radiology background make you a strong candidate for an opportunity I\'m filling in Midtown Manhattan.' },
  { name: 'Dr. Rajesh Patel',         score: 8, sp: 4, loc: 3, cr: 2, comp: 1, match: 'Vascular & Interventional subspecialist at Mount Sinai — rare skill set, high demand.', outreach: 'Hi Dr. Patel — your Vascular & Interventional Radiology specialty at Mount Sinai is exactly what my client is looking for. Would love to connect.' },
  { name: 'Dr. Y Gobin',              score: 8, sp: 4, loc: 3, cr: 2, comp: 1, match: 'Weill Cornell radiologist with 5-star Healthgrades rating, strong NYC presence.', outreach: 'Hi Dr. Gobin — your 5-star rating and Radiology practice on E 68th St make you a compelling candidate for a senior radiology role I\'m recruiting for.' },
  { name: 'Julie Sharon Mitnick MD',  score: 7, sp: 4, loc: 3, cr: 2, comp: 0, match: 'Experienced NYC radiologist on Doximity, strong specialty alignment.', outreach: 'Hi Dr. Mitnick — I found your Doximity profile while searching for Radiologists in New York and wanted to share an opportunity that may be of interest.' },
  { name: 'Ami A Shah MD',            score: 7, sp: 4, loc: 3, cr: 2, comp: 0, match: 'NYC-based radiologist with confirmed Doximity listing.', outreach: 'Hi Dr. Shah — your Radiology background in New York is a great match for an opening I\'m filling at a well-regarded NYC health system.' },
  { name: 'William Johnson MD',       score: 6, sp: 4, loc: 2, cr: 1, comp: 0, match: 'LinkedIn-verified radiologist in New York area — name to verify on LinkedIn.', outreach: 'Hi William — I noticed your radiologist background on LinkedIn and wanted to share a Diagnostic Radiology opportunity in New York.' },
  { name: 'Susan Lee MD',             score: 6, sp: 4, loc: 2, cr: 1, comp: 0, match: 'LinkedIn-listed MD in New York radiology space.', outreach: 'Hi Dr. Lee — your LinkedIn profile in radiology caught my attention for a Diagnostic Radiology role I\'m filling in New York.' },
];

let scoredCount = 0;
for (const s of scores) {
  const candidateId = idMap[s.name];
  if (!candidateId) { console.log(`  ⚠ No ID for: ${s.name}`); continue; }
  insertScore({
    candidate_id: candidateId,
    search_id: searchId,
    job_id: jobId,
    score: s.score,
    specialty_pts: s.sp,
    location_pts: s.loc,
    credential_pts: s.cr,
    completeness_pts: s.comp,
    match_reason: s.match,
    outreach_line: s.outreach,
  });
  scoredCount++;
}
console.log(`  → ${scoredCount} candidates scored`);

// ─── Summary ───────────────────────────────────────────────────────────────
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Database ready!');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const stats = {
  jobs:       db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,
  searches:   db.prepare('SELECT COUNT(*) AS n FROM searches').get().n,
  candidates: db.prepare('SELECT COUNT(*) AS n FROM candidates').get().n,
  scores:     db.prepare('SELECT COUNT(*) AS n FROM candidate_scores').get().n,
};

console.log(`  Jobs       : ${stats.jobs}`);
console.log(`  Searches   : ${stats.searches}`);
console.log(`  Candidates : ${stats.candidates}`);
console.log(`  Scores     : ${stats.scores}`);
console.log(`\n  File: ${DB_PATH}`);
console.log('  Open with: DB Browser for SQLite\n');

// ─── Preview: Top candidates ───────────────────────────────────────────────
console.log('  Top candidates (score 7+):');
console.log('  ─────────────────────────────────────────────');
const top = db.prepare(`
  SELECT c.full_name, c.credential, c.specialty, c.city, c.state,
         c.phone, cs.score, c.healthgrades_url, c.doximity_url
  FROM   candidate_scores cs
  JOIN   candidates c ON c.id = cs.candidate_id
  WHERE  cs.score >= 7
  ORDER  BY cs.score DESC, c.full_name
`).all();

for (const r of top) {
  const links = [r.doximity_url ? 'Doximity' : '', r.healthgrades_url ? 'HG' : ''].filter(Boolean).join('+');
  console.log(`  [${r.score}] ${r.full_name} ${r.credential || ''} — ${r.city}, ${r.state} — ${r.phone || 'no phone'} — ${links}`);
}
console.log('');
