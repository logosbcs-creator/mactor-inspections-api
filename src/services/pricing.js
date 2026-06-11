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

CLIENT REQUEST: "${description}"
${analysisContext ? `\nSITE OBSERVATIONS FROM PHOTOS:\n${analysisContext}` : ''}

RULE #1 — COMPLETE JOB: Never quote only what the client literally typed. A real contractor quotes every step required to finish the job professionally.

RULE #2 — UNIT TYPES: Choose the right unit for each trade:
  - Area work (tile demo, tile install, flooring, painting sqft): qty = sqft, unit_price = $/sqft
  - Time work (prep, masking, furniture moving, misc): qty = hours, unit_price = $/hour
  - Fixed items (disposal, subfloor leveling, appliance disconnect): qty = 1, unit_price = flat fee

RULE #3 — SCOPE BY TRADE (mandatory items to include):
  Tile / flooring:
    ✓ Demo of existing tile/flooring: $3.50–$5.00/sqft labor
    ✓ Debris disposal/haul-away: $150–$250 flat
    ✓ Subfloor inspection & prep (patching, leveling): $150–$300 flat
    ✓ Tile installation labor: $8–$12/sqft
    ✓ Installation materials (thinset, grout, spacers, sealer): $1.50–$2.50/sqft
    ✓ Appliance/fixture disconnect & reconnect if kitchen/bath: $100–$200 flat
    ✓ Cuts around cabinets and obstacles included in install rate

  Painting:
    ✓ Walls and ceiling as SEPARATE line items if both requested
    ✓ Furniture moving & floor protection if furnished room: 2–4 hrs
    ✓ Masking & cutting-in around pot lights, TV mounts, fixtures: 1–3 hrs
    ✓ Labor rate: $65–$75/hr; 1 painter does ~150–200 sqft/hr (finish coat)
    ✓ Materials: 1 gallon = 350 sqft coverage; 2 coats needed; $70–$90/gal (Benjamin Moore)
    ✓ Sundries (tape, plastic, drop cloths): $40–$80 flat

  Kitchen / bathroom renovation:
    ✓ Always include demo, disposal, and reinstall of removed items
    ✓ If plumbing visible or needed: $75–$95/hr licensed plumber
    ✓ Appliance disconnect & reconnect: $100–$200 flat

PROPERTY TYPE: ${propertyType === 'commercial' ? 'Commercial (+20-30%)' : 'Residential'}
${trainingContext}
GTA 2026 RATES SUMMARY:
- General labor: $65–$80/hr | Painting: $65–$75/hr | Plumbing: $75–$95/hr
- Tile demo: $3.50–$5/sqft | Tile install: $8–$12/sqft
- Disposal/haul-away: $150–$250 flat | Subfloor prep: $150–$300 flat
- Paint: $70–$90/gal | Tile materials: $1.50–$2.50/sqft

Generate 3–6 line items. NEVER underquote — a $2,000 tile job quoted at $500 loses the company money.

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
