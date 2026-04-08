/**
 * Searches the free NPI Registry API (US government, no auth needed).
 * Endpoint: https://npiregistry.cms.hhs.gov/api/?version=2.1
 */

const NPI_BASE_URL = 'https://npiregistry.cms.hhs.gov/api/';

/**
 * Map common specialty names to NPI taxonomy descriptions.
 * NPI taxonomy uses slightly different terminology.
 */
const SPECIALTY_MAP = {
  'radiology': 'Radiology',
  'internal medicine': 'Internal Medicine',
  'family medicine': 'Family Medicine',
  'family practice': 'Family Medicine',
  'emergency medicine': 'Emergency Medicine',
  'nursing': 'Registered Nurse',
  'registered nurse': 'Registered Nurse',
  'nurse practitioner': 'Nurse Practitioner',
  'physician assistant': 'Physician Assistant',
  'surgery': 'Surgery',
  'cardiology': 'Cardiovascular Disease (Cardiology)',
  'pediatrics': 'Pediatrics',
  'psychiatry': 'Psychiatry & Neurology',
  'neurology': 'Neurology',
  'oncology': 'Hematology & Oncology',
  'orthopedics': 'Orthopedic Surgery',
  'anesthesiology': 'Anesthesiology',
  'obstetrics': 'Obstetrics & Gynecology',
  'gynecology': 'Obstetrics & Gynecology',
  'dermatology': 'Dermatology',
  'ophthalmology': 'Ophthalmology',
  'urology': 'Urology',
  'gastroenterology': 'Gastroenterology',
  'pulmonology': 'Pulmonary Disease',
  'nephrology': 'Nephrology',
  'rheumatology': 'Rheumatology',
  'endocrinology': 'Endocrinology, Diabetes & Metabolism',
  'infectious disease': 'Infectious Disease',
  'physical therapy': 'Physical Therapist',
  'occupational therapy': 'Occupational Therapist',
};

function normalizeTaxonomy(specialty) {
  if (!specialty) return 'Medicine';
  const lower = specialty.toLowerCase();
  return SPECIALTY_MAP[lower] || specialty;
}

/**
 * Parse NPI result into a normalized candidate object.
 */
function parseNpiResult(result) {
  const basic = result.basic || {};
  const taxonomies = result.taxonomies || [];
  const addresses = result.addresses || [];

  // Get primary taxonomy
  const primaryTaxonomy = taxonomies.find(t => t.primary) || taxonomies[0] || {};

  // Get practice/location address
  const locationAddress = addresses.find(a => a.address_purpose === 'LOCATION') ||
    addresses.find(a => a.address_purpose === 'MAILING') ||
    addresses[0] || {};

  const firstName = basic.first_name || basic.authorized_official_first_name || '';
  const lastName = basic.last_name || basic.authorized_official_last_name || '';
  const fullName = [firstName, basic.middle_name, lastName]
    .filter(Boolean)
    .join(' ')
    .trim();

  const credential = basic.credential || primaryTaxonomy.license || '';

  // Phone from location address
  const phone = locationAddress.telephone_number
    ? formatPhone(locationAddress.telephone_number)
    : '';

  return {
    source: 'npi',
    npi: result.number || '',
    first_name: firstName,
    last_name: lastName,
    full_name: fullName || 'Unknown Provider',
    specialty: primaryTaxonomy.desc || primaryTaxonomy.taxonomy_group || 'Unknown',
    credential: credential.replace(/\./g, ''),
    phone: phone,
    city: locationAddress.city || '',
    state: locationAddress.state || '',
    zip: locationAddress.postal_code ? locationAddress.postal_code.substring(0, 5) : '',
    address: [
      locationAddress.address_1,
      locationAddress.address_2,
      locationAddress.city,
      locationAddress.state,
      locationAddress.postal_code,
    ]
      .filter(Boolean)
      .join(', '),
    doximity_url: null,
    healthgrades_url: null,
    email: null,
    score: null,
    match_reason: null,
    outreach_line: null,
    hospital_affiliation: '',
    rating: null,
  };
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

/**
 * Search NPI Registry for individual providers.
 * @param {Object} parsedJd - Parsed JD from parseJobDescription
 * @param {Function} onStatus - Callback for status messages
 * @returns {Promise<Array>} Array of candidate objects
 */
export async function searchNpi(parsedJd, onStatus = () => {}) {
  const taxonomy = normalizeTaxonomy(parsedJd.specialty);
  const stateCode = parsedJd.state_code;

  onStatus(`Searching NPI Registry for ${parsedJd.specialty} providers${stateCode ? ` in ${stateCode}` : ''}...`);

  const params = new URLSearchParams({
    version: '2.1',
    enumeration_type: 'NPI-1',
    taxonomy_description: taxonomy,
    limit: '20',
    skip: '0',
  });

  if (stateCode) {
    params.set('state', stateCode);
  }

  // Also try city if available
  if (parsedJd.city && parsedJd.city.length > 2) {
    params.set('city', parsedJd.city);
  }

  let candidates = [];

  try {
    const url = `${NPI_BASE_URL}?${params.toString()}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'HealthcareRecruitingAssistant/1.0',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`NPI API returned HTTP ${response.status}`);
    }

    const data = await response.json();
    const results = data.results || [];

    candidates = results.map(parseNpiResult).filter(c => c.full_name !== 'Unknown Provider');

    onStatus(`NPI Registry: found ${candidates.length} providers`);

    // If city search returned few results, try state-only search
    if (candidates.length < 5 && parsedJd.city) {
      const paramsStateOnly = new URLSearchParams({
        version: '2.1',
        enumeration_type: 'NPI-1',
        taxonomy_description: taxonomy,
        limit: '20',
        skip: '0',
      });
      if (stateCode) paramsStateOnly.set('state', stateCode);

      const urlStateOnly = `${NPI_BASE_URL}?${paramsStateOnly.toString()}`;
      const resp2 = await fetch(urlStateOnly, {
        headers: { 'User-Agent': 'HealthcareRecruitingAssistant/1.0' },
        signal: AbortSignal.timeout(15000),
      });

      if (resp2.ok) {
        const data2 = await resp2.json();
        const moreResults = (data2.results || []).map(parseNpiResult)
          .filter(c => c.full_name !== 'Unknown Provider');

        // Merge, dedup by NPI
        const existingNpis = new Set(candidates.map(c => c.npi));
        for (const c of moreResults) {
          if (!existingNpis.has(c.npi)) {
            candidates.push(c);
            existingNpis.add(c.npi);
          }
        }
        onStatus(`NPI Registry: found ${candidates.length} providers (expanded search)`);
      }
    }

  } catch (err) {
    onStatus(`NPI Registry error: ${err.message}`);
    console.error('[NPI] Error:', err);
  }

  return candidates;
}
