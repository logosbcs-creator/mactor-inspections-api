// Photos Julio sends Mac over WhatsApp. Each one is uploaded to Cloudinary and
// logged as an AssistantEvent (direction "photo") so Mac can later attach it to
// an email or put it in an estimate/invoice (Invoice.photos → shown in the PDF).
const prisma = require('../services/database');
const { uploadPhoto } = require('../services/cloudinary');

const FOLDER = 'mac-whatsapp';

async function save(buffer, mime, caption) {
  const ext = (mime.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  const up = await uploadPhoto(buffer, `wa.${ext}`, FOLDER);
  return prisma.assistantEvent.create({
    data: {
      direction: 'photo', channel: 'whatsapp', text: caption || '',
      meta: { url: up.secure_url, publicId: up.public_id, width: up.width, height: up.height, mime },
    },
  });
}

const shape = e => ({ photo_id: e.id, url: e.meta?.url, received: e.createdAt.toISOString(), caption: e.text || null });

async function recent({ limit = 10, days = 30 } = {}) {
  const rows = await prisma.assistantEvent.findMany({
    where: { direction: 'photo', createdAt: { gte: new Date(Date.now() - days * 86400e3) } },
    orderBy: { createdAt: 'desc' }, take: Math.min(limit, 50),
  });
  return rows.map(shape);
}

// photo ids → [{ photo_id, url, caption }]; throws if any id is unknown.
async function resolve(ids = []) {
  if (!ids.length) return [];
  const rows = await prisma.assistantEvent.findMany({ where: { id: { in: ids }, direction: 'photo' } });
  const byId = new Map(rows.map(r => [r.id, r]));
  const missing = ids.filter(id => !byId.has(id));
  if (missing.length) throw new Error(`Fotos no encontradas: ${missing.join(', ')} (usa list_photos)`);
  return ids.map(id => shape(byId.get(id)));
}

// Downloads a stored photo as an email attachment (Cloudinary serves it as JPEG).
async function toAttachment(url, i) {
  const jpg = url.replace('/upload/', '/upload/f_jpg,q_auto,w_1600,c_limit/');
  const res = await fetch(jpg);
  if (!res.ok) throw new Error(`No pude descargar la foto ${i + 1} (${res.status})`);
  return { filename: `photo-${i + 1}.jpg`, mime: 'image/jpeg', content: Buffer.from(await res.arrayBuffer()) };
}

module.exports = { save, recent, resolve, toAttachment };
