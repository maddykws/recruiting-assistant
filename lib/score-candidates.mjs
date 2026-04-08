import Anthropic from '@anthropic-ai/sdk';

/**
 * Scores candidates against a parsed job description using Claude Haiku.
 * Batches up to 10 candidates per API call for efficiency.
 */

const BATCH_SIZE = 10;

/**
 * Score a batch of candidates against the job description.
 * @param {Object} parsedJd - Parsed job description
 * @param {Array} candidates - Array of candidate objects (max 10)
 * @param {Anthropic} client - Anthropic SDK client
 * @returns {Promise<Array>} Candidates with score, match_reason, outreach_line added
 */
async function scoreBatch(parsedJd, candidates, client) {
  const candidateList = candidates.map((c, i) => {
    const parts = [
      `${i + 1}. ${c.full_name}`,
      `   Specialty: ${c.specialty || 'Unknown'}`,
      `   Credential: ${c.credential || 'Unknown'}`,
      `   Location: ${[c.city, c.state].filter(Boolean).join(', ') || 'Unknown'}`,
    ];
    if (c.hospital_affiliation) parts.push(`   Affiliation: ${c.hospital_affiliation}`);
    if (c.rating) parts.push(`   Patient Rating: ${c.rating}/5`);
    return parts.join('\n');
  }).join('\n\n');

  const prompt = `You are a healthcare recruiter evaluating physician candidates for a specific job opening.

JOB REQUIREMENTS:
- Title: ${parsedJd.job_title}
- Specialty: ${parsedJd.specialty}${parsedJd.subspecialty ? ` (${parsedJd.subspecialty})` : ''}
- Location: ${parsedJd.location || 'Flexible'}
- Min Experience: ${parsedJd.experience_years || 0} years
- Key Requirements: ${parsedJd.keywords.slice(0, 8).join(', ')}
- Summary: ${parsedJd.summary}

CANDIDATES TO EVALUATE:
${candidateList}

Score each candidate 1-10 based on specialty match, location match, and likely fit.
Return ONLY a JSON array with one object per candidate in the same order:
[
  {
    "score": 8,
    "match_reason": "Board-certified radiologist with interventional focus, practicing in target location",
    "outreach_line": "Hi Dr. Smith, I noticed your interventional radiology practice at Memorial Hospital and have an exciting opportunity that aligns with your expertise."
  },
  ...
]

Scoring guide:
- 9-10: Perfect specialty + location match
- 7-8: Strong match, minor location or subspecialty gap
- 5-6: Partial match (related specialty or nearby location)
- 3-4: Weak match, different specialty but adjacent
- 1-2: Poor fit

Keep match_reason under 15 words. Keep outreach_line under 25 words, personalized and professional.`;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  });

  const content = message.content[0].text.trim();

  // Extract JSON array
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ||
    content.match(/(\[[\s\S]*\])/);

  if (!jsonMatch) {
    console.error('[Scoring] Failed to parse JSON from Claude response:', content.substring(0, 200));
    // Return candidates with default score
    return candidates.map(c => ({
      ...c,
      score: 5,
      match_reason: 'Unable to score — manual review needed',
      outreach_line: `Hi ${c.first_name || 'Dr.'}, I have an opportunity that may interest you.`,
    }));
  }

  let scores;
  try {
    scores = JSON.parse(jsonMatch[1] || jsonMatch[0]);
  } catch (err) {
    console.error('[Scoring] JSON parse error:', err.message);
    return candidates.map(c => ({
      ...c,
      score: 5,
      match_reason: 'Scoring error — manual review needed',
      outreach_line: `Hi ${c.first_name || 'Dr.'}, I have an opportunity that may interest you.`,
    }));
  }

  // Merge scores back into candidates
  return candidates.map((c, i) => {
    const s = scores[i] || {};
    return {
      ...c,
      score: typeof s.score === 'number' ? Math.max(1, Math.min(10, Math.round(s.score))) : 5,
      match_reason: s.match_reason || '',
      outreach_line: s.outreach_line || '',
    };
  });
}

/**
 * Score all candidates, processing in batches.
 * @param {Object} parsedJd - Parsed job description
 * @param {Array} candidates - All candidates (from all sources)
 * @param {Anthropic} client - Anthropic SDK client
 * @param {Function} onStatus - Status callback
 * @returns {Promise<Array>} All candidates with scores, sorted descending by score
 */
export async function scoreCandidates(parsedJd, candidates, client, onStatus = () => {}) {
  if (candidates.length === 0) return [];

  onStatus(`Scoring ${candidates.length} candidates with Claude...`);

  const batches = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    batches.push(candidates.slice(i, i + BATCH_SIZE));
  }

  const scoredBatches = [];
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    onStatus(`Scoring batch ${i + 1}/${batches.length} (${batch.length} candidates)...`);
    try {
      const scored = await scoreBatch(parsedJd, batch, client);
      scoredBatches.push(...scored);
    } catch (err) {
      console.error(`[Scoring] Batch ${i + 1} error:`, err.message);
      // Return unscored if batch fails
      scoredBatches.push(...batch.map(c => ({
        ...c,
        score: 5,
        match_reason: 'Scoring unavailable',
        outreach_line: '',
      })));
    }
  }

  // Sort by score descending
  scoredBatches.sort((a, b) => (b.score || 0) - (a.score || 0));

  onStatus(`Scoring complete. Top score: ${scoredBatches[0]?.score || 'N/A'}/10`);

  return scoredBatches;
}
