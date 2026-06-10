const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const APP_URL = process.env.APP_URL || 'http://localhost:3003';
const API_URL = process.env.API_URL || 'http://localhost:3002';

// 1. Email to MacTor when new inspection is submitted
async function sendInspectionToMacTor(inspection) {
  const defects = (inspection.aiSummary?.all_defects || []);
  const highSeverity = defects.filter(d => d.severity === 'critical' || d.severity === 'high');
  const approvalLink = `${APP_URL}/approve/${inspection.approvalToken}`;

  const photosHtml = (inspection.photos || []).map(url =>
    `<img src="${url}" style="width:180px;height:120px;object-fit:cover;border-radius:8px;margin:4px;" />`
  ).join('');

  const defectsHtml = defects.map(d => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #e2e8f0;">${d.defect_type}</td>
      <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:center;">
        <span style="padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;
          background:${d.severity === 'critical' ? '#fee2e2' : d.severity === 'high' ? '#fef3c7' : '#dbeafe'};
          color:${d.severity === 'critical' ? '#dc2626' : d.severity === 'high' ? '#d97706' : '#2563eb'};">
          ${d.severity.toUpperCase()}
        </span>
      </td>
      <td style="padding:8px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#64748b;">${d.danger_if_ignored || '—'}</td>
    </tr>
  `).join('');

  await transporter.sendMail({
    from: `"MacTor Inspections" <${process.env.EMAIL_USER}>`,
    to: process.env.EMAIL_TO,
    subject: `🔍 New Inspection — ${inspection.clientName || 'Client'} — ${inspection.address || 'No address'}`,
    html: `
      <div style="font-family:sans-serif;max-width:700px;margin:0 auto;background:#f8fafc;">
        <div style="background:#0f172a;padding:24px;border-radius:12px 12px 0 0;">
          <h1 style="color:white;margin:0;font-size:22px;">▲ MacTor Inspections</h1>
          <p style="color:#60a5fa;margin:4px 0 0;">New inspection received</p>
        </div>

        <div style="padding:24px;background:white;">
          <div style="display:flex;gap:16px;margin-bottom:20px;flex-wrap:wrap;">
            <div style="background:#f1f5f9;padding:12px 16px;border-radius:8px;flex:1;min-width:150px;">
              <p style="margin:0;font-size:11px;color:#94a3b8;text-transform:uppercase;">Client</p>
              <p style="margin:4px 0 0;font-weight:600;color:#0f172a;">${inspection.clientName || '—'}</p>
            </div>
            <div style="background:#f1f5f9;padding:12px 16px;border-radius:8px;flex:1;min-width:150px;">
              <p style="margin:0;font-size:11px;color:#94a3b8;text-transform:uppercase;">Property</p>
              <p style="margin:4px 0 0;font-weight:600;color:#0f172a;">${inspection.propertyType === 'commercial' ? 'Commercial' : 'Residential'}</p>
            </div>
            <div style="background:#f1f5f9;padding:12px 16px;border-radius:8px;flex:1;min-width:150px;">
              <p style="margin:0;font-size:11px;color:#94a3b8;text-transform:uppercase;">Issues detected</p>
              <p style="margin:4px 0 0;font-weight:600;color:#dc2626;font-size:22px;">${defects.length}</p>
            </div>
            <div style="background:#f1f5f9;padding:12px 16px;border-radius:8px;flex:1;min-width:150px;">
              <p style="margin:0;font-size:11px;color:#94a3b8;text-transform:uppercase;">High priority</p>
              <p style="margin:4px 0 0;font-weight:600;color:#d97706;font-size:22px;">${highSeverity.length}</p>
            </div>
          </div>

          <p style="margin:0 0 8px;color:#64748b;font-size:13px;"><strong>Address:</strong> ${inspection.address || 'Not specified'}</p>
          <p style="margin:0 0 20px;color:#64748b;font-size:13px;"><strong>Phone:</strong> ${inspection.clientPhone || '—'} · <strong>Email:</strong> ${inspection.clientEmail || '—'}</p>

          <div style="margin-bottom:20px;">${photosHtml}</div>

          ${defects.length > 0 ? `
          <h3 style="color:#0f172a;margin:0 0 12px;">AI-detected issues</h3>
          <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
            <thead>
              <tr style="background:#f1f5f9;">
                <th style="padding:8px;text-align:left;font-size:12px;color:#64748b;">ISSUE</th>
                <th style="padding:8px;text-align:center;font-size:12px;color:#64748b;">SEVERITY</th>
                <th style="padding:8px;text-align:left;font-size:12px;color:#64748b;">RISK IF NOT REPAIRED</th>
              </tr>
            </thead>
            <tbody>${defectsHtml}</tbody>
          </table>` : '<p style="color:#22c55e;font-weight:600;">✓ No significant damage detected.</p>'}

          <div style="text-align:center;margin-top:24px;">
            <a href="${approvalLink}"
               style="display:inline-block;background:#3b82f6;color:white;padding:14px 32px;border-radius:12px;text-decoration:none;font-weight:700;font-size:16px;">
              Review and Approve Estimate →
            </a>
          </div>
        </div>
      </div>
    `,
  });
}

// 2. Email to client with approved estimate
async function sendEstimateToClient(inspection) {
  const estimate = inspection.approvedEstimate;
  if (!estimate) return;

  const acceptLink = `${APP_URL}/accept/${inspection.acceptToken}`;
  const declineLink = `${APP_URL}/decline/${inspection.acceptToken}`;

  const lineItemsHtml = (estimate.line_items || []).map(item => `
    <tr>
      <td style="padding:10px;border-bottom:1px solid #e2e8f0;">
        <strong>${item.defect_type}</strong><br/>
        <span style="font-size:12px;color:#64748b;">${item.description}</span>
      </td>
      <td style="padding:10px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:600;">
        $${item.total.toLocaleString()} CAD
      </td>
    </tr>
  `).join('');

  await transporter.sendMail({
    from: `"MacTor Maintenance" <${process.env.EMAIL_USER}>`,
    to: inspection.clientEmail,
    subject: `Your Repair Estimate — MacTor Maintenance`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#f8fafc;">
        <div style="background:#0f172a;padding:24px;border-radius:12px 12px 0 0;">
          <h1 style="color:white;margin:0;font-size:22px;">▲ MacTor Maintenance</h1>
          <p style="color:#60a5fa;margin:4px 0 0;">Your repair estimate</p>
        </div>

        <div style="padding:24px;background:white;">
          <p style="color:#0f172a;">Hi <strong>${inspection.clientName}</strong>,</p>
          <p style="color:#64748b;">We reviewed your inspection at <strong>${inspection.address}</strong> and prepared the following estimate:</p>

          <table style="width:100%;border-collapse:collapse;margin:20px 0;">
            <thead>
              <tr style="background:#f1f5f9;">
                <th style="padding:10px;text-align:left;font-size:12px;color:#64748b;">WORK</th>
                <th style="padding:10px;text-align:right;font-size:12px;color:#64748b;">COST</th>
              </tr>
            </thead>
            <tbody>${lineItemsHtml}</tbody>
          </table>

          <div style="background:#f8fafc;padding:16px;border-radius:8px;margin-bottom:20px;">
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
              <span style="color:#64748b;">Subtotal</span>
              <span>$${(estimate.subtotal || 0).toLocaleString()} CAD</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
              <span style="color:#64748b;">HST (13%)</span>
              <span>$${(estimate.hst || 0).toLocaleString()} CAD</span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:18px;font-weight:700;margin-top:8px;padding-top:8px;border-top:2px solid #e2e8f0;">
              <span>TOTAL</span>
              <span style="color:#0f172a;">$${(estimate.total || 0).toLocaleString()} CAD</span>
            </div>
          </div>

          <p style="font-size:12px;color:#94a3b8;">${estimate.disclaimer || ''}</p>
          <p style="font-size:12px;color:#94a3b8;">This estimate is valid for ${estimate.valid_days || 30} days.</p>

          <div style="text-align:center;margin-top:28px;display:flex;gap:12px;justify-content:center;">
            <a href="${acceptLink}"
               style="display:inline-block;background:#22c55e;color:white;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:700;">
              ✓ Accept Estimate
            </a>
            <a href="${declineLink}"
               style="display:inline-block;background:#f1f5f9;color:#64748b;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:600;">
              Decline
            </a>
          </div>
        </div>
      </div>
    `,
  });
}

// 3. Email to MacTor when client accepts estimate
async function sendAcceptanceToMacTor(inspection) {
  await transporter.sendMail({
    from: `"MacTor Inspections" <${process.env.EMAIL_USER}>`,
    to: process.env.EMAIL_TO,
    subject: `✅ Estimate ACCEPTED — ${inspection.clientName} — ${inspection.address}`,
    html: `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;">
        <div style="background:#16a34a;padding:24px;border-radius:12px 12px 0 0;">
          <h1 style="color:white;margin:0;">✅ Estimate Accepted</h1>
        </div>
        <div style="padding:24px;background:white;border-radius:0 0 12px 12px;">
          <p style="font-size:18px;font-weight:600;color:#0f172a;">Contact the client to schedule a visit:</p>
          <p><strong>Name:</strong> ${inspection.clientName}</p>
          <p><strong>Phone:</strong> ${inspection.clientPhone}</p>
          <p><strong>Email:</strong> ${inspection.clientEmail}</p>
          <p><strong>Address:</strong> ${inspection.address}</p>
          <p><strong>Estimate total:</strong> $${(inspection.approvedEstimate?.total || 0).toLocaleString()} CAD</p>
          <p><strong>Type:</strong> ${inspection.propertyType === 'commercial' ? 'Commercial' : 'Residential'}</p>
        </div>
      </div>
    `,
  });
}

module.exports = { sendInspectionToMacTor, sendEstimateToClient, sendAcceptanceToMacTor };
