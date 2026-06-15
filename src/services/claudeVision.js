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
  const outputLang = LANG_NAMES[lang] || 'English';
  const clientRequest = problemDescription
    ? `The client's request: "${problemDescription}"`
    : 'The client is requesting a general repair or maintenance service.';

  return `You are Inspector MacTor, a contractor for FixMyProperty in the Greater Toronto Area (GTA), Canada.

${clientRequest}

YOUR ONLY JOB: Use the photo to understand site conditions FOR WHAT THE CLIENT SPECIFICALLY ASKED.
- Use the photo to identify: materials, dimensions, and current condition of what the client wants worked on
- DO NOT report anything unrelated to the client's request
- If the client says "paint my fence", look at the fence only — ignore the garden, trees, neighbors, anything else
- The photo is evidence for quoting the client's specific request, nothing more

Return ONLY valid JSON with this exact structure:

{
  "area_detected": "kitchen|bathroom|bedroom|living_room|hallway|exterior|basement|electrical|plumbing|hvac|floor|window|wall_ceiling|roof|other",
  "overall_condition": "excellent|good|needs_maintenance|needs_renovation|critical",
  "observed_defects": [
    {
      "defect_type": "observation relevant to the client's request",
      "location": "where in the photo this is visible",
      "severity": "low|medium|high|critical",
      "estimated_size": "approximate dimension or 'unknown'",
      "confidence": "confirmed|possible|inconclusive",
      "danger_if_ignored": "impact on the requested work if this is not addressed"
    }
  ],
  "priority_level": "no_issues|low|medium|high|critical",
  "recommended_action": "next step to fulfill the client's specific request",
  "inspector_note": "one sentence about site conditions relevant to what the client wants, in MacTor's voice"
}

RULES:
- observed_defects: max 2 items — ONLY observations that directly affect what the client asked for
- IGNORE everything in the photo that is NOT related to the client's request
- If photo confirms good conditions for the requested work: empty observed_defects, priority_level "no_issues"
- Write ALL text values in ${outputLang}
- JSON keys must stay in English; only the values are translated
- No text outside the JSON`;
}

function buildNewProjectPrompt(problemDescription, lang) {
  const outputLang = LANG_NAMES[lang] || 'English';
  const projectContext = problemDescription
    ? `The client is requesting: "${problemDescription}"`
    : 'The client wants a quote for a new construction or renovation project.';

  return `You are Inspector MacTor, an experienced property inspector and contractor for FixMyProperty in the Greater Toronto Area (GTA), Canada.

${projectContext}

The client has also shared a photo of the site or space where the work will be done.

YOUR PRIMARY JOB: Understand and summarize what the client is asking for based on their written request.
The photo is SECONDARY context — use it only to add relevant site details that help with quoting.
Do NOT analyze for defects or damage.

Return ONLY valid JSON with this exact structure:

{
  "area_detected": "kitchen|bathroom|bedroom|living_room|hallway|exterior|basement|floor|wall_ceiling|roof|outdoor|other",
  "overall_condition": "excellent|good|needs_preparation",
  "site_observations": [
    {
      "aspect": "specific element visible in the photo relevant to the project",
      "detail": "precise description of what you see",
      "project_relevance": "how this affects the scope or cost of the requested work"
    }
  ],
  "estimated_dimensions": "approximate area size if visible (e.g. '10×12 ft') or 'undetermined'",
  "access_notes": "brief note on site access, clearance, or obstacles if visible",
  "inspector_note": "one sentence summary for the contractor: what the client wants + key site context"
}

RULES:
- site_observations: max 2 items — only the most relevant to the client's request, synthesized and concise
- Combine similar elements into one observation rather than listing separately
- Do NOT report defects or damage unless they directly affect the feasibility of the project
- If the photo adds no useful context, return empty site_observations array
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
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
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
