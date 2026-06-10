const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Build Inspector MacTor's photo analysis prompt.
 * Context-aware when category + description are provided.
 */
function buildPrompt(category, problemDescription) {
  const catName = category && category !== 'other' ? category.replace('_', ' ') : 'general maintenance';
  const contextLine = problemDescription
    ? `The client described their problem as: "${problemDescription}"\nIdentified issue category: ${catName}`
    : `Performing a general property inspection.`;

  return `You are Inspector MacTor, an experienced property inspector for FixMyProperty in the Greater Toronto Area (GTA), Canada.

${contextLine}

Analyze this property photo and return ONLY valid JSON with this exact structure:

{
  "area_detected": "kitchen|bathroom|bedroom|living_room|hallway|exterior|basement|electrical|plumbing|hvac|floor|window|wall_ceiling|roof|other",
  "overall_condition": "excellent|good|needs_maintenance|needs_renovation|critical",
  "observed_defects": [
    {
      "defect_type": "specific name of the defect in English",
      "location": "exactly where it appears in the image",
      "severity": "low|medium|high|critical",
      "estimated_size": "approximate dimension or 'unknown'",
      "confidence": "confirmed|possible|inconclusive",
      "danger_if_ignored": "plain-language consequence if not repaired"
    }
  ],
  "priority_level": "no_issues|low|medium|high|critical",
  "recommended_action": "single most important repair action",
  "inspector_note": "one sentence honest plain-language observation in MacTor's voice"
}

RULES:
- Focus on ${catName} issues but flag any other visible safety concerns
- observed_defects: max 2 items — most important only
- If no real problem visible: empty observed_defects array, priority_level "no_issues"
- No text outside the JSON`;
}

function extractTextBlock(content) {
  const textBlock = content.find(block => block.type === 'text');
  if (!textBlock) throw new Error('No text block in Claude response');
  return textBlock.text.trim();
}

/**
 * Analyze a single property photo with Inspector MacTor.
 * @param {string} base64Image - base64-encoded image
 * @param {string} mediaType   - MIME type
 * @param {string} [category]  - IssueCategory from character.ts
 * @param {string} [problemDescription] - client's free-text description
 */
async function analyzePhoto(base64Image, mediaType = 'image/jpeg', category = null, problemDescription = null) {
  let normalizedType = mediaType;
  if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mediaType)) {
    normalizedType = 'image/jpeg';
  }

  const prompt = buildPrompt(category, problemDescription);
  console.log(`[MacTor Vision] Analyzing photo | type: ${normalizedType} | category: ${category || 'general'} | size: ${Math.round(base64Image.length * 0.75 / 1024)}KB`);

  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: normalizedType, data: base64Image } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  const text = extractTextBlock(response.content);
  console.log(`[MacTor Vision] Response: ${text.length} chars`);

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No valid JSON in Claude response');

  const result = JSON.parse(match[0]);
  console.log(`[MacTor Vision] Defects: ${result.observed_defects?.length || 0} | Priority: ${result.priority_level}`);

  return result;
}

module.exports = { analyzePhoto };
