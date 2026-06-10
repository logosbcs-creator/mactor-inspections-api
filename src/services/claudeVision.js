const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const INSPECTION_PROMPT = `Eres un inspector de mantenimiento residencial en Toronto, Canadá.

Analiza esta imagen e identifica EL PROBLEMA MÁS IMPORTANTE que ves. Solo uno — el que tiene mayor severidad o el que más afecta la habitabilidad o seguridad.

Si no hay ningún problema real (la superficie está en buen estado), reporta no_issues.

Devuelve ÚNICAMENTE este JSON válido:

{
  "area_detected": "kitchen|bathroom|bedroom|living_room|hallway|exterior|basement|electrical|plumbing|hvac|floor|window|wall_ceiling|roof|other",
  "overall_condition": "excellent|good|needs_maintenance|needs_renovation|critical",
  "observed_defects": [
    {
      "defect_type": "nombre concreto del problema principal en español",
      "location": "dónde está exactamente en la imagen",
      "severity": "low|medium|high|critical",
      "estimated_size": "dimensión aproximada",
      "confidence": "confirmed|possible|inconclusive",
      "danger_if_ignored": "qué pasa si no se repara"
    }
  ],
  "priority_level": "no_issues|low|medium|high|critical",
  "recommended_action": "qué hacer para repararlo"
}

REGLAS:
- observed_defects tiene exactamente 1 elemento, o 0 si no hay problema real
- Elige el problema más importante, no hagas una lista exhaustiva
- No incluyas texto fuera del JSON`;

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
