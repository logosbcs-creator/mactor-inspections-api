const WEBHOOK_URL = process.env.GOOGLE_SHEETS_WEBHOOK_URL;

const CATEGORY_LABELS = {
  plumbing:      'Plomería',
  electrical:    'Eléctrico',
  structural:    'Estructural',
  hvac:          'HVAC / Calefacción',
  roofing:       'Techo',
  water_damage:  'Daño por agua',
  pests:         'Plagas',
  doors_windows: 'Puertas / Ventanas',
  exterior:      'Exterior',
  other:         'Otro',
};

async function appendClientToSheet(inspection, estadoLabel) {
  if (!WEBHOOK_URL) return;

  const total = inspection.approvedEstimate?.line_items
    ?.reduce((sum, item) => sum + (item.total || 0), 0) || 0;

  const payload = {
    fecha:       new Date().toISOString().split('T')[0],
    nombre:      inspection.clientName    || '',
    telefono:    inspection.clientPhone   || '',
    email:       inspection.clientEmail   || '',
    direccion:   inspection.address       || '',
    trabajo:     CATEGORY_LABELS[inspection.issueCategory] || inspection.issueCategory || inspection.serviceType || '',
    descripcion: (inspection.problemDescription || '').slice(0, 120),
    estado:      estadoLabel || 'Nueva solicitud',
    valor:       total > 0 ? `$${total}` : '',
    idioma:      inspection.clientLanguage || 'en',
  };

  try {
    const res = await fetch(WEBHOOK_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (!res.ok) console.error('[Sheets] Webhook error:', res.status);
    else console.log('[Sheets] Cliente registrado:', inspection.clientName);
  } catch (err) {
    console.error('[Sheets] Error enviando a Google Sheets:', err.message);
  }
}

module.exports = { appendClientToSheet };
