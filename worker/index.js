// Leave headroom for other buckets in the same Cloudflare account's shared free allowance.
const FREE_R2_STORAGE_CAP = 8_000_000_000;
const ORDER_RETENTION_DAYS = 60;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const allowedStyles = new Set(['Comics clasic', 'Manga', 'Acuarelă', 'Cartoon', 'Noir', 'Carte pentru copii']);
const allowedOrientations = new Set(['20 × 27 cm · portret', '21 × 21 cm · pătrat', '27 × 20 cm · peisaj']);
const allowedEndings = new Set(['Lasă povestea să mă surprindă', 'Final fericit', 'Final amuzant', 'Final emoționant', 'Final deschis, pentru continuare']);
const closeStatuses = new Set(['completed', 'cancelled']);

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

function cleanString(value, max, required = false) {
  if (typeof value !== 'string') throw new Error('Datele formularului nu sunt valide.');
  const result = value.trim();
  if (result.length > max || (required && !result)) throw new Error('Completează corect toate câmpurile obligatorii.');
  return result;
}

function validateOrder(raw) {
  if (raw.acceptedOrderData !== true) throw new Error('Confirmă că datele introduse sunt corecte.');
  const characterName = cleanString(raw.characterName || '', 40);
  const pronoun = cleanString(raw.pronoun || '', 80);
  const style = cleanString(raw.style || '', 40, true);
  const format = cleanString(raw.format || '', 40, true);
  const pages = Number(raw.pages);
  const panels = Number(raw.panels);
  if (!allowedStyles.has(style) || !allowedOrientations.has(format)) throw new Error('Stilul sau formatul selectat nu este valid.');
  if (![12, 16, 20, 24, 28, 32, 36, 40].includes(pages) || !Number.isInteger(panels) || panels < 1 || panels > 6) throw new Error('Formatul poveștii nu este valid.');
  const cover = raw.cover === 'Copertă cartonată' ? 'Copertă cartonată' : raw.cover === 'Copertă moale' ? 'Copertă moale' : null;
  if (!cover) throw new Error('Alege un tip de copertă valid.');
  const ending = cleanString(raw.ending || '', 60, true);
  if (!allowedEndings.has(ending)) throw new Error('Alege un final valid.');
  const billingType = raw.billingType === 'company' ? 'company' : raw.billingType === 'individual' ? 'individual' : null;
  if (!billingType) throw new Error('Tipul de facturare nu este valid.');
  const email = cleanString(raw.email || '', 254, true);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Adresa de e-mail nu este validă.');
  const phone = cleanString(raw.phone || '', 30, true);
  const companyName = cleanString(raw.companyName || '', 120, billingType === 'company');
  const companyTaxId = cleanString(raw.companyTaxId || '', 32, billingType === 'company');
  const separateDelivery = raw.separateDelivery === true;
  const billing = {
    name: cleanString(raw.billingName || '', 120, true),
    email,
    phone,
    type: billingType,
    companyName,
    companyTaxId,
    address: cleanString(raw.billingAddress || '', 180, true),
    city: cleanString(raw.billingCity || '', 100, true),
    county: cleanString(raw.billingCounty || '', 100, true),
    postalCode: cleanString(raw.billingPostalCode || '', 16, true)
  };
  const delivery = separateDelivery ? {
    address: cleanString(raw.deliveryAddress || '', 180, true),
    city: cleanString(raw.deliveryCity || '', 100, true),
    county: cleanString(raw.deliveryCounty || '', 100, true),
    postalCode: cleanString(raw.deliveryPostalCode || '', 16, true),
    notes: cleanString(raw.deliveryNotes || '', 180)
  } : { ...billing, name: undefined, email: undefined, phone: undefined, type: undefined, companyName: undefined, companyTaxId: undefined };
  const softCover = cover === 'Copertă moale';
  const price = (softCover ? 149 : 184) + (raw.giftWrap === true ? 19 : 0) + Math.max(0, pages - 20) * 4;
  return {
    characterName, pronoun, style, format, pages, panels, cover,
    giftWrap: raw.giftWrap === true,
    proof: raw.proof === true,
    story: cleanString(raw.story || '', 700),
    dedication: cleanString(raw.dedication || '', 100),
    ending,
    payment: 'cash_on_delivery',
    price,
    billing,
    delivery
  };
}

function imageType(file) {
  return ['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
}

async function hasImageSignature(file) {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const webp = String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  return (file.type === 'image/jpeg' && jpeg) || (file.type === 'image/png' && png) || (file.type === 'image/webp' && webp);
}

async function reserveStorage(env, bytes) {
  const result = await env.DB.prepare(`UPDATE storage_usage
    SET reserved_bytes = reserved_bytes + ?
    WHERE singleton = 1 AND reserved_bytes + ? <= ?`).bind(bytes, bytes, FREE_R2_STORAGE_CAP).run();
  return result.meta.changes === 1;
}

async function releaseStorage(env, bytes) {
  if (bytes > 0) await env.DB.prepare('UPDATE storage_usage SET reserved_bytes = MAX(0, reserved_bytes - ?) WHERE singleton = 1').bind(bytes).run();
}

async function createOrder(request, env) {
  if (!env.ADMIN_TOKEN) return json({ error: 'Primirea comenzilor nu este încă activată. Încearcă din nou puțin mai târziu.' }, 503);
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'Cererea nu este permisă.' }, 403);
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 21 * 1024 * 1024) return json({ error: 'Fotografiile depășesc limita totală permisă.' }, 413);
  if (!request.headers.get('content-type')?.includes('multipart/form-data')) return json({ error: 'Formatul cererii nu este acceptat.' }, 415);
  const form = await request.formData();
  let raw;
  try { raw = JSON.parse(String(form.get('order') || '')); } catch { return json({ error: 'Detaliile comenzii nu au putut fi citite.' }, 400); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return json({ error: 'Detaliile comenzii nu sunt valide.' }, 400);
  let order;
  try { order = validateOrder(raw); } catch (error) { return json({ error: error.message }, 400); }

  const primaryPhoto = form.get('photo1');
  const secondaryPhoto = form.get('photo2');
  if (!primaryPhoto || typeof primaryPhoto.arrayBuffer !== 'function' || primaryPhoto.size <= 0) return json({ error: 'Încarcă fotografia principală pentru carte.' }, 400);
  const files = [primaryPhoto, secondaryPhoto].filter(file => file && typeof file.arrayBuffer === 'function' && file.size > 0);
  if (files.length > 2 || files.some(file => !imageType(file) || file.size > MAX_IMAGE_BYTES)) return json({ error: 'Fotografiile trebuie să fie JPG, PNG sau WEBP și să aibă maximum 10 MB fiecare.' }, 400);
  for (const file of files) if (!await hasImageSignature(file)) return json({ error: 'Unul dintre fișiere nu este o imagine validă.' }, 400);

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (!await reserveStorage(env, totalBytes)) return json({ error: 'Spațiul gratuit pentru fotografii este aproape plin. Comanda nu a fost înregistrată; contactează-ne pentru ajutor.' }, 507);

  const id = crypto.randomUUID();
  const orderNumber = `PG-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${id.slice(0, 6).toUpperCase()}`;
  const createdAt = new Date().toISOString();
  const keys = [];
  const filesMeta = [];
  try {
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      const extension = file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/png' ? 'png' : 'webp';
      const key = `orders/${id}/photo-${index + 1}.${extension}`;
      await env.ORDER_FILES.put(key, await file.arrayBuffer(), {
        httpMetadata: { contentType: file.type, cacheControl: 'private, no-store' }
      });
      keys.push(key);
      filesMeta.push({ name: cleanString(file.name || `photo-${index + 1}.${extension}`, 180), type: file.type, bytes: file.size });
    }
    order.files = filesMeta;
    await env.DB.prepare(`INSERT INTO orders (id, order_number, created_at, status, payload_json, file_keys_json, file_bytes)
      VALUES (?, ?, ?, 'new', ?, ?, ?)`).bind(id, orderNumber, createdAt, JSON.stringify(order), JSON.stringify(keys), totalBytes).run();
    return json({ ok: true, orderNumber, amount: order.price });
  } catch {
    if (keys.length) await env.ORDER_FILES.delete(keys).catch(() => {});
    await releaseStorage(env, totalBytes).catch(() => {});
    return json({ error: 'Comanda nu a putut fi salvată. Încearcă din nou.' }, 500);
  }
}

function equalSecret(a, b) {
  if (!a || !b || a.length > 512 || b.length > 512) return false;
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) diff |= (left[i] || 0) ^ (right[i] || 0);
  return diff === 0;
}

function isAdmin(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return equalSecret(token, env.ADMIN_TOKEN || '');
}

async function adminRequest(request, env, url) {
  if (!env.ADMIN_TOKEN) return json({ error: 'Accesul de administrare nu este configurat.' }, 503);
  if (!isAdmin(request, env)) return json({ error: 'Token de administrare invalid.' }, 401);

  if (request.method === 'GET' && url.pathname === '/api/admin/orders') {
    const { results } = await env.DB.prepare(`SELECT id, order_number, created_at, status, closed_at, payload_json, file_keys_json
      FROM orders ORDER BY created_at DESC LIMIT 200`).all();
    return json({ orders: results.map(row => ({
      id: row.id,
      orderNumber: row.order_number,
      createdAt: row.created_at,
      status: row.status,
      closedAt: row.closed_at,
      details: JSON.parse(row.payload_json),
      fileCount: JSON.parse(row.file_keys_json).length
    })) });
  }

  const fileMatch = url.pathname.match(/^\/api\/admin\/orders\/([a-f0-9-]+)\/files\/(0|1)$/i);
  if (request.method === 'GET' && fileMatch) {
    const row = await env.DB.prepare('SELECT file_keys_json FROM orders WHERE id = ?').bind(fileMatch[1]).first();
    if (!row) return json({ error: 'Comanda nu a fost găsită.' }, 404);
    const key = JSON.parse(row.file_keys_json)[Number(fileMatch[2])];
    if (!key) return json({ error: 'Fotografia nu a fost găsită.' }, 404);
    const object = await env.ORDER_FILES.get(key);
    if (!object) return json({ error: 'Fotografia a expirat sau a fost ștearsă.' }, 404);
    const headers = new Headers({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    return new Response(object.body, { headers });
  }

  const orderMatch = url.pathname.match(/^\/api\/admin\/orders\/([a-f0-9-]+)$/i);
  if (request.method === 'PATCH' && orderMatch) {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Cererea nu este validă.' }, 400); }
    const status = body.status;
    if (!['new', 'in_progress', 'completed', 'cancelled'].includes(status)) return json({ error: 'Statusul comenzii nu este valid.' }, 400);
    const current = await env.DB.prepare('SELECT status, closed_at FROM orders WHERE id = ?').bind(orderMatch[1]).first();
    if (!current) return json({ error: 'Comanda nu a fost găsită.' }, 404);
    const closedAt = closeStatuses.has(status) ? (current.status === status && current.closed_at ? current.closed_at : new Date().toISOString()) : null;
    await env.DB.prepare('UPDATE orders SET status = ?, closed_at = ? WHERE id = ?').bind(status, closedAt, orderMatch[1]).run();
    return json({ ok: true, status, closedAt });
  }
  return json({ error: 'Ruta nu a fost găsită.' }, 404);
}

async function cleanupExpiredOrders(env) {
  const cutoff = new Date(Date.now() - ORDER_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let deleted = 0;
  for (let batchNumber = 0; batchNumber < 10; batchNumber++) {
    const { results } = await env.DB.prepare(`SELECT id, file_keys_json, file_bytes FROM orders
      WHERE closed_at IS NOT NULL AND closed_at <= ? ORDER BY closed_at LIMIT 100`).bind(cutoff).all();
    if (!results.length) break;
    for (const row of results) {
      const keys = JSON.parse(row.file_keys_json);
      if (keys.length) await env.ORDER_FILES.delete(keys);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM orders WHERE id = ?').bind(row.id),
        env.DB.prepare('UPDATE storage_usage SET reserved_bytes = MAX(0, reserved_bytes - ?) WHERE singleton = 1').bind(row.file_bytes)
      ]);
      deleted++;
    }
  }
  return deleted;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/orders' && request.method === 'POST') return createOrder(request, env);
    if (url.pathname.startsWith('/api/admin/')) return adminRequest(request, env, url);
    if (url.pathname.startsWith('/api/')) return json({ error: 'Ruta API necunoscută.' }, 404);
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller, env) {
    await cleanupExpiredOrders(env);
  }
};
