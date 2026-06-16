const PDFDocument = require('pdfkit');

// MacTor brand colors
const NAVY   = '#0a0f1e';
const RED    = '#e63946';
const GRAY   = '#6b7280';
const LIGHT  = '#f9fafb';
const BLACK  = '#111827';

const COMPANY = {
  name:    'MACTOR Construction',
  owner:   'Julio Cesar Macias',
  gst:     'GST # 70823 0743',
  address: '71 Sufi Cresc',
  city:    'North York ON  M4A2X3',
  phone:   '647-517-3343',
  web:     'https://www.mactor.ca',
  email:   'julio@mactor.ca',
};

const PAYMENT = [
  { label: 'PAYPAL',    value: 'payments@mactor.ca' },
  { label: 'BY CHEQUE', value: 'Mactor Construction\nor Julio Cesar Macias Aguilar' },
];

async function fetchImageBuffer(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch { return null; }
}

async function generateInvoicePDF(invoice) {
  return new Promise(async (resolve, reject) => {
    const doc    = new PDFDocument({ size: 'LETTER', margin: 50 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - 100; // usable width

    // ── Header bar ──────────────────────────────────────────────
    doc.rect(50, 50, W, 4).fill(RED);

    // Company name (left)
    doc.fontSize(18).font('Helvetica-Bold').fillColor(BLACK)
       .text(COMPANY.name, 50, 65);
    doc.fontSize(9).font('Helvetica').fillColor(GRAY);
    [COMPANY.owner, COMPANY.gst, COMPANY.address, COMPANY.city,
     COMPANY.phone, COMPANY.web, COMPANY.email].forEach(line => {
      doc.text(line);
    });

    // Invoice meta (right column)
    const metaX = 370;
    doc.fontSize(20).font('Helvetica-Bold').fillColor(RED)
       .text(invoice.type === 'estimate' ? 'ESTIMATE' : 'INVOICE', metaX, 65, { width: 145, align: 'right' });

    const num    = invoice.invoiceNumber;
    const date   = new Date(invoice.invoiceDate).toLocaleDateString('en-CA');
    const metaRows = [
      ['', num],
      ['DATE', date],
      ['DUE',  invoice.dueDate || 'On Receipt'],
    ];
    doc.fontSize(8).font('Helvetica');
    let metaY = 92;
    metaRows.forEach(([label, val]) => {
      if (label) {
        doc.fillColor(GRAY).text(label, metaX, metaY, { width: 65 });
      }
      doc.fillColor(BLACK).font('Helvetica-Bold').text(val, metaX + 68, metaY, { width: 77, align: 'right' });
      doc.font('Helvetica');
      metaY += 14;
    });

    // Balance due box
    doc.rect(metaX, metaY + 4, 145, 26).fill(NAVY);
    doc.fontSize(8).fillColor('#ffffff').font('Helvetica-Bold')
       .text('BALANCE DUE', metaX + 4, metaY + 7);
    doc.fontSize(11)
       .text(`CAD $${invoice.total.toFixed(2)}`, metaX, metaY + 7, { width: 141, align: 'right' });

    // ── Bill To ─────────────────────────────────────────────────
    let y = 210;
    doc.fontSize(8).font('Helvetica-Bold').fillColor(GRAY).text('BILL TO', 50, y);
    y += 14;
    doc.fontSize(11).font('Helvetica-Bold').fillColor(BLACK).text(invoice.clientName, 50, y);
    y += 16;
    doc.fontSize(9).font('Helvetica').fillColor(BLACK);
    if (invoice.clientAddress) { doc.text(invoice.clientAddress, 50, y); y += 13; }
    if (invoice.clientPhone)   { doc.text(invoice.clientPhone,   50, y); y += 13; }
    if (invoice.clientEmail)   { doc.text(invoice.clientEmail,   50, y); y += 13; }

    // ── Line items table ─────────────────────────────────────────
    y += 16;
    const cols = { desc: 50, rate: 370, qty: 440, amt: 490 };

    // Table header
    doc.rect(50, y, W, 20).fill(NAVY);
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#ffffff');
    doc.text('DESCRIPTION', cols.desc + 4, y + 6);
    doc.text('RATE',   cols.rate, y + 6, { width: 60, align: 'right' });
    doc.text('QTY',    cols.qty,  y + 6, { width: 40, align: 'center' });
    doc.text('AMOUNT', cols.amt,  y + 6, { width: 60, align: 'right' });
    y += 20;

    // Rows
    const items = invoice.lineItems || [];
    items.forEach((item, i) => {
      const bg = i % 2 === 0 ? '#ffffff' : LIGHT;
      const startY = y;

      // measure description height
      const descText = [item.description, item.notes].filter(Boolean).join('\n');
      const descH = doc.heightOfString(item.description || '', { width: 300 }) +
                    (item.notes ? doc.heightOfString(item.notes, { width: 300, fontSize: 8 }) + 4 : 0) + 16;

      doc.rect(50, y, W, descH).fill(bg);
      doc.fontSize(9).font('Helvetica-Bold').fillColor(BLACK)
         .text(item.description || '', cols.desc + 4, y + 6, { width: 300 });

      if (item.notes) {
        const noteY = y + 6 + doc.heightOfString(item.description || '', { width: 300, fontSize: 9 }) + 2;
        doc.fontSize(8).font('Helvetica').fillColor(GRAY)
           .text(item.notes, cols.desc + 4, noteY, { width: 300 });
      }

      doc.fontSize(9).font('Helvetica').fillColor(BLACK);
      doc.text(`$${Number(item.rate || 0).toFixed(2)}`, cols.rate, y + 6, { width: 60, align: 'right' });
      doc.text(String(item.qty || 1),                   cols.qty,  y + 6, { width: 40, align: 'center' });
      doc.text(`$${Number(item.amount || 0).toFixed(2)}`,cols.amt,  y + 6, { width: 60, align: 'right' });

      y += descH;

      // page break if needed
      if (y > doc.page.height - 180) {
        doc.addPage();
        y = 50;
      }
    });

    // ── Totals + Payment ────────────────────────────────────────
    y += 20;
    if (y > doc.page.height - 160) { doc.addPage(); y = 50; }

    // Payment info (left)
    doc.fontSize(11).font('Helvetica-Bold').fillColor(BLACK).text('Payment Info', 50, y);
    let pyY = y + 18;
    PAYMENT.forEach(p => {
      doc.fontSize(8).font('Helvetica-Bold').fillColor(GRAY).text(p.label, 50, pyY);
      pyY += 12;
      doc.fontSize(9).font('Helvetica').fillColor(BLACK).text(p.value, 50, pyY, { width: 200 });
      pyY += doc.heightOfString(p.value, { width: 200 }) + 10;
    });

    // Totals (right)
    const totX  = 360;
    const totW  = 90;
    const valX  = 455;
    const valW  = 55;
    let totY = y;

    const totRows = [
      ['SUBTOTAL', `$${invoice.subtotal.toFixed(2)}`],
      ['HST (13%)', `$${invoice.hst.toFixed(2)}`],
      ['TOTAL',     `$${invoice.total.toFixed(2)}`],
    ];
    totRows.forEach(([label, val]) => {
      doc.fontSize(9).font('Helvetica').fillColor(GRAY).text(label, totX, totY, { width: totW, align: 'right' });
      doc.fillColor(BLACK).text(val, valX, totY, { width: valW, align: 'right' });
      totY += 16;
    });

    // Balance due row
    doc.rect(totX - 4, totY, 114, 22).fill(NAVY);
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#ffffff')
       .text('BALANCE DUE', totX, totY + 6, { width: totW, align: 'right' });
    doc.fontSize(10)
       .text(`CAD $${invoice.total.toFixed(2)}`, valX, totY + 6, { width: valW, align: 'right' });

    // ── Notes ───────────────────────────────────────────────────
    if (invoice.notes) {
      totY += 40;
      if (totY > doc.page.height - 80) { doc.addPage(); totY = 50; }
      doc.moveTo(50, totY).lineTo(50 + W, totY).stroke(GRAY);
      totY += 12;
      doc.fontSize(9).font('Helvetica').fillColor(BLACK).text(invoice.notes, 50, totY, { width: W });
    }

    // ── Photos ──────────────────────────────────────────────────
    const photos = invoice.photos || [];
    if (photos.length > 0) {
      doc.addPage();
      let px = 50, py = 50;
      const imgW = 230, imgH = 170, gap = 20;

      for (let i = 0; i < photos.length; i++) {
        const buf = await fetchImageBuffer(photos[i]);
        if (!buf) continue;

        try {
          doc.image(buf, px, py, { width: imgW, height: imgH, fit: [imgW, imgH] });
        } catch { continue; }

        px += imgW + gap;
        if (px + imgW > doc.page.width - 50) {
          px = 50;
          py += imgH + gap + 20;
          if (py + imgH > doc.page.height - 50) {
            doc.addPage();
            py = 50;
          }
        }
      }
    }

    doc.end();
  });
}

module.exports = { generateInvoicePDF };
