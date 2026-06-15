const { Resend } = require('resend');
const nodemailer = require('nodemailer');

const resend = new Resend(process.env.RESEND_API_KEY);

const APP_URL = process.env.APP_URL || 'http://localhost:3003';

function createGmailTransporter() {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    family: 4,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
}

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
  const isNewProject = inspection.serviceType === 'new_project';
  const approvalLink = `${APP_URL}/approve/${inspection.approvalToken}`;
  const langLabel = { en: '🇨🇦 EN', es: '🇲🇽 ES', zh: '🇨🇳 ZH', hi: '🇮🇳 HI', tl: '🇵🇭 TL' }[inspection.clientLanguage] || '🇨🇦 EN';

  const photosHtml = (inspection.photos || []).map(url =>
    `<a href="${url}" target="_blank" download style="display:inline-block;margin:4px;"><img src="${url}" style="width:180px;height:120px;object-fit:cover;border-radius:8px;border:2px solid #e2e8f0;display:block;" title="Click to open full photo" /></a>`
  ).join('');

  const header = `
    <div style="background:#0f172a;padding:24px;border-radius:12px 12px 0 0;display:flex;align-items:center;gap:14px;">
      <div style="font-size:28px;">${isNewProject ? '🏗️' : '🏠🔍'}</div>
      <div>
        <h1 style="color:white;margin:0;font-size:20px;font-weight:900;">Inspector Mactor</h1>
        <p style="color:#f59e0b;margin:2px 0 0;font-size:12px;letter-spacing:1px;">▲ MACTOR MAINTENANCE</p>
      </div>
      <div style="margin-left:auto;background:rgba(245,158,11,0.2);border:1px solid rgba(245,158,11,0.4);padding:4px 12px;border-radius:20px;font-size:12px;color:#fcd34d;font-weight:700;">${langLabel}</div>
    </div>`;

  const clientContact = `
    <p style="margin:0 0 4px;color:#64748b;font-size:13px;"><strong>Dirección:</strong> ${inspection.address || 'No especificada'}</p>
    <p style="margin:0 0 20px;color:#64748b;font-size:13px;"><strong>Teléfono:</strong> ${inspection.clientPhone || '—'} · <strong>Email:</strong> ${inspection.clientEmail || '—'}</p>`;

  let bodyHtml;

  if (isNewProject) {
    // Aggregate site observations from all photo analyses
    const analyses = Object.values(inspection.aiAnalysis || {});
    const allSiteObs = analyses.flatMap(a => (a.site_observations || []));
    const inspectorNotes = analyses.map(a => a.inspector_note).filter(Boolean);

    const siteObsHtml = allSiteObs.length > 0 ? allSiteObs.map(obs => `
      <tr>
        <td style="padding:10px;border-bottom:1px solid #e2e8f0;font-weight:600;color:#1d4ed8;">${obs.aspect}</td>
        <td style="padding:10px;border-bottom:1px solid #e2e8f0;color:#0f172a;">${obs.detail}</td>
        <td style="padding:10px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#64748b;font-style:italic;">${obs.project_relevance || '—'}</td>
      </tr>`).join('') : `<tr><td colspan="3" style="padding:10px;color:#94a3b8;text-align:center;">No se obtuvieron observaciones del sitio</td></tr>`;

    const followUpHtml = (inspection.followUpAnswers || []).length > 0
      ? inspection.followUpAnswers.map(a => `<p style="margin:4px 0;font-size:13px;color:#0f172a;"><strong>${a.question}:</strong> ${a.answer}</p>`).join('')
      : '';

    bodyHtml = `
      <p style="color:#3b82f6;font-size:12px;letter-spacing:2px;font-weight:700;margin:0 0 16px;">NUEVA SOLICITUD DE PROYECTO</p>
      <div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;">
        <div style="background:#f1f5f9;padding:12px 16px;border-radius:8px;flex:1;min-width:140px;">
          <p style="margin:0;font-size:11px;color:#94a3b8;text-transform:uppercase;">Cliente</p>
          <p style="margin:4px 0 0;font-weight:600;color:#0f172a;">${inspection.clientName || '—'}</p>
        </div>
        <div style="background:#f1f5f9;padding:12px 16px;border-radius:8px;flex:1;min-width:140px;">
          <p style="margin:0;font-size:11px;color:#94a3b8;text-transform:uppercase;">Propiedad</p>
          <p style="margin:4px 0 0;font-weight:600;color:#0f172a;">${inspection.propertyType === 'commercial' ? 'Comercial' : 'Residencial'}</p>
        </div>
        <div style="background:#dbeafe;padding:12px 16px;border-radius:8px;flex:1;min-width:140px;">
          <p style="margin:0;font-size:11px;color:#94a3b8;text-transform:uppercase;">Tipo</p>
          <p style="margin:4px 0 0;font-weight:700;color:#1d4ed8;font-size:15px;">Nuevo Proyecto</p>
        </div>
      </div>
      ${clientContact}

      <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:16px;margin-bottom:20px;">
        <p style="margin:0 0 6px;font-size:11px;color:#3b82f6;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Lo que solicita el cliente</p>
        <p style="margin:0;font-size:15px;font-weight:600;color:#0f172a;">"${inspection.problemDescription || 'Sin descripción'}"</p>
      </div>

      ${followUpHtml ? `<div style="background:#f8fafc;border-radius:8px;padding:14px;margin-bottom:20px;">${followUpHtml}</div>` : ''}

      <div style="margin-bottom:20px;">${photosHtml}</div>

      ${allSiteObs.length > 0 ? `
      <h3 style="color:#0f172a;margin:0 0 10px;font-size:14px;">Observaciones del sitio (análisis de fotos)</h3>
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px;">
        <thead><tr style="background:#eff6ff;">
          <th style="padding:8px;text-align:left;font-size:11px;color:#64748b;">ELEMENTO</th>
          <th style="padding:8px;text-align:left;font-size:11px;color:#64748b;">DETALLE</th>
          <th style="padding:8px;text-align:left;font-size:11px;color:#64748b;">RELEVANCIA</th>
        </tr></thead>
        <tbody>${siteObsHtml}</tbody>
      </table>` : ''}

      ${inspectorNotes.length > 0 ? `<p style="font-size:12px;color:#64748b;font-style:italic;border-top:1px solid #e2e8f0;padding-top:10px;">🔍 ${inspectorNotes.join(' | ')}</p>` : ''}

      <div style="text-align:center;margin-top:24px;">
        <a href="${approvalLink}" style="display:inline-block;background:linear-gradient(135deg,#3b82f6,#1d4ed8);color:white;padding:14px 32px;border-radius:12px;text-decoration:none;font-weight:800;font-size:16px;">
          Ver y Cotizar Proyecto →
        </a>
      </div>`;
  } else {
    // Repair inspection — original layout
    const defects = (inspection.aiSummary?.all_defects || []);
    const highSeverity = defects.filter(d => d.severity === 'critical' || d.severity === 'high');

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
      </tr>`).join('');

    bodyHtml = `
      <p style="color:#f59e0b;font-size:12px;letter-spacing:2px;font-weight:700;margin:0 0 16px;">NUEVA INSPECCIÓN RECIBIDA</p>
      <div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;">
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
      ${clientContact}

      ${inspection.problemDescription ? `
      <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:14px 16px;margin-bottom:18px;">
        <p style="margin:0 0 5px;font-size:11px;color:#d97706;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Lo que reporta el cliente</p>
        <p style="margin:0;font-size:14px;font-weight:500;color:#0f172a;">"${inspection.problemDescription}"</p>
      </div>` : ''}

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
      </table>` : `
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px 14px;margin-bottom:16px;">
        <p style="color:#16a34a;font-weight:600;margin:0;font-size:13px;">✓ No se detectaron daños en las fotos — el estimado se generó a partir de la descripción del cliente.</p>
      </div>`}
      <div style="text-align:center;margin-top:24px;">
        <a href="${approvalLink}" style="display:inline-block;background:linear-gradient(135deg,#f59e0b,#d97706);color:#0f172a;padding:14px 32px;border-radius:12px;text-decoration:none;font-weight:800;font-size:16px;">
          Revisar y Aprobar Estimado →
        </a>
      </div>`;
  }

  const subject = isNewProject
    ? `🏗️ Nuevo Proyecto — ${inspection.clientName || 'Cliente'} — ${inspection.address || 'Sin dirección'}`
    : `🔍 Nueva Inspección — ${inspection.clientName || 'Cliente'} — ${inspection.address || 'Sin dirección'}`;

  const { error } = await resend.emails.send({
    from: `FixMyProperty <julio@fixmyproperty.ca>`,
    to: process.env.EMAIL_TO,
    subject,
    html: `
      <div style="font-family:sans-serif;max-width:700px;margin:0 auto;background:#f8fafc;">
        ${header}
        <div style="padding:24px;background:white;">${bodyHtml}</div>
      </div>`,
  });

  if (error) throw new Error(`Resend error: ${error.message}`);
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

  const html = `
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
    `;

  const { error } = await resend.emails.send({
    from: 'Inspector Mactor <inspector@fixmyproperty.ca>',
    to: inspection.clientEmail,
    subject: c.estimateSubject,
    html,
  });

  if (error) throw new Error(`Resend error: ${error.message}`);
}

// ─── 3. Email to MacTor when client accepts (always in Spanish) ──────────────
async function sendAcceptanceToMacTor(inspection) {
  const langLabel = { en: '🇨🇦 EN', es: '🇲🇽 ES', zh: '🇨🇳 ZH', hi: '🇮🇳 HI', tl: '🇵🇭 TL' }[inspection.clientLanguage] || '🇨🇦 EN';

  const lineItems = inspection.approvedEstimate?.line_items || [];
  const lineItemsHtml = lineItems.length > 0
    ? lineItems.map(item => `
        <tr>
          <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;color:#0f172a;">${item.defect_type}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#64748b;">${item.description || ''}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:700;white-space:nowrap;color:#0f172a;">$${Number(item.total || 0).toLocaleString()} CAD</td>
        </tr>`).join('')
    : `<tr><td colspan="3" style="padding:10px;color:#94a3b8;text-align:center;">Sin desglose disponible</td></tr>`;

  const { error } = await resend.emails.send({
    from: `FixMyProperty <julio@fixmyproperty.ca>`,
    to: process.env.EMAIL_TO,
    subject: `✅ ACEPTADO — ${inspection.clientName} · ${inspection.address}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#16a34a;padding:24px;border-radius:12px 12px 0 0;display:flex;align-items:center;gap:12px;">
          <div>
            <h1 style="color:white;margin:0;font-size:20px;">✅ Estimado Aceptado</h1>
            <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;font-size:13px;">El cliente quiere proceder — agéndalo hoy</p>
          </div>
          <span style="margin-left:auto;background:rgba(255,255,255,0.2);padding:3px 10px;border-radius:20px;font-size:12px;color:white;">${langLabel}</span>
        </div>
        <div style="padding:24px;background:white;border-radius:0 0 12px 12px;">

          <p style="font-size:16px;font-weight:700;color:#0f172a;margin:0 0 16px;">📞 Contactar para agendar visita:</p>
          <div style="background:#f1f5f9;border-radius:10px;padding:16px;margin-bottom:20px;">
            <p style="margin:4px 0;"><strong>Nombre:</strong> ${inspection.clientName}</p>
            <p style="margin:4px 0;"><strong>Teléfono:</strong> <a href="tel:${inspection.clientPhone}" style="color:#2563eb;">${inspection.clientPhone}</a></p>
            <p style="margin:4px 0;"><strong>Email:</strong> <a href="mailto:${inspection.clientEmail}" style="color:#2563eb;">${inspection.clientEmail}</a></p>
            <p style="margin:4px 0;"><strong>Dirección:</strong> ${inspection.address}</p>
            <p style="margin:4px 0;"><strong>Propiedad:</strong> ${inspection.propertyType === 'commercial' ? 'Comercial' : 'Residencial'}</p>
          </div>

          <p style="font-size:14px;font-weight:700;color:#0f172a;margin:0 0 10px;">Trabajos cotizados:</p>
          <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px;">
            <thead><tr style="background:#f8fafc;">
              <th style="padding:8px 10px;text-align:left;color:#64748b;font-size:11px;">TRABAJO</th>
              <th style="padding:8px 10px;text-align:left;color:#64748b;font-size:11px;">DESCRIPCIÓN</th>
              <th style="padding:8px 10px;text-align:right;color:#64748b;font-size:11px;">COSTO</th>
            </tr></thead>
            <tbody>${lineItemsHtml}</tbody>
          </table>

          <div style="display:flex;justify-content:space-between;align-items:center;background:#f0fdf4;border:2px solid #16a34a;border-radius:10px;padding:14px 16px;">
            <span style="font-size:16px;font-weight:700;color:#0f172a;">TOTAL ACEPTADO</span>
            <span style="font-size:22px;font-weight:900;color:#16a34a;">$${(inspection.approvedEstimate?.total || 0).toLocaleString()} CAD</span>
          </div>
        </div>
      </div>
    `,
  });

  if (error) throw new Error(`Resend error: ${error.message}`);
}

module.exports = { sendInspectionToMacTor, sendEstimateToClient, sendAcceptanceToMacTor };
