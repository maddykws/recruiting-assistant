#!/usr/bin/env node
/**
 * search-npi.mjs — NPI Registry fetcher
 * Outputs JSON array to stdout. Progress/errors go to stderr.
 *
 * Usage:
 *   node lib/search-npi.mjs --specialty "Radiology" --state "NY" --limit 50
 *   node lib/search-npi.mjs --specialty "Emergency Medicine" --state "CA" --limit 100 --skip 0
 */

const MAX_TOTAL = 200;
const NPI_API = 'https://npiregistry.cms.hhs.gov/api/';

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
const state = args.state;
const requestedLimit = Math.min(parseInt(args.limit || '50', 10), MAX_TOTAL);
const startSkip = parseInt(args.skip || '0', 10);

if (!specialty || !state) {
  console.error('[NPI] ERROR: --specialty and --state are required');
  console.error('[NPI] Example: node lib/search-npi.mjs --specialty "Radiology" --state "NY"');
  process.exit(1);
}

// --- Build URL ---
function buildUrl(taxonomy, stateCode, limit, skip) {
  const params = new URLSearchParams({
    version: '2.1',
    enumeration_type: 'NPI-1',
    taxonomy_description: taxonomy,
    state: stateCode,
    limit: String(limit),
    skip: String(skip),
  });
  return `${NPI_API}?${params.toString()}`;
}

// --- Format phone ---
function formatPhone(raw) {
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits[0] === '1') {
    return `${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return raw;
}

// --- Parse a single NPI result ---
function parseResult(r) {
  const basic = r.basic || {};
  const taxonomies = r.taxonomies || [];
  const addresses = r.addresses || [];

  const firstName = basic.first_name || '';
  const lastName = basic.last_name || '';
  const credential = basic.credential || '';
  const namePrefix = basic.name_prefix || '';

  // Build full name
  const prefix = namePrefix && !namePrefix.toLowerCase().startsWith('dr') ? namePrefix : 'Dr.';
  const fullName = [prefix, firstName, lastName].filter(Boolean).join(' ').trim();

  // Primary taxonomy
  const primaryTax = taxonomies.find(t => t.primary) || taxonomies[0] || {};
  const specialtyDesc = primaryTax.desc || primaryTax.taxonomy_group || '';

  // Location address (prefer LOCATION over MAILING)
  const locAddr = addresses.find(a => a.address_purpose === 'LOCATION') || addresses[0] || {};
  const phone = formatPhone(locAddr.telephone_number || '');
  const city = locAddr.city || '';
  const stateAddr = locAddr.state || state;
  const zip = locAddr.postal_code ? locAddr.postal_code.slice(0, 5) : '';
  const address = [locAddr.address_1, locAddr.address_2].filter(Boolean).join(', ');

  return {
    source: 'npi',
    npi: r.number || '',
    full_name: fullName,
    first_name: firstName,
    last_name: lastName,
    credential: credential,
    specialty: specialtyDesc,
    phone: phone,
    city: city,
    state: stateAddr,
    zip: zip,
    address: address,
  };
}

// --- Fetch one page ---
async function fetchPage(taxonomy, stateCode, limit, skip) {
  const url = buildUrl(taxonomy, stateCode, limit, skip);
  console.error(`[NPI] GET ${url}`);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return data;
}

// --- Main ---
async function main() {
  console.error(`[NPI] Fetching ${specialty} in ${state}...`);

  const results = [];
  const pageSize = Math.min(requestedLimit, 200);

  // First fetch to get total count
  const firstData = await fetchPage(specialty, state, pageSize, startSkip);
  const resultCount = parseInt(firstData.result_count || '0', 10);

  console.error(`[NPI] Total available: ${resultCount}`);

  if (!firstData.results || firstData.results.length === 0) {
    console.error(`[NPI] No results found for specialty="${specialty}" state="${state}"`);
    console.error(`[NPI] Tip: Try a broader taxonomy term, e.g. "Radiology" instead of "Vascular & Interventional Radiology"`);
    console.log(JSON.stringify([]));
    return;
  }

  // Parse first page
  for (const r of firstData.results) {
    results.push(parseResult(r));
  }
  console.error(`[NPI] Got ${results.length} results so far`);

  // Paginate if we want more and there are more available
  const totalWanted = Math.min(requestedLimit, MAX_TOTAL, resultCount);
  let currentSkip = startSkip + firstData.results.length;

  while (results.length < totalWanted && currentSkip < resultCount) {
    const remaining = totalWanted - results.length;
    const fetchSize = Math.min(remaining, 200);

    console.error(`[NPI] Fetching page at skip=${currentSkip}...`);
    await new Promise(r => setTimeout(r, 300)); // polite delay

    const pageData = await fetchPage(specialty, state, fetchSize, currentSkip);
    if (!pageData.results || pageData.results.length === 0) break;

    for (const r of pageData.results) {
      results.push(parseResult(r));
    }
    currentSkip += pageData.results.length;
    console.error(`[NPI] Got ${results.length} results so far`);
  }

  console.error(`[NPI] Done. Returning ${results.length} providers.`);
  console.log(JSON.stringify(results, null, 2));
}

main().catch(err => {
  console.error(`[NPI] FATAL: ${err.message}`);
  console.log(JSON.stringify([]));
  process.exit(1);
});
