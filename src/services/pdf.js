const PDFDocument = require('pdfkit');
const path        = require('path');

const LOGO_PATH = path.join(__dirname, '../assets/logo.png');

const TABLE_HDR = '#333333';
const ROW_ALT   = '#f4f4f4';
const BLACK     = '#1a1a1a';
const GRAY      = '#666666';
const RED       = '#c0392b';
const WHITE     = '#ffffff';

const COMPANY = {
  name:    'MACTOR Construction',
  owner:   'Julio Cesar Macias',
  gst:     'GST # 70823 0743',
  address: '71 Sufi Cresc',
  city:    'North York On',
  postal:  'M4A2X3',
  phone:   '6475173343',
  web:     'https://www.mactor.ca',
  email:   'julio@mactor.ca',
};

async function fetchImageBuffer(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch { return null; }
}

async function generateInvoicePDF(invoice) {
  return new Promise(async (resolve, reject) => {
    const doc    = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const PAGE_W = doc.page.width;   // 612
    const MARGIN = 50;
    const W      = PAGE_W - MARGIN * 2; // 512

    // ── TOP RULE ────────────────────────────────────────────────
    doc.rect(MARGIN, MARGIN, W, 3).fill(TABLE_HDR);

    // ── HEADER: Logo | Company info | Invoice meta ───────────────
    const HDR_Y      = MARGIN + 12;
    const LOGO_W     = 115;
    const LOGO_H     = 80;
    const INFO_X     = MARGIN + LOGO_W + 20;
    const META_X     = PAGE_W - MARGIN - 155;
    const META_W     = 155;

    // Logo
    try {
      doc.image(LOGO_PATH, MARGIN, HDR_Y, { width: LOGO_W, height: LOGO_H, fit: [LOGO_W, LOGO_H] });
    } catch {
      // fallback text if logo fails
      doc.fontSize(14).font('Helvetica-Bold').fillColor(BLACK).text('MACTOR', MARGIN, HDR_Y + 20);
    }

    // Company info (center-left)
    doc.fontSize(13).font('Helvetica-Bold').fillColor(BLACK).text(COMPANY.name, INFO_X, HDR_Y);
    doc.fontSize(8.5).font('Helvetica').fillColor(BLACK);
    const infoLines = [COMPANY.owner, COMPANY.gst, COMPANY.address, COMPANY.city,
                       COMPANY.postal, COMPANY.phone];
    let infoY = HDR_Y + 18;
    infoLines.forEach(line => {
      doc.text(line, INFO_X, infoY);
      infoY += 11.5;
    });
    doc.fillColor('#1a6db5').text(COMPANY.web, INFO_X, infoY);
    infoY += 11.5;
    doc.fillColor(BLACK).text(COMPANY.email, INFO_X, infoY);

    // Invoice meta (right)
    const typeLabel = invoice.type === 'estimate' ? 'ESTIMATE' : 'INVOICE';
    doc.fontSize(9).font('Helvetica-Bold').fillColor(GRAY)
       .text(typeLabel, META_X, HDR_Y, { width: META_W, align: 'right' });
    doc.fontSize(16).font('Helvetica-Bold').fillColor(BLACK)
       .text(invoice.invoiceNumber, META_X, HDR_Y + 12, { width: META_W, align: 'right' });

    const dateStr = new Date(invoice.invoiceDate).toLocaleDateString('en-CA', {
      month: '2-digit', day: '2-digit', year: 'numeric'
    });
    let mY = HDR_Y + 33;
    [['DATE', dateStr], ['DUE', invoice.dueDate || 'On Receipt']].forEach(([lbl, val]) => {
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor(GRAY)
         .text(lbl, META_X, mY, { width: META_W, align: 'right' });
      mY += 11;
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor(BLACK)
         .text(val, META_X, mY, { width: META_W, align: 'right' });
      mY += 13;
    });

    // Balance Due box
    const balanceDue = invoice.status === 'paid' ? 0 : invoice.total;
    doc.fontSize(7.5).font('Helvetica-Bold').fillColor(GRAY)
       .text('BALANCE DUE', META_X, mY, { width: META_W, align: 'right' });
    mY += 11;
    doc.fontSize(10).font('Helvetica-Bold').fillColor(BLACK)
       .text(`CAD $${balanceDue.toFixed(2)}`, META_X, mY, { width: META_W, align: 'right' });

    // ── DIVIDER ─────────────────────────────────────────────────
    let y = Math.max(HDR_Y + LOGO_H + 10, infoY + 12, mY + 20);
    doc.moveTo(MARGIN, y).lineTo(MARGIN + W, y).lineWidth(0.5).stroke('#cccccc');
    y += 14;

    // ── BILL TO ─────────────────────────────────────────────────
    doc.fontSize(7.5).font('Helvetica-Bold').fillColor(GRAY).text('BILL TO', MARGIN, y);
    y += 13;
    doc.fontSize(13).font('Helvetica-Bold').fillColor(BLACK).text(invoice.clientName, MARGIN, y);
    y += 16;
    doc.fontSize(9).font('Helvetica').fillColor(BLACK);
    const billLines = [invoice.clientAddress, invoice.clientPhone, invoice.clientEmail].filter(Boolean);
    billLines.forEach(line => { doc.text(line, MARGIN, y); y += 12; });
    y += 10;

    // ── LINE ITEMS TABLE ─────────────────────────────────────────
    const COL = {
      desc: MARGIN,
      rate: MARGIN + W - 195,
      qty:  MARGIN + W - 130,
      amt:  MARGIN + W - 70,
    };
    const COL_WIDTHS = { rate: 60, qty: 50, amt: 65 };

    // Table header row
    doc.rect(MARGIN, y, W, 20).fill(TABLE_HDR);
    doc.fontSize(8).font('Helvetica-Bold').fillColor(WHITE);
    doc.text('DESCRIPTION', COL.desc + 6, y + 6);
    doc.text('RATE',   COL.rate, y + 6, { width: COL_WIDTHS.rate, align: 'right' });
    doc.text('QTY',    COL.qty,  y + 6, { width: COL_WIDTHS.qty,  align: 'center' });
    doc.text('AMOUNT', COL.amt,  y + 6, { width: COL_WIDTHS.amt,  align: 'right' });
    y += 20;

    // Item rows
    const items = invoice.lineItems || [];
    items.forEach((item, idx) => {
      const bg       = idx % 2 === 0 ? WHITE : ROW_ALT;
      const descW    = COL.rate - COL.desc - 12;
      const descH    = doc.heightOfString(item.description || '', { width: descW, fontSize: 9 });
      const notesH   = item.notes
        ? doc.heightOfString(item.notes, { width: descW, fontSize: 8 }) + 3
        : 0;
      const rowH = descH + notesH + 14;

      // Page break check — only guard the row itself; the totals/payment
      // block below has its own check and will move to a new page on its
      // own if it doesn't fit after the last item.
      if (y + rowH > doc.page.height - MARGIN - 25) {
        doc.addPage();
        y = MARGIN;
        // Repeat table header
        doc.rect(MARGIN, y, W, 20).fill(TABLE_HDR);
        doc.fontSize(8).font('Helvetica-Bold').fillColor(WHITE);
        doc.text('DESCRIPTION', COL.desc + 6, y + 6);
        doc.text('RATE',   COL.rate, y + 6, { width: COL_WIDTHS.rate, align: 'right' });
        doc.text('QTY',    COL.qty,  y + 6, { width: COL_WIDTHS.qty,  align: 'center' });
        doc.text('AMOUNT', COL.amt,  y + 6, { width: COL_WIDTHS.amt,  align: 'right' });
        y += 20;
      }

      doc.rect(MARGIN, y, W, rowH).fill(bg);

      // Description text
      doc.fontSize(9).font('Helvetica-Bold').fillColor(BLACK)
         .text(item.description || '', COL.desc + 6, y + 7, { width: descW });

      if (item.notes) {
        const notesY = y + 7 + descH + 2;
        doc.fontSize(8).font('Helvetica').fillColor(GRAY)
           .text(item.notes, COL.desc + 6, notesY, { width: descW });
      }

      // Rate / Qty / Amount
      const midY = y + rowH / 2 - 5;
      doc.fontSize(9).font('Helvetica').fillColor(BLACK);
      doc.text(`$${Number(item.rate || 0).toFixed(2)}`,   COL.rate, midY, { width: COL_WIDTHS.rate, align: 'right' });
      doc.text(String(item.qty || 1),                      COL.qty,  midY, { width: COL_WIDTHS.qty,  align: 'center' });
      doc.text(`$${Number(item.amount || 0).toFixed(2)}`, COL.amt,  midY, { width: COL_WIDTHS.amt,  align: 'right' });

      y += rowH;
    });

    // ── TOTALS + PAYMENT INFO ─────────────────────────────────────
    y += 20;
    if (y > doc.page.height - MARGIN - 150) { doc.addPage(); y = MARGIN; }

    // Left side: payment info for invoices, an approval CTA for estimates
    const PAY_X = MARGIN;
    let payY = y;
    if (invoice.type === 'estimate') {
      doc.fontSize(11).font('Helvetica-Bold').fillColor(BLACK).text('Ready to Move Forward?', PAY_X, payY, { width: 240 });
      payY += 17;
      if (invoice.status === 'approved') {
        doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#16a34a').text('✓ Approved — we’ll be in touch to schedule.', PAY_X, payY, { width: 240 });
        payY += 15;
      } else {
        doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#1a6db5')
           .text('Click here to approve this estimate', PAY_X, payY, { link: `https://www.mactor.ca/approve/${invoice.id}`, underline: true, width: 240 });
        payY += 15;
      }
      doc.fontSize(8.5).font('Helvetica').fillColor(GRAY)
         .text('Approving lets us know you’d like to proceed — we’ll follow up to schedule the work.', PAY_X, payY, { width: 240 });
      payY += 24;
    } else {
      doc.fontSize(11).font('Helvetica-Bold').fillColor(BLACK).text('Payment Info', PAY_X, payY);
      payY += 17;
      if (invoice.status !== 'paid') {
        doc.fontSize(8).font('Helvetica-Bold').fillColor(GRAY).text('PAY ONLINE', PAY_X, payY);
        payY += 11;
        doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#1a6db5')
           .text('Click here to pay by card', PAY_X, payY, { link: `https://www.mactor.ca/pay/${invoice.id}`, underline: true });
        payY += 15;
      }
      doc.fontSize(8).font('Helvetica-Bold').fillColor(GRAY).text('E-TRANSFER', PAY_X, payY);
      payY += 11;
      doc.fontSize(8.5).font('Helvetica').fillColor(BLACK).text('payments@mactor.ca', PAY_X, payY);
      payY += 15;
      doc.fontSize(8).font('Helvetica-Bold').fillColor(GRAY).text('BY CHEQUE', PAY_X, payY);
      payY += 11;
      doc.fontSize(8.5).font('Helvetica').fillColor(BLACK)
         .text('Mactor Construction or Julio Cesar Macias Aguilar', PAY_X, payY, { width: 200 });
    }

    // Totals (right side)
    const TOT_LABEL_X = PAGE_W - MARGIN - 230;
    const TOT_VAL_X   = PAGE_W - MARGIN - 90;
    const TOT_W       = 85;
    let totY = y;

    const totals = [
      ['SUBTOTAL', invoice.subtotal],
      ...(invoice.discount > 0 ? [['DISCOUNT', -invoice.discount]] : []),
      ...(invoice.hstEnabled !== false ? [['HST (13%)', invoice.hst]] : []),
      ['TOTAL',    invoice.total],
    ];
    totals.forEach(([lbl, val]) => {
      doc.fontSize(8.5).font('Helvetica').fillColor(GRAY)
         .text(lbl, TOT_LABEL_X, totY, { width: TOT_W, align: 'right' });
      doc.fillColor(BLACK)
         .text(`${val < 0 ? '-' : ''}$${Math.abs(Number(val)).toFixed(2)}`, TOT_VAL_X, totY, { width: 90, align: 'right' });
      totY += 16;
    });

    // Payment line (if paid)
    if (invoice.status === 'paid' && invoice.paidAt) {
      const paidDate = new Date(invoice.paidAt).toLocaleDateString('en-CA', {
        month: '2-digit', day: '2-digit', year: 'numeric'
      });
      doc.fontSize(8.5).font('Helvetica').fillColor(GRAY)
         .text('Payment', TOT_LABEL_X, totY, { width: TOT_W, align: 'right' });
      doc.fillColor(BLACK)
         .text(`-$${Number(invoice.total).toFixed(2)}`, TOT_VAL_X, totY, { width: 90, align: 'right' });
      totY += 12;
      doc.fontSize(7.5).font('Helvetica').fillColor(GRAY)
         .text('Check', TOT_LABEL_X, totY, { width: TOT_W, align: 'right' });
      doc.fillColor(GRAY).text(paidDate, TOT_VAL_X, totY, { width: 90, align: 'right' });
      totY += 18;
    }

    // Divider before Balance Due
    doc.moveTo(TOT_LABEL_X, totY).lineTo(PAGE_W - MARGIN, totY).lineWidth(0.5).stroke('#cccccc');
    totY += 6;

    doc.fontSize(9).font('Helvetica-Bold').fillColor(BLACK)
       .text('BALANCE DUE', TOT_LABEL_X, totY, { width: TOT_W, align: 'right' });
    doc.fontSize(11).font('Helvetica-Bold')
       .text(`CAD $${balanceDue.toFixed(2)}`, TOT_VAL_X, totY - 1, { width: 90, align: 'right' });

    // ── NOTES ────────────────────────────────────────────────────
    // Tracks where content actually ends so photos can start right after
    // it instead of always jumping to a fresh page.
    let contentEndY = Math.max(payY, totY + 20);
    if (invoice.notes) {
      const notesH = doc.heightOfString(invoice.notes, { width: W, fontSize: 9 });
      let notesY = Math.max(payY + 20, totY + 30);
      if (notesY > doc.page.height - MARGIN - 80) { doc.addPage(); notesY = MARGIN; }
      doc.moveTo(MARGIN, notesY - 4).lineTo(MARGIN + W * 0.45, notesY - 4).lineWidth(0.5).stroke('#cccccc');
      doc.fontSize(9).font('Helvetica').fillColor(BLACK).text(invoice.notes, MARGIN, notesY, { width: W });
      contentEndY = notesY + notesH;
    }

    // ── PHOTOS ───────────────────────────────────────────────────
    // Continue right after the document content when there's room for at
    // least one row of photos — only start a fresh page if there isn't.
    const photos = invoice.photos || [];
    if (photos.length > 0) {
      const imgW = 230, imgH = 170, gap = 18;
      let px = MARGIN, py = contentEndY + 24;
      if (py + imgH > doc.page.height - MARGIN - 25) {
        doc.addPage();
        py = MARGIN;
      }

      for (let i = 0; i < photos.length; i++) {
        const buf = await fetchImageBuffer(photos[i]);
        if (!buf) continue;
        try {
          doc.image(buf, px, py, { width: imgW, height: imgH, fit: [imgW, imgH] });
        } catch { continue; }

        // Only advance to the next slot if another photo is actually
        // coming — otherwise this trips a needless trailing blank page.
        if (i === photos.length - 1) continue;

        px += imgW + gap;
        if (px + imgW > PAGE_W - MARGIN) {
          px  = MARGIN;
          py += imgH + gap;
          if (py + imgH > doc.page.height - MARGIN - 25) {
            doc.addPage();
            py = MARGIN;
          }
        }
      }
    }

    // ── HEADER (continuation pages) + FOOTER (every page) ─────────
    // Page 1 already carries the full logo/company block up top, so this
    // only adds a slim identifier on later pages (e.g. a photos-only
    // page) so it's traceable back to the document on its own. The
    // footer sits inside the existing bottom margin, below where content
    // is allowed to reach, so it never collides with the last line.
    // Drawing past doc.page.height - margins.bottom makes PDFKit think the
    // text overflows and silently inserts a fresh page for it — so the
    // footer has to sit just inside the bottom margin, not below it.
    const typeLabelFooter = invoice.type === 'estimate' ? 'ESTIMATE' : 'INVOICE';
    const { start, count } = doc.bufferedPageRange();
    for (let i = start; i < start + count; i++) {
      doc.switchToPage(i);

      if (i > start) {
        doc.fontSize(8).font('Helvetica-Bold').fillColor(GRAY)
           .text(`MACTOR Construction — ${typeLabelFooter} ${invoice.invoiceNumber} — ${invoice.clientName}`,
                 MARGIN, 25, { width: W });
      }

      const footY = doc.page.height - MARGIN - 15;
      doc.fontSize(7.5).font('Helvetica').fillColor(GRAY)
         .text('MACTOR Construction · 647-517-3343 · julio@mactor.ca · www.mactor.ca', MARGIN, footY, { width: W - 90 });
      doc.text(`Page ${i - start + 1} of ${count}`, PAGE_W - MARGIN - 90, footY, { width: 90, align: 'right' });
    }

    doc.end();
  });
}

module.exports = { generateInvoicePDF };
