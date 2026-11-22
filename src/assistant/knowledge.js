// Business knowledge for the assistant: a compact, human-readable digest of
// every invoice, estimate, client and catalog price, written into the agent's
// memory store under /negocio/ so Mac can advise Julio from his real history
// (prices he charges, how he describes work, who pays late…). Regenerated
// weekly and on demand; the live MCP tools (search_work_history, etc.) cover
// anything newer than the last refresh.
const Anthropic = require('@anthropic-ai/sdk');
const prisma = require('../services/database');
const cfg = require('./config');

const client = new (Anthropic.default || Anthropic)();
const PREFIX = '/negocio';
const MAX_FILE = 90_000; // memory files are capped at 100KB

const money = n => `$${Number(n || 0).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = d => (d ? new Date(d).toISOString().slice(0, 10) : '—');
const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const slug = s => String(s || 'otros').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const TYPE = { invoice: 'factura', estimate: 'estimado', task: 'tarea' };
const STATUS = { draft: 'borrador', sent: 'enviada', paid: 'pagada', overdue: 'vencida', approved: 'aprobado' };

// Splits a long list of lines into files under MAX_FILE.
function chunked(basePath, header, lines) {
  const files = {};
  let part = 1, buf = header;
  for (const line of lines) {
    if (buf.length + line.length + 1 > MAX_FILE) {
      files[`${basePath}-${part}.md`] = buf;
      part += 1;
      buf = `${header.split('\n')[0]} (cont. ${part})\n\n`;
    }
    buf += `${line}\n`;
  }
  files[part === 1 ? `${basePath}.md` : `${basePath}-${part}.md`] = buf;
  return files;
}

async function buildKnowledge() {
  const [docs, clients, catalog, inspections] = await Promise.all([
    prisma.invoice.findMany({ orderBy: { invoiceDate: 'asc' } }),
    prisma.client.findMany({ orderBy: { totalInvoiced: 'desc' } }),
    prisma.serviceCatalog.findMany({ orderBy: [{ category: 'asc' }, { useCount: 'desc' }] }),
    prisma.inspection.groupBy({ by: ['status'], _count: true }),
  ]);
  const files = {};
  const invoices = docs.filter(d => d.type === 'invoice');
  const estimates = docs.filter(d => d.type === 'estimate');
  const paid = invoices.filter(d => d.status === 'paid');
  const open = invoices.filter(d => d.status === 'sent' || d.status === 'overdue');

  // ── Resumen general ───────────────────────────────────────────
  const byYear = {};
  for (const d of paid) {
    const y = new Date(d.paidAt || d.invoiceDate).getUTCFullYear();
    byYear[y] = byYear[y] || { n: 0, total: 0 };
    byYear[y].n += 1;
    byYear[y].total += d.total;
  }
  const payDays = paid.filter(d => d.paidAt).map(d => (d.paidAt - d.invoiceDate) / 86400000).filter(x => x >= 0);
  const avgPayDays = payDays.length ? Math.round(payDays.reduce((a, b) => a + b, 0) / payDays.length) : null;
  const estApproved = estimates.filter(d => d.status === 'approved').length;
  const byCategory = {};
  for (const c of catalog) {
    const k = c.category || 'General';
    byCategory[k] = byCategory[k] || { n: 0, uses: 0 };
    byCategory[k].n += 1;
    byCategory[k].uses += c.useCount;
  }

  files[`${PREFIX}/LEEME.md`] = [
    `# Negocio de Julio — resumen del historial (generado ${day(new Date())})`,
    '',
    'Fuente: sistema de facturación de MacTor Construction (inspector.fixmyproperty.ca/invoices). Úsalo para asesorar a Julio con datos reales.',
    'Para datos más recientes que esta fecha, o detalle exacto, usa las herramientas search_work_history, service_prices, find_client, list_invoices y get_invoice.',
    '',
    '## Números generales',
    `- Documentos: ${docs.length} (${invoices.length} facturas, ${estimates.length} estimados, ${docs.length - invoices.length - estimates.length} tareas). Desde ${day(docs[0]?.invoiceDate)} hasta ${day(docs.at(-1)?.invoiceDate)}.`,
    `- Facturas pagadas: ${paid.length} por ${money(paid.reduce((s, d) => s + d.total, 0))}. Factura promedio: ${money(paid.length ? paid.reduce((s, d) => s + d.total, 0) / paid.length : 0)}.`,
    `- Por cobrar ahora: ${open.length} facturas por ${money(open.reduce((s, d) => s + d.total, 0))}.`,
    `- Días promedio para cobrar (factura → pago): ${avgPayDays ?? '—'}.`,
    `- Estimados: ${estimates.length} (${estApproved} aprobados por el cliente en el sistema; muchos se aprueban por fuera y se convierten directo a factura).`,
    `- Clientes registrados: ${clients.length}. Inspecciones FixMyProperty: ${inspections.map(i => `${i.status} ${i._count}`).join(', ')}.`,
    '',
    '## Cobrado por año (facturas pagadas)',
    ...Object.entries(byYear).sort().map(([y, v]) => `- ${y}: ${v.n} facturas, ${money(v.total)}`),
    '',
    '## Tipos de trabajo (catálogo de servicios, por categoría)',
    ...Object.entries(byCategory).sort((a, b) => b[1].uses - a[1].uses).map(([k, v]) => `- ${k}: ${v.n} servicios, usados ${v.uses} veces`),
    '',
    '## Archivos en /negocio',
    '- precios/<categoria>.md — cada servicio con último precio, promedio, rango y unidad.',
    '- clientes.md — cada cliente con totales, saldo, pagos y trabajos recientes.',
    '- historial/<año>.md — cada factura/estimado con sus conceptos, descripciones y montos.',
    '',
    'Reglas: HST 13% (Ontario) salvo que la factura lo desactive. Montos en CAD. Las descripciones al cliente van en inglés.',
  ].join('\n');

  // ── Precios por categoría ─────────────────────────────────────
  const cats = {};
  for (const c of catalog) (cats[c.category || 'General'] = cats[c.category || 'General'] || []).push(c);
  for (const [cat, items] of Object.entries(cats)) {
    const lines = items.map(c => {
      const hist = Array.isArray(c.priceHistory) ? c.priceHistory.slice(-3).map(h => `${day(h.date)} ${money(h.price)}${h.clientName ? ` (${clip(h.clientName, 25)})` : ''}`).join('; ') : '';
      return `- **${clip(c.name, 90)}**${c.unit ? ` [${c.unit}]` : ''}: último ${money(c.lastPrice)} · prom ${money(c.avgPrice)} · rango ${money(c.minPrice)}–${money(c.maxPrice)} · ${c.useCount} usos${hist ? ` · recientes: ${hist}` : ''}${c.description ? `\n  ${clip(c.description, 220)}` : ''}`;
    });
    Object.assign(files, chunked(`${PREFIX}/precios/${slug(cat)}`, `# Precios — ${cat}\n\n`, lines));
  }

  // ── Clientes ──────────────────────────────────────────────────
  const docsByClient = {};
  for (const d of docs) (docsByClient[d.clientName] = docsByClient[d.clientName] || []).push(d);
  const clientLines = clients.map(c => {
    const mine = docsByClient[c.name] || [];
    const paidMine = mine.filter(d => d.type === 'invoice' && d.status === 'paid' && d.paidAt);
    const days = paidMine.map(d => (d.paidAt - d.invoiceDate) / 86400000).filter(x => x >= 0);
    const avg = days.length ? Math.round(days.reduce((a, b) => a + b, 0) / days.length) : null;
    const recent = mine.slice(-3).map(d => `${d.invoiceNumber} ${clip((d.lineItems || [])[0]?.description, 50)} ${money(d.total)}`).join('; ');
    return `- **${c.name}**${c.phone ? ` · ${c.phone}` : ''}${c.email ? ` · ${c.email}` : ''}${c.address ? ` · ${clip(c.address, 60)}` : ''}\n  ${c.invoiceCount} facturas, ${c.estimateCount} estimados · facturado ${money(c.totalInvoiced)} · pagado ${money(c.totalPaid)} · saldo ${money(c.totalInvoiced - c.totalPaid)}${avg !== null ? ` · paga en ~${avg} días` : ''} · última actividad ${day(c.lastActivity)}${c.notes ? `\n  Nota: ${clip(c.notes, 160)}` : ''}${recent ? `\n  Recientes: ${recent}` : ''}`;
  });
  Object.assign(files, chunked(`${PREFIX}/clientes`, '# Clientes (ordenados por total facturado)\n\n', clientLines));

  // ── Historial por año ─────────────────────────────────────────
  const years = {};
  for (const d of docs) (years[new Date(d.invoiceDate).getUTCFullYear()] = years[new Date(d.invoiceDate).getUTCFullYear()] || []).push(d);
  for (const [y, list] of Object.entries(years)) {
    const lines = list.map(d => {
      const items = (Array.isArray(d.lineItems) ? d.lineItems : []).map(l => {
        const qty = Number(l.qty || 1), rate = Number(l.rate || 0);
        const calc = qty !== 1 ? ` (${qty} × ${money(rate)})` : '';
        return `  - ${clip(l.description, 160)}: ${money(l.amount)}${calc}${l.notes ? ` — ${clip(l.notes, 260)}` : ''}`;
      });
      return [
        `### ${d.invoiceNumber} · ${TYPE[d.type] || d.type} ${STATUS[d.status] || d.status} · ${day(d.invoiceDate)} · ${d.clientName}${d.companyName ? ` (${d.companyName})` : ''}`,
        `Total ${money(d.total)} (subtotal ${money(d.subtotal)}${d.discount ? `, descuento ${money(d.discount)}` : ''}${d.hstEnabled ? `, HST ${money(d.hst)}` : ', sin HST'})${d.paidAt ? ` · pagada ${day(d.paidAt)}` : ''}${d.clientAddress ? ` · ${clip(d.clientAddress, 60)}` : ''}`,
        ...items,
        ...(d.notes ? [`  Notas: ${clip(d.notes, 300)}`] : []),
        '',
      ].join('\n');
    });
    Object.assign(files, chunked(`${PREFIX}/historial/${y}`, `# Historial ${y} — facturas, estimados y tareas\n\n`, lines));
  }
  return files;
}

// Writes the digest into the memory store (create or overwrite by path) and
// removes /negocio files that no longer exist (e.g. a year file got split).
async function syncKnowledge() {
  if (!cfg.memoryStoreId) throw new Error('ASSISTANT_MEMORY_STORE_ID not set');
  const files = await buildKnowledge();
  const existing = {};
  for await (const m of client.beta.memoryStores.memories.list(cfg.memoryStoreId, { path_prefix: `${PREFIX}/` })) {
    existing[m.path] = m.id;
  }
  let created = 0, updated = 0, removed = 0;
  for (const [path, content] of Object.entries(files)) {
    if (existing[path]) {
      await client.beta.memoryStores.memories.update(existing[path], { memory_store_id: cfg.memoryStoreId, content });
      updated += 1;
    } else {
      await client.beta.memoryStores.memories.create(cfg.memoryStoreId, { path, content });
      created += 1;
    }
  }
  for (const [path, id] of Object.entries(existing)) {
    if (!files[path]) {
      await client.beta.memoryStores.memories.delete(id, { memory_store_id: cfg.memoryStoreId });
      removed += 1;
    }
  }
  const bytes = Object.values(files).reduce((s, c) => s + c.length, 0);
  return { files: Object.keys(files).length, created, updated, removed, bytes };
}

// Nightly refresh at 03:00 Toronto (no model calls — just rewrites the files).
let started = false;
function startKnowledgeRefresh() {
  if (started || !cfg.memoryStoreId) return;
  started = true;
  require('node-cron').schedule('0 3 * * *', () => {
    syncKnowledge()
      .then(r => console.log('[Assistant] knowledge refreshed:', JSON.stringify(r)))
      .catch(err => console.error('[Assistant] knowledge refresh failed:', err.message));
  }, { timezone: cfg.tz });
}

module.exports = { buildKnowledge, syncKnowledge, startKnowledgeRefresh };
