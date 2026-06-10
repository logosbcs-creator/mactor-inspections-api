const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Build Inspector MacTor's photo analysis prompt.
 * Context-aware: adapts for repair vs new project, category, and description.
 */
const LANG_NAMES = {
  en: 'English',
  es: 'Spanish',
  zh: 'Chinese (Simplified)',
  hi: 'Hindi',
  tl: 'Filipino (Tagalog)',
};

function buildRepairPrompt(category, problemDescription, lang) {
  const catName = category && category !== 'other' ? category.replace('_', ' ') : 'general maintenance';
  const contextLine = problemDescription
    ? `Client description: "${problemDescription}"\nIssue category: ${catName}`
    : 'Performing a general property repair inspection.';
  const outputLang = LANG_NAMES[lang] || 'English';

  return `You are Inspector MacTor, an experienced property inspector for FixMyProperty in the Greater Toronto Area (GTA), Canada.

${contextLine}

Analyze this property photo and return ONLY valid JSON with this exact structure:

{
  "area_detected": "kitchen|bathroom|bedroom|living_room|hallway|exterior|basement|electrical|plumbing|hvac|floor|window|wall_ceiling|roof|other",
  "overall_condition": "excellent|good|needs_maintenance|needs_renovation|critical",
  "observed_defects": [
    {
      "defect_type": "specific defect name",
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
- Focus on ${catName} issues but also flag any visible safety concerns
- observed_defects: max 2 items — most important only
- If no real problem visible: empty observed_defects array, priority_level "no_issues"
- IMPORTANT: Write ALL text values (defect_type, location, danger_if_ignored, recommended_action, inspector_note) in ${outputLang}
- JSON keys must stay in English; only the values are translated
- No text outside the JSON`;
}

function buildNewProjectPrompt(problemDescription, lang) {
  const contextLine = problemDescription
    ? `Client's project request: "${problemDescription}"`
    : 'Client wants to start a new construction or renovation project.';
  const outputLang = LANG_NAMES[lang] || 'English';

  return `You are Inspector MacTor, an experienced property inspector for FixMyProperty in the Greater Toronto Area (GTA), Canada.

${contextLine}

The client has shared a photo of the SITE or SPACE where the work will be done.
Your job is to DESCRIBE the site — NOT to look for defects or damage.
Focus on what is visible that is relevant for planning and quoting the project.

Return ONLY valid JSON with this exact structure:

{
  "area_detected": "kitchen|bathroom|bedroom|living_room|hallway|exterior|basement|floor|wall_ceiling|roof|outdoor|other",
  "overall_condition": "excellent|good|needs_preparation",
  "site_observations": [
    {
      "aspect": "what element or condition is visible",
      "detail": "precise description of what you see",
      "project_relevance": "why this matters for planning or executing the project"
    }
  ],
  "estimated_dimensions": "approximate area size if visible (e.g. '10×12 ft') or 'undetermined'",
  "access_notes": "brief note on site access, clearance, or obstacles if visible",
  "inspector_note": "one sentence honest site summary in MacTor's voice, useful for the contractor"
}

RULES:
- site_observations: max 3 items — most relevant to the project only
- Do NOT look for damage or defects — this is a project scope assessment, not a repair inspection
- If nothing useful is visible, return empty site_observations array
- IMPORTANT: Write ALL text values (aspect, detail, project_relevance, access_notes, inspector_note) in ${outputLang}
- JSON keys must stay in English; only the values are translated
- No text outside the JSON`;
}

function buildPrompt(category, problemDescription, serviceType = 'repair', lang = 'en') {
  if (serviceType === 'new_project') {
    return buildNewProjectPrompt(problemDescription, lang);
  }
  return buildRepairPrompt(category, problemDescription, lang);
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
 * @param {string} [serviceType] - 'repair' | 'new_project'
 */
async function analyzePhoto(base64Image, mediaType = 'image/jpeg', category = null, problemDescription = null, serviceType = 'repair', lang = 'en') {
  let normalizedType = mediaType;
  if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mediaType)) {
    normalizedType = 'image/jpeg';
  }

  const prompt = buildPrompt(category, problemDescription, serviceType, lang);
  console.log(`[MacTor Vision] Analyzing photo | type: ${normalizedType} | service: ${serviceType} | lang: ${lang} | category: ${category || 'general'} | size: ${Math.round(base64Image.length * 0.75 / 1024)}KB`);

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
