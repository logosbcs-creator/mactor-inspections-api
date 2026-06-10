const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const INSPECTION_PROMPT = `You are a residential maintenance inspector in Toronto, Canada.

Analyze this image and identify THE MOST IMPORTANT problem you see. Just one — the one with the highest severity or the one that most affects habitability or safety.

If there is no real problem (the surface is in good condition), report no_issues.

Return ONLY this valid JSON:

{
  "area_detected": "kitchen|bathroom|bedroom|living_room|hallway|exterior|basement|electrical|plumbing|hvac|floor|window|wall_ceiling|roof|other",
  "overall_condition": "excellent|good|needs_maintenance|needs_renovation|critical",
  "observed_defects": [
    {
      "defect_type": "specific name of the main issue in English",
      "location": "exactly where it is in the image",
      "severity": "low|medium|high|critical",
      "estimated_size": "approximate dimension",
      "confidence": "confirmed|possible|inconclusive",
      "danger_if_ignored": "what happens if not repaired"
    }
  ],
  "priority_level": "no_issues|low|medium|high|critical",
  "recommended_action": "what to do to fix it"
}

RULES:
- observed_defects has exactly 1 element, or 0 if there is no real problem
- Choose the most important problem, do not make an exhaustive list
- Do not include any text outside the JSON`;

function extractTextBlock(content) {
  const textBlock = content.find(block => block.type === 'text');
  if (!textBlock) throw new Error('No text block in Claude response');
  return textBlock.text.trim();
}

async function analyzePhoto(base64Image, mediaType = 'image/jpeg') {
  // Normalize media type — Claude only supports jpeg, png, gif, webp
  let normalizedType = mediaType;
  if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mediaType)) {
    normalizedType = 'image/jpeg';
  }

  console.log(`[Claude Vision] Analyzing photo, type: ${normalizedType}, size: ${Math.round(base64Image.length * 0.75 / 1024)}KB`);

  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: normalizedType, data: base64Image } },
        { type: 'text', text: INSPECTION_PROMPT },
      ],
    }],
  });

  const text = extractTextBlock(response.content);
  console.log(`[Claude Vision] Response length: ${text.length} chars`);

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No valid JSON in response');

  const result = JSON.parse(match[0]);
  console.log(`[Claude Vision] Defects found: ${result.observed_defects?.length || 0}, Priority: ${result.priority_level}`);

  return result;
}

module.exports = { analyzePhoto };
