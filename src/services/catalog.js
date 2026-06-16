const prisma = require('./database');

function detectCategory(name) {
  const n = name.toLowerCase();
  if (n.includes('masonry') || n.includes('brick') || n.includes('stucco') || n.includes('tuck') || n.includes('mortar')) return 'Masonry';
  if (n.includes('drain') || n.includes('gravel') || n.includes('waterproof') || n.includes('moisture') || n.includes('weeping')) return 'Drainage';
  if (n.includes('landscape') || n.includes('topsoil') || n.includes('mulch') || n.includes('shrub') || n.includes('plant') || n.includes('garden')) return 'Landscaping';
  if (n.includes('cleanup') || n.includes('disposal') || n.includes('debris') || n.includes('haul')) return 'Cleanup';
  if (n.includes('foundation') || n.includes('skirt') || n.includes('parging') || n.includes('footing')) return 'Foundation';
  if (n.includes('paint') || n.includes('coat') || n.includes('prime') || n.includes('seal')) return 'Coating';
  if (n.includes('fence') || n.includes('gate') || n.includes('post')) return 'Fencing';
  if (n.includes('roof') || n.includes('shingle') || n.includes('flashing')) return 'Roofing';
  if (n.includes('window') || n.includes('door') || n.includes('caulk')) return 'Windows & Doors';
  if (n.includes('concrete') || n.includes('cement') || n.includes('pour') || n.includes('slab')) return 'Concrete';
  if (n.includes('floor') || n.includes('tile') || n.includes('epoxy')) return 'Flooring';
  if (n.includes('drywall') || n.includes('plaster') || n.includes('patch')) return 'Drywall';
  if (n.includes('spray') || n.includes('stain') || n.includes('resurface')) return 'Spray & Coating';
  if (n.includes('eave') || n.includes('gutter') || n.includes('soffit') || n.includes('fascia')) return 'Eaves & Gutters';
  if (n.includes('insul')) return 'Insulation';
  if (n.includes('deck') || n.includes('porch') || n.includes('patio')) return 'Decking';
  return 'General';
}

async function upsertCatalogItem({ name, price, unit, description }, estimateNumber, clientName, date) {
  if (!name || price == null) return;
  const cleanName = String(name).trim();
  const cleanPrice = Number(price);
  if (!cleanName || isNaN(cleanPrice) || cleanPrice <= 0) return;

  const entry = {
    date:           date instanceof Date ? date.toISOString().split('T')[0] : String(date).split('T')[0],
    price:          cleanPrice,
    estimateNumber: estimateNumber || '?',
    clientName:     clientName     || 'Unknown',
  };

  try {
    const existing = await prisma.serviceCatalog.findUnique({ where: { name: cleanName } });

    if (existing) {
      const history = Array.isArray(existing.priceHistory) ? existing.priceHistory : [];
      history.push(entry);
      const prices = history.map(h => Number(h.price));
      await prisma.serviceCatalog.update({
        where: { name: cleanName },
        data: {
          lastPrice:    cleanPrice,
          minPrice:     Math.min(...prices),
          maxPrice:     Math.max(...prices),
          avgPrice:     Math.round(prices.reduce((s, p) => s + p, 0) / prices.length * 100) / 100,
          useCount:     { increment: 1 },
          description:  description || existing.description,
          unit:         unit        || existing.unit,
          priceHistory: history,
        },
      });
    } else {
      await prisma.serviceCatalog.create({
        data: {
          name:         cleanName,
          category:     detectCategory(cleanName),
          description:  description || null,
          unit:         unit        || 'lump sum',
          lastPrice:    cleanPrice,
          minPrice:     cleanPrice,
          maxPrice:     cleanPrice,
          avgPrice:     cleanPrice,
          useCount:     1,
          priceHistory: [entry],
        },
      });
    }
  } catch (err) {
    console.error(`[Catalog] Failed to upsert "${cleanName}":`, err.message);
  }
}

module.exports = { upsertCatalogItem, detectCategory };
