const OpenAI = require('openai');
const prisma = require('./database');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function getTrainingContext(propertyType) {
  const recent = await prisma.trainingData.findMany({
    where: { propertyType },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  if (recent.length === 0) return '';
  const examples = recent.map(t =>
    `• ${t.damageType}: AI suggested $${t.aiPriceSuggested} → Approved $${t.julioApprovedPrice}${t.julioNote ? ` (note: ${t.julioNote})` : ''}`
  ).join('\n');
  return `\nMACTOR APPROVED PRICE HISTORY:\n${examples}\n`;
}

function buildPricingPrompt(defects, propertyType, trainingContext) {
  const defectList = defects.map((d, i) =>
    `${i + 1}. [${d.area || 'general'}] ${d.defect_type} — severity: ${d.severity}`
  ).join('\n');

  return `You are a cost estimator for MacTor Construction in GTA Toronto, Canada, 2026.

MAIN RULE: Think like a real contractor, NOT like an AI quoting each defect separately.
Group the issues by WORK AREA. A technician can resolve multiple defects in the same area in a single visit.
Generate between 2 and 5 items maximum, well grouped. Never more than 1 item per work area.

PROPERTY TYPE: ${propertyType === 'commercial' ? 'Commercial (+20-30%)' : 'Residential'}
${trainingContext}
DETECTED ISSUES:
${defectList}

REAL GTA 2026 RATES (general residential maintenance):
- Handyman / general maintenance: $65–$80/hour
- Minor plumbing / caulking / bathroom: $75–$90/hour
- Painting and wall patching: $65–$75/hour
- Home materials: use real prices from Home Depot / Rona Canada

GROUPING EXAMPLE (do NOT copy this, it is only logic reference):
- "Bathroom: remove mold, replace caulking, clean faucet" → 2 hrs labor + $35 materials = ~$185
- "Wall: patch holes, sand, primer, touch-up paint" → 1.5 hrs + $45 materials = ~$157

Respond ONLY with valid JSON, no additional text:
{
  "line_items": [
    {
      "defect_type": "name of the work group (area)",
      "description": "what work is included exactly",
      "qty": 2.0,
      "unit_price": 75,
      "materials_cost": 35,
      "total": 185,
      "notes": ""
    }
  ],
  "subtotal": 185,
  "hst": 24.05,
  "total": 209.05,
  "currency": "CAD",
  "valid_days": 30,
  "disclaimer": "This estimate is approximate and may vary after an in-person inspection."
}`;
}

async function generateWithOpenAI(defects, propertyType) {
  const trainingContext = await getTrainingContext(propertyType);
  const prompt = buildPricingPrompt(defects, propertyType, trainingContext);

  console.log('[Pricing] Calling OpenAI for estimate...');
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.2,
  });

  const result = JSON.parse(response.choices[0].message.content);
  console.log('[Pricing] OpenAI line items:', result.line_items?.length, '| Total:', result.total);
  return { ...result, engine: 'gpt-4o' };
}

function buildDescriptionBasedPrompt(description, analysisContext, propertyType, trainingContext) {
  return `You are a cost estimator for MacTor Construction in GTA Toronto, Canada, 2026.

A client submitted a repair/maintenance request:
"${description}"
${analysisContext ? `\nPhoto inspection notes: ${analysisContext}` : ''}

MAIN RULE: Think like a real contractor. Quote the work the client is asking for.
Group logically — never more than 4 line items total.

PROPERTY TYPE: ${propertyType === 'commercial' ? 'Commercial (+20-30%)' : 'Residential'}
${trainingContext}
REAL GTA 2026 RATES:
- Handyman / general maintenance: $65–$80/hour
- Minor plumbing / caulking / bathroom: $75–$90/hour
- Painting and wall patching: $65–$75/hour
- Materials: use real prices from Home Depot / Rona Canada

Respond ONLY with valid JSON, no additional text:
{
  "line_items": [
    {
      "defect_type": "name of the work group (area)",
      "description": "what work is included exactly",
      "qty": 2.0,
      "unit_price": 75,
      "materials_cost": 35,
      "total": 185,
      "notes": ""
    }
  ],
  "subtotal": 185,
  "hst": 24.05,
  "total": 209.05,
  "currency": "CAD",
  "valid_days": 30,
  "disclaimer": "This estimate is approximate and may vary after an in-person inspection."
}`;
}

async function generateEstimateFromDescription(description, analysisContext, propertyType) {
  console.log(`[Pricing] Generating description-based estimate, type: ${propertyType}`);
  const trainingContext = await getTrainingContext(propertyType);
  const prompt = buildDescriptionBasedPrompt(description, analysisContext, propertyType, trainingContext);

  console.log('[Pricing] Calling OpenAI for description-based estimate...');
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.2,
  });

  const result = { ...JSON.parse(response.choices[0].message.content), engine: 'gpt-4o' };
  console.log('[Pricing] OpenAI line items:', result.line_items?.length, '| Total:', result.total);
  return { openai: result, recommended: result };
}

async function generateEstimate(defects, propertyType) {
  console.log(`[Pricing] Generating estimate for ${defects.length} defects, type: ${propertyType}`);
  const result = await generateWithOpenAI(defects, propertyType);
  return { openai: result, recommended: result };
}

module.exports = { generateEstimate, generateEstimateFromDescription };
