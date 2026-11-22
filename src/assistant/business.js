// Read-only views over the Inspector MacTor database for the assistant.
// Results are compact plain objects — they go straight into the model's
// context, so only the fields Julio would care about are included.
const prisma = require('../services/database');
const { dueDateOf, reminderBlockReason } = require('../routes/invoices');
const cfg = require('./config');

const ymd = d => new Intl.DateTimeFormat('en-CA', { timeZone: cfg.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const money = n => Math.round(Number(n || 0) * 100) / 100;

// Toronto's UTC offset (ms, negative) at a given instant — handles DST.
function tzOffsetMs(date) {
  const local = new Date(date.toLocaleString('en-US', { timeZone: cfg.tz }));
  const utc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  return local - utc;
}

// [start, end) of a Toronto calendar day, `offset` days from today.
function torontoDay(offset = 0) {
  const [y, m, d] = ymd(new Date()).split('-').map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d + offset, 12));
  const start = new Date(Date.UTC(y, m - 1, d + offset) - tzOffsetMs(noon));
  return { start, end: new Date(start.getTime() + 24 * 3600 * 1000), label: ymd(noon) };
}

function invoiceRow(i) {
  const due = i.type === 'invoice' ? dueDateOf(i) : null;
  const open = i.type === 'invoice' && i.status !== 'paid' && i.status !== 'draft';
  return {
    id: i.id, number: i.invoiceNumber, type: i.type, status: i.status, nickname: i.nickname || undefined,
    client: i.clientName, company: i.companyName || undefined, phone: i.clientPhone || undefined, email: i.clientEmail || undefined,
    address: i.clientAddress || undefined, total: money(i.total),
    date: i.invoiceDate ? ymd(i.invoiceDate) : undefined,
    due: due ? due.toISOString().slice(0, 10) : undefined,
    daysPastDue: open && due ? Math.max(0, Math.floor((Date.now() - due.getTime()) / 86400000)) : undefined,
    scheduled: i.scheduledDate ? i.scheduledDate.toISOString() : undefined,
    agendaDone: i.scheduledDate ? i.agendaDone : undefined,
    sentAt: i.sentAt ? i.sentAt.toISOString() : undefined,
    paidAt: i.paidAt ? i.paidAt.toISOString() : undefined,
    items: Array.isArray(i.lineItems) ? i.lineItems.map(l => l.description).filter(Boolean).slice(0, 6) : undefined,
  };
}

function inspectionRow(x) {
  return {
    id: x.id, status: x.status, created: x.createdAt.toISOString(), category: x.issueCategory || undefined,
    service: x.serviceType, property: x.propertyType, client: x.clientName || undefined, phone: x.clientPhone || undefined,
    email: x.clientEmail || undefined, address: x.address || undefined, language: x.clientLanguage,
    problem: x.problemDescription ? x.problemDescription.slice(0, 300) : undefined,
    aiEstimateTotal: x.aiEstimate?.total ?? x.aiEstimate?.totalEstimate ?? undefined,
    reviewUrl: `https://inspector.fixmyproperty.ca/approve/${x.approvalToken}`,
  };
}

async function businessOverview() {
  const today = torontoDay(0), week = torontoDay(7);
  const monthStart = new Date(`${today.label.slice(0, 7)}-01T00:00:00Z`);
  const [todayJobs, weekJobs, openInvoices, pendingInspections, openEstimates, paidThisMonth] = await Promise.all([
    prisma.invoice.findMany({ where: { scheduledDate: { gte: today.start, lt: today.end } }, orderBy: { scheduledDate: 'asc' } }),
    prisma.invoice.findMany({ where: { scheduledDate: { gte: today.end, lt: week.end }, agendaDone: false }, orderBy: { scheduledDate: 'asc' } }),
    prisma.invoice.findMany({ where: { type: 'invoice', status: { in: ['sent', 'overdue'] } }, orderBy: { invoiceDate: 'asc' } }),
    prisma.inspection.findMany({ where: { status: { in: ['new', 'pending_approval'] } }, orderBy: { createdAt: 'desc' }, take: 10 }),
    prisma.invoice.findMany({ where: { type: 'estimate', status: 'sent' }, orderBy: { sentAt: 'desc' }, take: 10 }),
    prisma.invoice.aggregate({ where: { type: 'invoice', status: 'paid', paidAt: { gte: monthStart } }, _sum: { total: true }, _count: true }),
  ]);
  const open = openInvoices.map(invoiceRow);
  return {
    today: today.label,
    agendaToday: todayJobs.map(invoiceRow),
    agendaNext7Days: weekJobs.map(invoiceRow),
    receivables: {
      count: open.length,
      total: money(open.reduce((s, i) => s + i.total, 0)),
      overdue: open.filter(i => i.daysPastDue > 0),
    },
    inspectionsAwaitingJulio: pendingInspections.map(inspectionRow),
    estimatesAwaitingClient: openEstimates.map(invoiceRow),
    paidThisMonth: { count: paidThisMonth._count, total: money(paidThisMonth._sum.total) },
  };
}

async function listInspections({ status, limit = 10 } = {}) {
  const rows = await prisma.inspection.findMany({ where: status ? { status } : {}, orderBy: { createdAt: 'desc' }, take: Math.min(limit, 30) });
  return rows.map(inspectionRow);
}

async function getInspection(id) {
  const x = await prisma.inspection.findUnique({ where: { id } });
  if (!x) return null;
  return {
    ...inspectionRow(x), followUp: x.followUpAnswers, aiSummary: x.aiSummary,
    aiEstimate: x.aiEstimate, approvedEstimate: x.approvedEstimate, photos: x.photos,
  };
}

async function listInvoices({ type, status, client, from, to, limit = 15 } = {}) {
  const where = {};
  if (type) where.type = type;
  if (status) where.status = status;
  if (client) where.OR = [
    { clientName: { contains: client, mode: 'insensitive' } },
    { companyName: { contains: client, mode: 'insensitive' } },
  ];
  if (from || to) where.invoiceDate = { ...(from && { gte: new Date(from) }), ...(to && { lte: new Date(to) }) };
  const rows = await prisma.invoice.findMany({ where, orderBy: { invoiceDate: 'desc' }, take: Math.min(limit, 50) });
  return rows.map(invoiceRow);
}

async function getInvoice(ref) {
  const i = await prisma.invoice.findFirst({
    where: { OR: [{ id: ref }, { invoiceNumber: String(ref).toUpperCase() }] },
    include: { sendLogs: { orderBy: { sentAt: 'desc' }, take: 10 } },
  });
  if (!i) return null;
  return {
    ...invoiceRow(i), lineItems: i.lineItems, subtotal: i.subtotal, discount: i.discount, hst: i.hst, notes: i.notes,
    paymentReminderAllowed: i.type === 'invoice' ? !reminderBlockReason(i) : false,
    sends: i.sendLogs.map(l => ({ channel: l.channel, kind: l.kind, to: l.recipient, at: l.sentAt.toISOString() })),
  };
}

async function agenda({ days = 7, includeDone = false } = {}) {
  const start = torontoDay(0).start, end = torontoDay(Math.min(days, 60)).end;
  const rows = await prisma.invoice.findMany({
    where: { scheduledDate: { gte: start, lt: end }, ...(includeDone ? {} : { agendaDone: false }) },
    orderBy: { scheduledDate: 'asc' },
  });
  return rows.map(invoiceRow);
}

async function findClient(query) {
  const digits = String(query).replace(/\D/g, '');
  const rows = await prisma.client.findMany({
    where: { OR: [
      { name: { contains: query, mode: 'insensitive' } },
      { email: { contains: query, mode: 'insensitive' } },
      { address: { contains: query, mode: 'insensitive' } },
      ...(digits.length >= 4 ? [{ phone: { contains: digits } }] : []),
    ] },
    take: 5,
  });
  return rows.map(c => ({
    name: c.name, email: c.email, phone: c.phone, address: c.address, notes: c.notes,
    invoices: c.invoiceCount, estimates: c.estimateCount,
    totalInvoiced: money(c.totalInvoiced), totalPaid: money(c.totalPaid), balance: money(c.totalInvoiced - c.totalPaid),
    lastActivity: c.lastActivity?.toISOString(),
    recent: Array.isArray(c.history) ? c.history.slice(-5) : [],
  }));
}

// Accent/case-insensitive "all words must appear" matcher.
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const matcher = query => {
  const words = norm(query).split(/\s+/).filter(w => w.length > 1);
  return text => { const t = norm(text); return words.every(w => t.includes(w)); };
};

// Every line item ever billed or estimated that matches the query — how
// Julio described the work, quantities, rates and who it was for.
async function searchWorkHistory({ query, type, from, to, limit = 25 } = {}) {
  const match = matcher(query);
  const where = {};
  if (type) where.type = type;
  if (from || to) where.invoiceDate = { ...(from && { gte: new Date(from) }), ...(to && { lte: new Date(to) }) };
  const docs = await prisma.invoice.findMany({ where, orderBy: { invoiceDate: 'desc' } });
  const hits = [];
  for (const d of docs) {
    const items = Array.isArray(d.lineItems) ? d.lineItems : [];
    for (const l of items) {
      if (!match(`${l.description} ${l.notes} ${d.clientName} ${d.companyName} ${d.clientAddress} ${d.nickname}`)) continue;
      hits.push({
        number: d.invoiceNumber, type: d.type, status: d.status, date: ymd(d.invoiceDate),
        client: d.clientName, company: d.companyName || undefined, address: d.clientAddress || undefined,
        description: l.description, notes: l.notes ? String(l.notes).slice(0, 600) : undefined,
        qty: Number(l.qty || 1), rate: money(l.rate), amount: money(l.amount), documentTotal: money(d.total),
      });
    }
    if (!items.length && match(`${d.notes} ${d.clientName}`)) {
      hits.push({ number: d.invoiceNumber, type: d.type, status: d.status, date: ymd(d.invoiceDate), client: d.clientName, notes: String(d.notes || '').slice(0, 600), documentTotal: money(d.total) });
    }
  }
  return { matches: hits.length, results: hits.slice(0, Math.min(limit, 60)) };
}

// Catalog prices (built automatically from every estimate/invoice line).
async function servicePrices({ query, category, limit = 20 } = {}) {
  const rows = await prisma.serviceCatalog.findMany({
    where: category ? { category: { equals: category, mode: 'insensitive' } } : {},
    orderBy: { useCount: 'desc' },
  });
  const match = query ? matcher(query) : () => true;
  return rows.filter(c => match(`${c.name} ${c.description} ${c.category}`)).slice(0, Math.min(limit, 50)).map(c => ({
    name: c.name, category: c.category, unit: c.unit || undefined, description: c.description || undefined,
    lastPrice: money(c.lastPrice), avgPrice: money(c.avgPrice), minPrice: money(c.minPrice), maxPrice: money(c.maxPrice),
    timesUsed: c.useCount,
    recent: Array.isArray(c.priceHistory) ? c.priceHistory.slice(-5) : [],
  }));
}

module.exports = {
  businessOverview, listInspections, getInspection, listInvoices, getInvoice, agenda, findClient, torontoDay, ymd,
  searchWorkHistory, servicePrices,
};
