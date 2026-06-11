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

  return `You are an expert construction cost estimator for MacTor Maintenance, a professional contractor in the Greater Toronto Area (GTA), Canada. Today is 2026.

PROPERTY TYPE: ${propertyType === 'commercial' ? 'Commercial (apply commercial GTA rates)' : 'Residential (apply residential GTA rates)'}
${trainingContext}
DETECTED ISSUES:
${defectList}

YOUR JOB: Produce a realistic estimate that a professional GTA contractor would actually charge to fix these issues.

THINKING PROCESS:
1. Group defects by work area — a technician fixes multiple issues in the same area in one visit.
2. For each group: what trade is needed? What does that trade charge per hour in GTA right now?
3. How long does it realistically take? What materials are needed and what do they cost in Toronto?
4. Are there implied steps (demo, prep, protection, cleanup) not listed but required? Include them.

RULES:
- 2 to 5 grouped line items maximum — never quote each defect separately
- Use real GTA labor and material costs from your training knowledge
- Commercial jobs get commercial rate premium
- Never underestimate — base every number on what a real Toronto contractor would charge

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
  return `You are an expert construction cost estimator for MacTor Maintenance, a professional contractor in the Greater Toronto Area (GTA), Canada. Today is 2026.

CLIENT REQUEST: "${description}"
${analysisContext ? `\nSITE OBSERVATIONS FROM PHOTOS:\n${analysisContext}` : ''}

PROPERTY TYPE: ${propertyType === 'commercial' ? 'Commercial (apply commercial GTA rates)' : 'Residential (apply residential GTA rates)'}
${trainingContext}

YOUR JOB: Produce a realistic, complete estimate that a professional GTA contractor would actually charge.

THINKING PROCESS — before writing numbers, think through:
1. What trade(s) does this job involve? (painting, tile, flooring, carpentry, plumbing, electrical, drywall, etc.)
2. What is the full scope? Include ALL steps a contractor would do: demo, prep, disposal, protection, installation, finishing, cleanup.
3. What does each step cost in the GTA residential/commercial market right now? Use your knowledge of current Toronto-area labor and material costs.
4. What unit makes sense for each item? Area jobs (sqft), time jobs (hours), fixed tasks (flat fee).
5. Are there scope items implied by the photos that the client didn't mention? Include them.

COMPLETENESS RULES:
- Tile/flooring: if existing material present → always include demo + disposal + subfloor prep
- Painting: if both walls and ceiling → separate line items; if furnished → include furniture & floor protection; if pot lights/fixtures → include masking labor
- Any renovation: include appliance/fixture disconnect/reconnect if applicable
- Always include materials (calculated by area or quantity, not guessed flat)
- Commercial jobs: apply appropriate commercial rate premium

UNIT FORMAT:
- Area-based work: qty = number of sqft, unit_price = $ per sqft
- Time-based work: qty = number of hours, unit_price = $ per hour
- One-time tasks: qty = 1, unit_price = realistic flat fee for that task in GTA

Generate 3–6 line items. Base every number on real GTA market knowledge — never underestimate.

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
