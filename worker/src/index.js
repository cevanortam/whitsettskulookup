// CEVA SKU lookup API.
//
// Public:  GET  /api/sku/:sku          one SKU (unit cost only with an admin token)
//          GET  /api/search?q=&after=  up to 50 matches for the Browse panel
//          GET  /api/stats             catalog counts
//          GET  /api/photo/:sku        the SKU's photo
//          POST /api/login             { password } -> { token, expires }
// Admin:   PUT    /api/sku/:sku        { description, notes } create or update
//          DELETE /api/sku/:sku
//          PUT    /api/sku/:sku/photo  raw image body (jpeg/png/webp, max 1 MB)
//          DELETE /api/sku/:sku/photo

const TOKEN_TTL_MS   = 12 * 60 * 60 * 1000;
const MAX_PHOTO_SIZE = 1_000_000;
const PHOTO_TYPES    = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const SEARCH_LIMIT   = 50;
const MAX_TEXT       = 4000;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const res = await route(request, env);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      return json({ error: status === 500 ? 'Server error' : e.message }, status, cors);
    }
  },
};

async function route(request, env) {
  const url   = new URL(request.url);
  const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  const m     = request.method;
  if (parts[0] !== 'api') throw new HttpError(404, 'Not found');

  const [, resource, rawSku, sub] = parts;

  if (resource === 'login' && m === 'POST')  return login(request, env);
  if (resource === 'stats' && m === 'GET')   return stats(env);
  if (resource === 'search' && m === 'GET')  return search(url, env);
  if (resource === 'photo' && rawSku && m === 'GET') return getPhoto(normalizeSku(rawSku), env);

  if (resource === 'sku' && rawSku) {
    const sku = normalizeSku(rawSku);
    if (!sub) {
      if (m === 'GET')    return getSku(sku, await isAdmin(request, env), env);
      if (m === 'PUT')    { await requireAdmin(request, env); return putSku(sku, request, env); }
      if (m === 'DELETE') { await requireAdmin(request, env); return deleteSku(sku, env); }
    }
    if (sub === 'photo') {
      if (m === 'PUT')    { await requireAdmin(request, env); return putPhoto(sku, request, env); }
      if (m === 'DELETE') { await requireAdmin(request, env); return deletePhoto(sku, env); }
    }
  }
  throw new HttpError(404, 'Not found');
}

// ── Lookups ────────────────────────────────────────────

async function getSku(sku, admin, env) {
  if (!sku) throw new HttpError(400, 'SKU is required');
  let row = await env.DB.prepare('SELECT * FROM skus WHERE sku = ?').bind(sku).first();
  // A Material number with hyphens normalizes to its SKU already; this also
  // catches the rare Material that differs from the SKU in other ways.
  if (!row) row = await env.DB.prepare('SELECT * FROM skus WHERE upper(material) = ?').bind(sku).first();
  if (!row) throw new HttpError(404, `No item matches SKU "${sku}"`);
  return json(toItem(row, admin));
}

async function search(url, env) {
  const q     = (url.searchParams.get('q') || '').trim();
  const after = normalizeSku(url.searchParams.get('after') || '');

  if (!q) {
    const { results } = await env.DB.prepare(
      `SELECT sku, description, photo_key FROM skus WHERE sku > ? ORDER BY sku LIMIT ?`
    ).bind(after, SEARCH_LIMIT).all();
    return json({ items: results.map(toListItem), more: results.length === SEARCH_LIMIT });
  }

  const words = q.split(/\s+/).map(w => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  if (!words.length) return json({ items: [], more: false });
  const ftsQuery = words.map(w => `"${w}"*`).join(' ');
  const prefix   = normalizeSku(q);

  // SKU prefix matches first (uses the primary key index), then word matches.
  const { results } = await env.DB.prepare(
    `SELECT sku, description, photo_key FROM (
       SELECT sku, description, photo_key, 0 AS rank_group FROM skus
        WHERE ?1 <> '' AND sku >= ?1 AND sku < ?1 || '~'
       UNION
       SELECT s.sku, s.description, s.photo_key, 1 AS rank_group
         FROM skus_fts f JOIN skus s ON s.rowid = f.rowid
        WHERE skus_fts MATCH ?2
     )
     GROUP BY sku
     ORDER BY min(rank_group), sku
     LIMIT ?3`
  ).bind(prefix, ftsQuery, SEARCH_LIMIT).all();
  return json({ items: results.map(toListItem), more: false });
}

async function stats(env) {
  const row = await env.DB.prepare(
    `SELECT count(*) AS total, count(photo_key) AS with_photos FROM skus`
  ).first();
  return json({ total: row.total, withPhotos: row.with_photos });
}

async function getPhoto(sku, env) {
  const row = await env.DB.prepare('SELECT photo_key FROM skus WHERE sku = ?').bind(sku).first();
  if (!row || !row.photo_key) throw new HttpError(404, 'No photo');
  const obj = await env.PHOTOS.get(row.photo_key);
  if (!obj) throw new HttpError(404, 'No photo');
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
      // The page requests ?v=<photo key>, so a new photo gets a new URL.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}

// ── Admin edits ────────────────────────────────────────

async function putSku(sku, request, env) {
  if (!sku) throw new HttpError(400, 'SKU is required');
  const body        = await readJson(request);
  const description = cleanText(body.description);
  const notes       = cleanText(body.notes);
  await env.DB.prepare(
    `INSERT INTO skus (sku, material, description, notes, updated) VALUES (?1, ?1, ?2, ?3, ?4)
     ON CONFLICT(sku) DO UPDATE SET description = ?2, notes = ?3, updated = ?4`
  ).bind(sku, description, notes, today()).run();
  return getSku(sku, true, env);
}

async function deleteSku(sku, env) {
  const row = await env.DB.prepare('SELECT photo_key FROM skus WHERE sku = ?').bind(sku).first();
  if (!row) throw new HttpError(404, `No item matches SKU "${sku}"`);
  await env.DB.prepare('DELETE FROM skus WHERE sku = ?').bind(sku).run();
  if (row.photo_key) await env.PHOTOS.delete(row.photo_key);
  return json({ ok: true });
}

async function putPhoto(sku, request, env) {
  const type = (request.headers.get('Content-Type') || '').split(';')[0].trim();
  const ext  = PHOTO_TYPES[type];
  if (!ext) throw new HttpError(415, 'Photo must be JPEG, PNG or WEBP');
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength) throw new HttpError(400, 'Photo is empty');
  if (bytes.byteLength > MAX_PHOTO_SIZE) throw new HttpError(413, 'Photo is larger than 1 MB');

  const row = await env.DB.prepare('SELECT photo_key FROM skus WHERE sku = ?').bind(sku).first();
  if (!row) throw new HttpError(404, `No item matches SKU "${sku}"`);

  const key = `${sku}/${Date.now()}.${ext}`;
  await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: type } });
  await env.DB.prepare('UPDATE skus SET photo_key = ?, updated = ? WHERE sku = ?')
    .bind(key, today(), sku).run();
  if (row.photo_key) await env.PHOTOS.delete(row.photo_key);
  return getSku(sku, true, env);
}

async function deletePhoto(sku, env) {
  const row = await env.DB.prepare('SELECT photo_key FROM skus WHERE sku = ?').bind(sku).first();
  if (!row) throw new HttpError(404, `No item matches SKU "${sku}"`);
  await env.DB.prepare('UPDATE skus SET photo_key = NULL, updated = ? WHERE sku = ?')
    .bind(today(), sku).run();
  if (row.photo_key) await env.PHOTOS.delete(row.photo_key);
  return getSku(sku, true, env);
}

// ── Auth ───────────────────────────────────────────────
// The password lives only in the ADMIN_PASSWORD secret. A successful login
// returns a token signed with it, so changing the password ends every session.

async function login(request, env) {
  if (!env.ADMIN_PASSWORD) throw new HttpError(503, 'Admin password is not configured');
  const { password } = await readJson(request);
  if (typeof password !== 'string' || !(await safeEqual(password, env.ADMIN_PASSWORD))) {
    await new Promise(r => setTimeout(r, 750)); // slow down guessing
    throw new HttpError(401, 'Incorrect password');
  }
  const expires = Date.now() + TOKEN_TTL_MS;
  return json({ token: `${expires}.${await sign(String(expires), env.ADMIN_PASSWORD)}`, expires });
}

async function isAdmin(request, env) {
  const auth  = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const [expires, sig] = token.split('.');
  if (!expires || !sig || !env.ADMIN_PASSWORD || Number(expires) < Date.now()) return false;
  return safeEqual(sig, await sign(expires, env.ADMIN_PASSWORD));
}

async function requireAdmin(request, env) {
  if (!(await isAdmin(request, env))) throw new HttpError(401, 'Admin login required');
}

async function sign(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Compares digests so the time taken doesn't depend on where strings differ.
async function safeEqual(a, b) {
  const digest = async s => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [da, db] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i] ^ db[i];
  return diff === 0;
}

// ── Helpers ────────────────────────────────────────────

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// SKUs are uppercase letters and digits; Material numbers add hyphens.
function normalizeSku(s) {
  return decodeURIComponentSafe(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function toItem(row, admin) {
  const item = {
    sku:         row.sku,
    material:    row.material,
    description: row.description,
    notes:       row.notes,
    photo:       row.photo_key ? `/api/photo/${row.sku}?v=${encodeURIComponent(row.photo_key)}` : null,
    updated:     row.updated,
  };
  if (admin) item.unitCost = row.unit_cost;
  return item;
}

function toListItem(row) {
  return { sku: row.sku, description: row.description, hasPhoto: !!row.photo_key };
}

function cleanText(v) {
  return typeof v === 'string' ? v.trim().slice(0, MAX_TEXT) : '';
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function readJson(request) {
  try { return await request.json(); } catch { throw new HttpError(400, 'Expected a JSON body'); }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

function corsHeaders(request, env) {
  const origin  = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
  const allow   = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age':       '86400',
    'Vary':                         'Origin',
  };
}
