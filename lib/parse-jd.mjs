import Anthropic from '@anthropic-ai/sdk';

/**
 * Parses a job description using Claude Haiku and extracts structured fields.
 * @param {string} jd - Raw job description text
 * @param {Anthropic} client - Anthropic SDK client instance
 * @returns {Promise<Object>} Parsed JD fields
 */
export async function parseJobDescription(jd, client) {
  const prompt = `You are a healthcare recruiting assistant. Parse this job description and extract the following fields as JSON.

Job Description:
${jd}

Return ONLY valid JSON with these exact fields:
{
  "specialty": "Primary medical specialty (e.g. Radiology, Internal Medicine, Nursing, Surgery, Cardiology, Pediatrics, Emergency Medicine, Orthopedics, Neurology, Oncology, etc.)",
  "subspecialty": "Subspecialty or focus area if mentioned (e.g. Interventional Radiology, Critical Care, Pediatric Cardiology) or null if none",
  "location": "City and state in format 'City, ST' (e.g. 'New York, NY') or null if remote/not specified",
  "state_code": "2-letter US state code (e.g. 'NY') or null if not in US or not specified",
  "city": "City name only or null",
  "experience_years": "Minimum years of experience as integer, or 0 if not specified",
  "keywords": ["array", "of", "key", "skills", "certifications", "requirements"],
  "job_title": "Clean job title (e.g. 'Interventional Radiologist', 'ICU Registered Nurse', 'Hospitalist Physician')",
  "summary": "1-sentence description of what they are looking for"
}

For specialty, use standard NPI taxonomy terms where possible (e.g. 'Radiology', 'Internal Medicine', 'Family Medicine', 'Emergency Medicine', 'Anesthesiology', 'Psychiatry', 'Obstetrics & Gynecology', 'Pediatrics', 'Surgery', 'Nursing').
If the role is for a nurse practitioner, use 'Nurse Practitioner'. For PA, use 'Physician Assistant'.`;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  });

  const content = message.content[0].text.trim();

  // Extract JSON from response (handle markdown code blocks if present)
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ||
    content.match(/(\{[\s\S]*\})/);

  if (!jsonMatch) {
    throw new Error('Claude did not return valid JSON from JD parsing');
  }

  const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);

  // Normalize fields
  return {
    specialty: parsed.specialty || 'Medicine',
    subspecialty: parsed.subspecialty || null,
    location: parsed.location || null,
    state_code: parsed.state_code ? parsed.state_code.toUpperCase() : null,
    city: parsed.city || null,
    experience_years: parseInt(parsed.experience_years) || 0,
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
    job_title: parsed.job_title || 'Healthcare Professional',
    summary: parsed.summary || '',
  };
}
