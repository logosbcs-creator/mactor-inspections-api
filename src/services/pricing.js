const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const prisma = require('./database');

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function getTrainingContext(propertyType) {
  const recent = await prisma.trainingData.findMany({
    where: { propertyType },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  if (recent.length === 0) return '';
  const examples = recent.map(t =>
    `• ${t.damageType}: IA sugirió $${t.aiPriceSuggested} → Aprobado $${t.julioApprovedPrice}${t.julioNote ? ` (nota: ${t.julioNote})` : ''}`
  ).join('\n');
  return `\nHISTORIAL DE PRECIOS APROBADOS POR MACTOR:\n${examples}\n`;
}

function buildPricingPrompt(defects, propertyType, trainingContext) {
  const defectList = defects.map((d, i) =>
    `${i + 1}. [${d.area || 'general'}] ${d.defect_type} — severidad: ${d.severity}`
  ).join('\n');

  return `Eres un estimador de costos de MacTor Construction en GTA Toronto, Canadá, 2026.

REGLA PRINCIPAL: Piensa como un contratista real, NO como una IA que cotiza cada defecto por separado.
Agrupa los daños por ÁREA DE TRABAJO. Un técnico puede resolver varios defectos de la misma área en una sola visita.
Genera entre 2 y 5 ítems máximo, bien agrupados. Nunca más de 1 ítem por área de trabajo.

TIPO DE PROPIEDAD: ${propertyType === 'commercial' ? 'Comercial (+20-30%)' : 'Residencial'}
${trainingContext}
DAÑOS DETECTADOS:
${defectList}

TARIFAS REALES GTA 2026 (mantenimiento general residencial):
- Handyman / mantenimiento general: $65–$80/hora
- Plomería menor / caulking / baño: $75–$90/hora
- Pintura y resane de paredes: $65–$75/hora
- Materiales de hogar: usar precios reales de Home Depot / Rona Canadá

EJEMPLO de cómo agrupar (NO copies esto, es solo referencia de lógica):
- "Baño: remover moho, reemplazar caulking, limpiar grifo" → 2 horas labor + $35 materiales = ~$185
- "Pared: resanar agujeros, lijar, primer, pintura touch-up" → 1.5 horas + $45 materiales = ~$157

Responde SOLO con JSON válido, sin texto adicional:
{
  "line_items": [
    {
      "defect_type": "nombre del grupo de trabajo (área)",
      "description": "qué trabajos incluye exactamente",
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
  "disclaimer": "Este estimado es aproximado y puede variar según inspección presencial."
}`;
}

async function generateWithClaude(defects, propertyType) {
  const trainingContext = await getTrainingContext(propertyType);
  const prompt = buildPricingPrompt(defects, propertyType, trainingContext);

  console.log('[Pricing] Calling Claude for estimate...');
  const response = await claude.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 3000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content.find(b => b.type === 'text')?.text?.trim();
  console.log('[Pricing] Claude response length:', text?.length);

  const match = text?.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No valid JSON from Claude pricing');
  const result = JSON.parse(match[0]);
  console.log('[Pricing] Claude line items:', result.line_items?.length, '| Total:', result.total);
  return { ...result, engine: 'claude-opus-4-8' };
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

async function generateEstimate(defects, propertyType) {
  console.log(`[Pricing] Generating estimate for ${defects.length} defects, type: ${propertyType}`);

  const [claudeResult, openaiResult] = await Promise.allSettled([
    generateWithClaude(defects, propertyType),
    generateWithOpenAI(defects, propertyType),
  ]);

  if (claudeResult.status === 'rejected') console.error('[Pricing] Claude failed:', claudeResult.reason?.message);
  if (openaiResult.status === 'rejected') console.error('[Pricing] OpenAI failed:', openaiResult.reason?.message);

  const claudeVal = claudeResult.status === 'fulfilled' ? claudeResult.value : null;
  const openaiVal = openaiResult.status === 'fulfilled' ? openaiResult.value : null;

  return {
    claude: claudeVal,
    openai: openaiVal,
    recommended: claudeVal || openaiVal,
  };
}

module.exports = { generateEstimate };
