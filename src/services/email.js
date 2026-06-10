const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

const APP_URL = process.env.APP_URL || 'http://localhost:3003';

// ─── Client-facing translations ────────────────────────────────────────────
const CT = {
  en: {
    estimateSubject: 'Your Repair Estimate — Inspector Mactor',
    estimateTagline: 'Your repair estimate',
    greeting: (name) => `Hi <strong>${name}</strong>,`,
    intro: (addr) => `We reviewed your inspection at <strong>${addr}</strong> and prepared the following estimate:`,
    work: 'WORK', cost: 'COST',
    subtotal: 'Subtotal', hst: 'HST (13%)',
    validFor: (days) => `This estimate is valid for ${days} days.`,
    accept: '✓ Accept Estimate', decline: 'Decline',
    footer: 'Inspector Mactor · MacTor Maintenance · GTA Toronto',
  },
  es: {
    estimateSubject: 'Tu Estimado de Reparación — Inspector Mactor',
    estimateTagline: 'Tu estimado de reparación',
    greeting: (name) => `Hola <strong>${name}</strong>,`,
    intro: (addr) => `Revisamos tu inspección en <strong>${addr}</strong> y preparamos el siguiente estimado:`,
    work: 'TRABAJO', cost: 'COSTO',
    subtotal: 'Subtotal', hst: 'HST (13%)',
    validFor: (days) => `Este estimado es válido por ${days} días.`,
    accept: '✓ Aceptar Estimado', decline: 'Declinar',
    footer: 'Inspector Mactor · MacTor Maintenance · GTA Toronto',
  },
  zh: {
    estimateSubject: '您的维修报价 — Inspector Mactor',
    estimateTagline: '您的维修费用估算',
    greeting: (name) => `您好 <strong>${name}</strong>，`,
    intro: (addr) => `我们已审核您在 <strong>${addr}</strong> 的检查报告，并准备了以下估算：`,
    work: '工作内容', cost: '费用',
    subtotal: '小计', hst: 'HST税 (13%)',
    validFor: (days) => `本估算有效期为 ${days} 天。`,
    accept: '✓ 接受估算', decline: '拒绝',
    footer: 'Inspector Mactor · MacTor Maintenance · GTA Toronto',
  },
  hi: {
    estimateSubject: 'आपका मरम्मत अनुमान — Inspector Mactor',
    estimateTagline: 'आपका मरम्मत अनुमान',
    greeting: (name) => `नमस्ते <strong>${name}</strong>,`,
    intro: (addr) => `हमने <strong>${addr}</strong> पर आपके निरीक्षण की समीक्षा की और निम्नलिखित अनुमान तैयार किया:`,
    work: 'कार्य', cost: 'लागत',
    subtotal: 'उप-कुल', hst: 'HST (13%)',
    validFor: (days) => `यह अनुमान ${days} दिनों के लिए वैध है।`,
    accept: '✓ अनुमान स्वीकार करें', decline: 'अस्वीकार करें',
    footer: 'Inspector Mactor · MacTor Maintenance · GTA Toronto',
  },
  tl: {
    estimateSubject: 'Ang Iyong Tantya sa Pagkukumpuni — Inspector Mactor',
    estimateTagline: 'Ang iyong tantya sa pagkukumpuni',
    greeting: (name) => `Kamusta <strong>${name}</strong>,`,
    intro: (addr) => `Nasuri namin ang iyong inspeksyon sa <strong>${addr}</strong> at inihanda ang sumusunod na tantya:`,
    work: 'GAWAIN', cost: 'GASTOS',
    subtotal: 'Subtotal', hst: 'HST (13%)',
    validFor: (days) => `Ang tanyang ito ay may bisa nang ${days} araw.`,
    accept: '✓ Tanggapin ang Tantya', decline: 'Tanggihan',
    footer: 'Inspector Mactor · MacTor Maintenance · GTA Toronto',
  },
};

function getLang(inspection) {
  const l = inspection.clientLanguage;
  return CT[l] ? l : 'en';
}

// ─── 1. Email to MacTor when new inspection is submitted (always in Spanish) ─
async function sendInspectionToMacTor(inspection) {
  const defects = (inspection.aiSummary?.all_defects || []);
  const highSeverity = defects.filter(d => d.severity === 'critical' || d.severity === 'high');
  const approvalLink = `${APP_URL}/approve/${inspection.approvalToken}`;

  const photosHtml = (inspection.photos || []).map(url =>
    `<img src="${url}" style="width:180px;height:120px;object-fit:cover;border-radius:8px;margin:4px;" />`
  ).join('');

  const langLabel = { en: '🇨🇦 EN', es: '🇲🇽 ES', zh: '🇨🇳 ZH', hi: '🇮🇳 HI', tl: '🇵🇭 TL' }[inspection.clientLanguage] || '🇨🇦 EN';

  const defectsHtml = defects.map(d => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #e2e8f0;">${d.defect_type}</td>
      <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:center;">
        <span style="padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;
          background:${d.severity==='critical'?'#fee2e2':d.severity==='high'?'#fef3c7':'#dbeafe'};
          color:${d.severity==='critical'?'#dc2626':d.severity==='high'?'#d97706':'#2563eb'};">
          ${d.severity.toUpperCase()}
        </span>
      </td>
      <td style="padding:8px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#64748b;">${d.danger_if_ignored || '—'}</td>
    </tr>
  `).join('');

  await transporter.sendMail({
    from: `"Inspector Mactor" <${process.env.EMAIL_USER}>`,
    to: process.env.EMAIL_TO,
    subject: `🔍 Nueva Inspección — ${inspection.clientName || 'Cliente'} — ${inspection.address || 'Sin dirección'}`,
    html: `
      <div style="font-family:sans-serif;max-width:700px;margin:0 auto;background:#f8fafc;">
        <div style="background:#0f172a;padding:24px;border-radius:12px 12px 0 0;display:flex;align-items:center;gap:14px;">
          <div style="font-size:28px;">🏠🔍</div>
          <div>
            <h1 style="color:white;margin:0;font-size:20px;font-weight:900;">Inspector Mactor</h1>
            <p style="color:#f59e0b;margin:2px 0 0;font-size:12px;letter-spacing:1px;">▲ MACTOR MAINTENANCE</p>
          </div>
          <div style="margin-left:auto;background:rgba(245,158,11,0.2);border:1px solid rgba(245,158,11,0.4);padding:4px 12px;border-radius:20px;font-size:12px;color:#fcd34d;font-weight:700;">${langLabel}</div>
        </div>
        <div style="padding:24px;background:white;">
          <p style="color:#f59e0b;font-size:12px;letter-spacing:2px;font-weight:700;margin:0 0 16px;">NUEVA INSPECCIÓN RECIBIDA</p>
          <div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap;">
            <div style="background:#f1f5f9;padding:12px 16px;border-radius:8px;flex:1;min-width:140px;">
              <p style="margin:0;font-size:11px;color:#94a3b8;text-transform:uppercase;">Cliente</p>
              <p style="margin:4px 0 0;font-weight:600;color:#0f172a;">${inspection.clientName || '—'}</p>
            </div>
            <div style="background:#f1f5f9;padding:12px 16px;border-radius:8px;flex:1;min-width:140px;">
              <p style="margin:0;font-size:11px;color:#94a3b8;text-transform:uppercase;">Propiedad</p>
              <p style="margin:4px 0 0;font-weight:600;color:#0f172a;">${inspection.propertyType === 'commercial' ? 'Comercial' : 'Residencial'}</p>
            </div>
            <div style="background:#fee2e2;padding:12px 16px;border-radius:8px;flex:1;min-width:140px;">
              <p style="margin:0;font-size:11px;color:#94a3b8;text-transform:uppercase;">Daños detectados</p>
              <p style="margin:4px 0 0;font-weight:700;color:#dc2626;font-size:24px;">${defects.length}</p>
            </div>
            <div style="background:#fef3c7;padding:12px 16px;border-radius:8px;flex:1;min-width:140px;">
              <p style="margin:0;font-size:11px;color:#94a3b8;text-transform:uppercase;">Alta prioridad</p>
              <p style="margin:4px 0 0;font-weight:700;color:#d97706;font-size:24px;">${highSeverity.length}</p>
            </div>
          </div>
          <p style="margin:0 0 6px;color:#64748b;font-size:13px;"><strong>Dirección:</strong> ${inspection.address || 'No especificada'}</p>
          <p style="margin:0 0 20px;color:#64748b;font-size:13px;"><strong>Teléfono:</strong> ${inspection.clientPhone || '—'} · <strong>Email:</strong> ${inspection.clientEmail || '—'}</p>
          <div style="margin-bottom:20px;">${photosHtml}</div>
          ${defects.length > 0 ? `
          <h3 style="color:#0f172a;margin:0 0 12px;">Daños detectados por IA</h3>
          <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
            <thead><tr style="background:#f1f5f9;">
              <th style="padding:8px;text-align:left;font-size:12px;color:#64748b;">DAÑO</th>
              <th style="padding:8px;text-align:center;font-size:12px;color:#64748b;">SEVERIDAD</th>
              <th style="padding:8px;text-align:left;font-size:12px;color:#64748b;">RIESGO</th>
            </tr></thead>
            <tbody>${defectsHtml}</tbody>
          </table>` : '<p style="color:#22c55e;font-weight:600;">✓ No se detectaron daños significativos.</p>'}
          <div style="text-align:center;margin-top:24px;">
            <a href="${approvalLink}" style="display:inline-block;background:linear-gradient(135deg,#f59e0b,#d97706);color:#0f172a;padding:14px 32px;border-radius:12px;text-decoration:none;font-weight:800;font-size:16px;">
              Revisar y Aprobar Estimado →
            </a>
          </div>
        </div>
      </div>
    `,
  });
}

// ─── 2. Email to client with approved estimate (in client's language) ────────
async function sendEstimateToClient(inspection) {
  const estimate = inspection.approvedEstimate;
  if (!estimate) return;

  const lang = getLang(inspection);
  const c = CT[lang];
  const acceptLink = `${APP_URL}/accept/${inspection.acceptToken}?lang=${lang}`;
  const declineLink = `${APP_URL}/accept/${inspection.acceptToken}?action=decline&lang=${lang}`;

  const lineItemsHtml = (estimate.line_items || []).map(item => `
    <tr>
      <td style="padding:10px;border-bottom:1px solid #e2e8f0;">
        <strong>${item.defect_type}</strong><br/>
        <span style="font-size:12px;color:#64748b;">${item.description || ''}</span>
      </td>
      <td style="padding:10px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:600;white-space:nowrap;">
        $${Number(item.total || 0).toLocaleString()} CAD
      </td>
    </tr>
  `).join('');

  await transporter.sendMail({
    from: `"Inspector Mactor" <${process.env.EMAIL_USER}>`,
    to: inspection.clientEmail,
    subject: c.estimateSubject,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#f8fafc;">
        <div style="background:#0f172a;padding:24px;border-radius:12px 12px 0 0;display:flex;align-items:center;gap:12px;">
          <div style="font-size:24px;">🏠🔍</div>
          <div>
            <h1 style="color:white;margin:0;font-size:18px;font-weight:900;">Inspector Mactor</h1>
            <p style="color:#f59e0b;margin:2px 0 0;font-size:11px;">${c.estimateTagline}</p>
          </div>
        </div>
        <div style="padding:24px;background:white;">
          <p style="color:#0f172a;">${c.greeting(inspection.clientName)}</p>
          <p style="color:#64748b;">${c.intro(inspection.address)}</p>
          <table style="width:100%;border-collapse:collapse;margin:20px 0;">
            <thead><tr style="background:#f1f5f9;">
              <th style="padding:10px;text-align:left;font-size:12px;color:#64748b;">${c.work}</th>
              <th style="padding:10px;text-align:right;font-size:12px;color:#64748b;">${c.cost}</th>
            </tr></thead>
            <tbody>${lineItemsHtml}</tbody>
          </table>
          <div style="background:#f8fafc;padding:16px;border-radius:8px;margin-bottom:20px;">
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
              <span style="color:#64748b;">${c.subtotal}</span>
              <span>$${(estimate.subtotal || 0).toLocaleString()} CAD</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
              <span style="color:#64748b;">${c.hst}</span>
              <span>$${(estimate.hst || 0).toLocaleString()} CAD</span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:20px;font-weight:800;margin-top:10px;padding-top:10px;border-top:2px solid #e2e8f0;">
              <span>TOTAL</span>
              <span style="color:#f59e0b;">$${(estimate.total || 0).toLocaleString()} CAD</span>
            </div>
          </div>
          <p style="font-size:12px;color:#94a3b8;">${estimate.disclaimer || ''}</p>
          <p style="font-size:12px;color:#94a3b8;">${c.validFor(estimate.valid_days || 30)}</p>
          <div style="text-align:center;margin-top:28px;display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
            <a href="${acceptLink}" style="display:inline-block;background:linear-gradient(135deg,#22c55e,#16a34a);color:white;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:700;">
              ${c.accept}
            </a>
            <a href="${declineLink}" style="display:inline-block;background:#f1f5f9;color:#64748b;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:600;">
              ${c.decline}
            </a>
          </div>
          <p style="text-align:center;margin-top:20px;font-size:11px;color:#94a3b8;">${c.footer}</p>
        </div>
      </div>
    `,
  });
}

// ─── 3. Email to MacTor when client accepts (always in Spanish) ──────────────
async function sendAcceptanceToMacTor(inspection) {
  const langLabel = { en: '🇨🇦 EN', es: '🇲🇽 ES', zh: '🇨🇳 ZH', hi: '🇮🇳 HI', tl: '🇵🇭 TL' }[inspection.clientLanguage] || '🇨🇦 EN';

  await transporter.sendMail({
    from: `"Inspector Mactor" <${process.env.EMAIL_USER}>`,
    to: process.env.EMAIL_TO,
    subject: `✅ Estimado ACEPTADO — ${inspection.clientName} — ${inspection.address}`,
    html: `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;">
        <div style="background:#16a34a;padding:24px;border-radius:12px 12px 0 0;display:flex;align-items:center;gap:12px;">
          <h1 style="color:white;margin:0;font-size:18px;">✅ Estimado Aceptado</h1>
          <span style="margin-left:auto;background:rgba(255,255,255,0.2);padding:3px 10px;border-radius:20px;font-size:12px;color:white;">${langLabel}</span>
        </div>
        <div style="padding:24px;background:white;border-radius:0 0 12px 12px;">
          <p style="font-size:18px;font-weight:600;color:#0f172a;margin:0 0 16px;">📞 Contactar al cliente para agendar visita:</p>
          <p style="margin:6px 0;"><strong>Nombre:</strong> ${inspection.clientName}</p>
          <p style="margin:6px 0;"><strong>Teléfono:</strong> ${inspection.clientPhone}</p>
          <p style="margin:6px 0;"><strong>Email:</strong> ${inspection.clientEmail}</p>
          <p style="margin:6px 0;"><strong>Dirección:</strong> ${inspection.address}</p>
          <p style="margin:6px 0;"><strong>Total:</strong> $${(inspection.approvedEstimate?.total || 0).toLocaleString()} CAD</p>
          <p style="margin:6px 0;"><strong>Tipo:</strong> ${inspection.propertyType === 'commercial' ? 'Comercial' : 'Residencial'}</p>
        </div>
      </div>
    `,
  });
}

module.exports = { sendInspectionToMacTor, sendEstimateToClient, sendAcceptanceToMacTor };
