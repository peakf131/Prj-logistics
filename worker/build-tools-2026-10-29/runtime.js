/* ===================== PRJ Logistics server on Cloudflare Workers =====================
   Runtime layer: gives the business code (ported from the Google Apps Script) the same
   building blocks it used before (sheets, cache, settings, email, web requests),
   but backed by Cloudflare D1 (database) and Resend (email).
   ======================================================================================= */

/* ---------- small helpers ---------- */
const enc = new TextEncoder();
function b64ToBytes(b64) { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
function bytesToB64(u) { let s = ''; const CH = 0x8000; for (let i = 0; i < u.length; i += CH) s += String.fromCharCode.apply(null, u.subarray(i, i + CH)); return btoa(s); }
function toU8(x) {
  if (x instanceof Uint8Array) return x;
  if (typeof x === 'string') return enc.encode(x);
  if (Array.isArray(x)) return Uint8Array.from(x.map(b => b & 255));
  return enc.encode(String(x));
}
const signed = u => Array.from(u, b => (b > 127 ? b - 256 : b));

/* ---------- SHA-256 and HMAC (synchronous, same results as Google Apps Script) ---------- */
const K256 = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
function sha256(msg) {
  msg = toU8(msg);
  const l = msg.length, nb = ((l + 9 + 63) >> 6) << 6, m = new Uint8Array(nb);
  m.set(msg); m[l] = 0x80;
  const bits = l * 8, dv = new DataView(m.buffer);
  dv.setUint32(nb - 4, bits >>> 0); dv.setUint32(nb - 8, Math.floor(bits / 0x100000000));
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a, h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let o = 0; o < nb; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  const out = new Uint8Array(32), od = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((v, i) => od.setUint32(i * 4, v >>> 0));
  return out;
}
function hmacSha256(message, key) {
  let k = toU8(key);
  if (k.length > 64) k = sha256(k);
  const kp = new Uint8Array(64); kp.set(k);
  const ip = new Uint8Array(64), op = new Uint8Array(64);
  for (let i = 0; i < 64; i++) { ip[i] = kp[i] ^ 0x36; op[i] = kp[i] ^ 0x5c; }
  const m = toU8(message), inner = new Uint8Array(64 + m.length); inner.set(ip); inner.set(m, 64);
  const ih = sha256(inner), outer = new Uint8Array(96); outer.set(op); outer.set(ih, 64);
  return sha256(outer);
}

/* ---------- dates (Europe/London) in the formats the business code uses ---------- */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function tzParts(d, tz) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' });
  const p = {}; f.formatToParts(d).forEach(x => { p[x.type] = x.value; });
  let off = String(p.timeZoneName || 'GMT').replace('GMT', '');
  if (!off) off = 'Z';
  return { y: p.year, M: p.month, d: p.day, H: p.hour, m: p.minute, s: p.second, off: off };
}
function formatDate(date, tz, pattern) {
  const d = date instanceof Date ? date : new Date(date);
  const p = tzParts(d, tz);
  return String(pattern).replace(/'[^']*'|yyyy|MMM|MM|dd|d|HH|mm|ss|XXX/g, t => {
    if (t[0] === "'") return t.slice(1, -1);
    switch (t) {
      case 'yyyy': return p.y; case 'MMM': return MONTHS[+p.M - 1]; case 'MM': return p.M;
      case 'dd': return p.d; case 'd': return String(+p.d); case 'HH': return p.H; case 'mm': return p.m;
      case 'ss': return p.s; case 'XXX': return p.off;
    }
    return t;
  });
}

/* ---------- values stored in the database: dates survive the round trip ---------- */
const pack = rows => JSON.stringify(rows, function (k, v) { const raw = this[k]; return raw instanceof Date ? { $d: raw.toISOString() } : v; });
const unpack = s => JSON.parse(s, (k, v) => (v && typeof v === 'object' && typeof v.$d === 'string' && Object.keys(v).length === 1) ? new Date(v.$d) : v);
const clone = v => (v instanceof Date ? new Date(v.getTime()) : v);

/* ---------- one "sheet" (a table of rows), loaded at the start of a request, saved at the end ---------- */
class Sheet {
  constructor(rt, name, rows, ids) { this.rt = rt; this.name = name; this.rows = rows || []; this.ids = ids || []; this.dirty = new Set(); this.deleted = []; }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getMaxColumns() { let m = 26; this.rows.forEach(r => { if (r.length > m) m = r.length; }); return m; }
  getDataRange() { const w = this.getMaxColumns(); return { getValues: () => this.rows.map(r => { const o = r.map(clone); while (o.length < w) o.push(''); return o; }) }; }
  _row(i) { while (this.rows.length < i) { this.rows.push([]); this.ids.push(null); } return this.rows[i - 1]; }
  _mark(i) { this.dirty.add(i - 1); }
  getRange(r, c, nr, nc) {
    nr = nr || 1; nc = nc || 1; const sh = this;
    return {
      getValue: () => { const row = sh.rows[r - 1] || []; const v = row[c - 1]; return v === undefined || v === null ? '' : clone(v); },
      getValues: () => { const out = []; for (let i = 0; i < nr; i++) { const row = sh.rows[r - 1 + i] || []; const o = []; for (let j = 0; j < nc; j++) { const v = row[c - 1 + j]; o.push(v === undefined || v === null ? '' : clone(v)); } out.push(o); } return out; },
      setValue: v => { const row = sh._row(r); while (row.length < c - 1) row.push(''); row[c - 1] = v; sh._mark(r); },
      setValues: vs => { vs.forEach((vals, i) => { const row = sh._row(r + i); while (row.length < c - 1) row.push(''); vals.forEach((v, j) => { row[c - 1 + j] = v; }); sh._mark(r + i); }); }
    };
  }
  appendRow(arr) { this.rows.push(arr.slice()); this.ids.push(null); this._mark(this.rows.length); }
  deleteRow(n) {
    const id = this.ids[n - 1]; if (id) this.deleted.push(id);
    this.rows.splice(n - 1, 1); this.ids.splice(n - 1, 1);
    const d = new Set(); this.dirty.forEach(i => { if (i < n - 1) d.add(i); else if (i > n - 1) d.add(i - 1); }); this.dirty = d;
  }
  statements(db) {
    const st = [];
    this.deleted.forEach(id => st.push(db.prepare('DELETE FROM rows WHERE id = ?').bind(id)));
    [...this.dirty].sort((a, b) => a - b).forEach(i => {
      const data = pack(this.rows[i]);
      if (this.ids[i]) st.push(db.prepare('UPDATE rows SET data = ? WHERE id = ?').bind(data, this.ids[i]));
      else st.push(db.prepare('INSERT INTO rows (sheet, data) VALUES (?, ?)').bind(this.name, data));
    });
    return st;
  }
}
/* sheets that are only ever added to (Log, Messages): not loaded, rows are just inserted */
class AppendSheet {
  constructor(rt, name) { this.rt = rt; this.name = name; this.added = []; }
  getName() { return this.name; }
  appendRow(arr) { this.added.push(arr.slice()); }
  getLastRow() { return 1; }
  statements(db) { return this.added.map(r => db.prepare('INSERT INTO rows (sheet, data) VALUES (?, ?)').bind(this.name, pack(r))); }
}
const APPEND_ONLY = ['Log'];
const LOADED = ['Deliveries', 'Reviews', 'Clients', 'Problems', 'Messages', 'Notes', 'Invoices', 'Outreach', 'Companies'];

/* ---------- the runtime for one request ---------- */
class Runtime {
  constructor(env, ctx, origin) {
    this.env = env; this.ctx = ctx; this.origin = origin; this.db = env.DB;
    this.sheets = {}; this.props = {}; this.propsDirty = {}; this.cache = {}; this.cacheDirty = {};
    this.queue = []; this.photos = []; this.photoDeletes = [];
  }
  async preload() {
    const db = this.db;
    const [rows, props, cache] = await db.batch([
      db.prepare('SELECT id, sheet, data FROM rows WHERE sheet IN (' + LOADED.map(() => '?').join(',') + ') ORDER BY id').bind(...LOADED),
      db.prepare('SELECT k, v FROM props'),
      db.prepare('SELECT k, v FROM cache WHERE exp > ?').bind(Date.now())
    ]);
    const by = {};
    (rows.results || []).forEach(r => { (by[r.sheet] = by[r.sheet] || { rows: [], ids: [] }); by[r.sheet].rows.push(unpack(r.data)); by[r.sheet].ids.push(r.id); });
    Object.keys(by).forEach(n => { this.sheets[n] = new Sheet(this, n, by[n].rows, by[n].ids); });
    APPEND_ONLY.forEach(n => { this.sheets[n] = new AppendSheet(this, n); });
    (props.results || []).forEach(r => { this.props[r.k] = r.v; });
    (cache.results || []).forEach(r => { this.cache[r.k] = r.v; });
  }
  async flush() {
    const db = this.db, st = [];
    Object.values(this.sheets).forEach(s => st.push(...s.statements(db)));
    Object.keys(this.propsDirty).forEach(k => {
      const v = this.props[k];
      st.push(v === undefined ? db.prepare('DELETE FROM props WHERE k = ?').bind(k) : db.prepare('INSERT INTO props (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, String(v)));
    });
    Object.keys(this.cacheDirty).forEach(k => {
      const c = this.cacheDirty[k];
      st.push(c === null ? db.prepare('DELETE FROM cache WHERE k = ?').bind(k) : db.prepare('INSERT INTO cache (k, v, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp').bind(k, c.v, c.exp));
    });
    this.photos.forEach(p => {
      const CH = 900000;
      for (let i = 0, part = 0; i < p.b64.length; i += CH, part++) st.push(db.prepare('INSERT INTO photos (id, part, ref, name, mime, size, created, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(p.id, part, p.ref, p.name, p.mime, p.size, new Date().toISOString(), p.b64.slice(i, i + CH)));
    });
    this.photoDeletes.forEach(id => st.push(db.prepare('DELETE FROM photos WHERE id = ?').bind(id)));
    if (Math.random() < 0.02) st.push(db.prepare('DELETE FROM cache WHERE exp < ?').bind(Date.now()));
    for (let i = 0; i < st.length; i += 50) await db.batch(st.slice(i, i + 50));
  }
}

let RT = null;   // runtime of the request being handled (requests run one at a time, see the lock in fetch)

/* ---------- Google Apps Script building blocks, rebuilt on the runtime ---------- */
const SpreadsheetApp = {
  getActive: () => ({
    getSheetByName: n => RT.sheets[n] || null,
    insertSheet: n => (RT.sheets[n] = APPEND_ONLY.indexOf(n) >= 0 ? new AppendSheet(RT, n) : new Sheet(RT, n, [], []))
  })
};
const PropertiesService = {
  getScriptProperties: () => ({
    getProperty: k => {
      if (RT.props[k] !== undefined && RT.props[k] !== null && RT.props[k] !== '') return RT.props[k];
      const envMap = { tomtom_key: 'TOMTOM_KEY', tg_token: 'TG_TOKEN', tg_chats: 'TG_CHATS' };
      return envMap[k] && RT.env[envMap[k]] ? String(RT.env[envMap[k]]) : null;
    },
    setProperty: (k, v) => { RT.props[k] = String(v); RT.propsDirty[k] = 1; },
    deleteProperty: k => { delete RT.props[k]; RT.propsDirty[k] = 1; },
    getProperties: () => Object.assign({}, RT.props)
  })
};
const CacheService = {
  getScriptCache: () => ({
    get: k => (RT.cache[k] === undefined ? null : RT.cache[k]),
    put: (k, v, ttl) => { RT.cache[k] = String(v); RT.cacheDirty[k] = { v: String(v), exp: Date.now() + (ttl || 600) * 1000 }; },
    remove: k => { delete RT.cache[k]; RT.cacheDirty[k] = null; },
    removeAll: ks => ks.forEach(k => { delete RT.cache[k]; RT.cacheDirty[k] = null; })
  })
};
const LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
const Logger = { log: (...a) => console.log(...a) };
function makeBlob(bytes, type, name) {
  const u = toU8(bytes);
  return { bytes: u, type: type || 'application/octet-stream', name: name || 'file', getBytes: () => signed(u), getContentType() { return this.type; }, getName() { return this.name; } };
}
const Utilities = {
  formatDate: formatDate,
  getUuid: () => crypto.randomUUID(),
  DigestAlgorithm: { SHA_256: 'SHA_256' },
  computeDigest: (alg, x) => signed(sha256(toU8(x))),
  computeHmacSha256Signature: (text, key) => signed(hmacSha256(text, key)),
  newBlob: (data, type, name) => makeBlob(data === undefined ? '' : data, type, name),
  base64Decode: s => b64ToBytes(String(s)),
  base64Encode: x => bytesToB64(toU8(x))
};
const ContentService = { MimeType: { JSON: 'application/json' }, createTextOutput: () => { const o = { c: '', setMimeType() { return o; }, setContent(x) { o.c = x; return o; } }; return o; } };

/* web requests (address lookup, routes, Telegram) */
const UrlFetchApp = {
  fetch: async (url, opts) => {
    opts = opts || {};
    const init = { method: (opts.method || 'get').toUpperCase(), headers: {} };
    if (opts.payload !== undefined) {
      if (typeof opts.payload === 'object') { init.body = new URLSearchParams(opts.payload).toString(); init.headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
      else { init.body = String(opts.payload); if (opts.contentType) init.headers['Content-Type'] = opts.contentType; }
    }
    init.headers['User-Agent'] = 'PRJ-Logistics-Server/1.0 (+https://www.prjlogistics.co.uk)';
    Object.assign(init.headers, opts.headers || {});
    try {
      const r = await fetch(url, init), text = await r.text();
      return { getResponseCode: () => r.status, getContentText: () => text };
    } catch (e) { return { getResponseCode: () => 599, getContentText: () => String(e) }; }
  }
};

/* emails go out through Resend after the reply has been sent to the browser */
function queueEmail(o) {
  const env = RT.env, fromAddr = env.MAIL_FROM_ADDRESS || 'contact@prjlogistics.co.uk';
  const attachments = [];
  (o.attachments || []).forEach((b, i) => { if (b && b.bytes) attachments.push({ filename: b.name || ('photo' + (i + 1) + '.jpg'), content: bytesToB64(b.bytes) }); });
  Object.keys(o.inlineImages || {}).forEach(cid => { const b = o.inlineImages[cid]; if (b && b.bytes) attachments.push({ filename: (b.name || cid + '.png'), content: bytesToB64(b.bytes), content_id: cid }); });
  const body = {
    from: (o.name || 'PRJ Logistics Ltd') + ' <' + fromAddr + '>',
    to: [String(o.to)], subject: String(o.subject || ''),
    text: o.body ? String(o.body) : undefined, html: o.htmlBody ? String(o.htmlBody) : undefined,
    reply_to: o.replyTo ? [String(o.replyTo)] : undefined,
    bcc: o.bcc && String(o.bcc).toLowerCase() !== String(o.to).toLowerCase() ? [String(o.bcc)] : undefined,   // e.g. a copy of an outreach email to contact@
    attachments: attachments.length ? attachments : undefined
  };
  if (env.TEST_OUTBOX) { env.TEST_OUTBOX.push(body); return; }
  RT.queue.push(async () => {
    if (!env.RESEND_API_KEY) { await logDirect(env, 'Email not sent (no RESEND_API_KEY): ' + body.subject); return; }
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) await logDirect(env, 'Email failed (' + r.status + ') ' + body.subject + ': ' + (await r.text()).slice(0, 200));
  });
}
const MailApp = { sendEmail: o => queueEmail(o), getRemainingDailyQuota: () => 100 };
const GmailApp = { getAliases: () => [], sendEmail: (to, subject, body, opt) => queueEmail(Object.assign({ to: to, subject: subject, body: body }, opt || {})) };
async function logDirect(env, msg) {
  try { await env.DB.prepare('INSERT INTO rows (sheet, data) VALUES (?, ?)').bind('Log', pack([new Date(), 'ERROR', String(msg).slice(0, 300), '', ''])).run(); } catch (e) { console.log(msg); }
}

/* proof-of-delivery photos are kept in the database (table "photos") */
function photoFile(p) {
  return {
    id: p.id, getId: () => p.id, getName: () => p.name, getMimeType: () => p.mime, getSize: () => p.size,
    getBlob: () => makeBlob(b64ToBytes(p.b64), p.mime, p.name), setSharing() {}, setTrashed() { RT.photoDeletes.push(p.id); RT.photos = RT.photos.filter(x => x.id !== p.id); }, getUrl: () => RT.origin + '/photo/' + p.id
  };
}
const DriveApp = {
  Access: { ANYONE_WITH_LINK: 1 }, Permission: { VIEW: 1 },
  folder: {
    createFile: blob => {
      const ref = (/^(PRJ-[A-Z0-9-]+?)-(Collected|Delivered|Problem)-/.exec(blob.name || '') || [])[1] || '';
      const p = { id: crypto.randomUUID().replace(/-/g, ''), ref: ref, name: blob.name, mime: blob.type || 'image/jpeg', size: blob.bytes.length, b64: bytesToB64(blob.bytes) };
      RT.photos.push(p);
      return photoFile(p);
    }
  }
};
async function photosForRef(ref) {
  const res = await RT.db.prepare('SELECT id, part, name, mime, size, data FROM photos WHERE ref = ? ORDER BY id, part').bind(ref).all();
  const by = {};
  (res.results || []).forEach(r => { (by[r.id] = by[r.id] || { id: r.id, ref: ref, name: r.name, mime: r.mime, size: r.size, b64: '' }); by[r.id].b64 += r.data; });
  RT.photos.filter(p => p.ref === ref).forEach(p => { by[p.id] = p; });
  return Object.values(by).map(photoFile);
}


/* ---------- Web Push (phone notifications for the office), RFC 8291 + VAPID (RFC 8292) ---------- */
const b64u = u => bytesToB64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => b64ToBytes(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4));
function concatBytes(...a) { const n = a.reduce((t, x) => t + x.length, 0), o = new Uint8Array(n); let i = 0; a.forEach(x => { o.set(x, i); i += x.length; }); return o; }
/* the server's own VAPID key pair: made once, kept in the settings table */
async function vapidKeys(rt) {
  let jwk = rt.props.vapid_jwk, pub = rt.props.vapid_pub;
  if (!jwk || !pub) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    jwk = JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey));
    pub = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
    rt.props.vapid_jwk = jwk; rt.propsDirty.vapid_jwk = 1; rt.props.vapid_pub = pub; rt.propsDirty.vapid_pub = 1;
  }
  return { jwk: JSON.parse(jwk), pub: pub };
}
async function vapidAuth(endpoint, keys) {
  const aud = new URL(endpoint).origin;
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud: aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:contact@prjlogistics.co.uk' })));
  const key = await crypto.subtle.importKey('jwk', keys.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + body)));
  return 'vapid t=' + head + '.' + body + '.' + b64u(sig) + ', k=' + keys.pub;
}
/* encrypts the message for one phone (aes128gcm) */
async function pushEncrypt(sub, text) {
  const ua = unb64u(sub.keys.p256dh), authSecret = unb64u(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const prkKey = hmacSha256(shared, authSecret);
  const ikm = hmacSha256(concatBytes(enc.encode('WebPush: info\0'), ua, asPub, new Uint8Array([1])), prkKey);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = hmacSha256(ikm, salt);
  const cek = hmacSha256(concatBytes(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])), prk).slice(0, 16);
  const nonce = hmacSha256(concatBytes(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])), prk).slice(0, 12);
  const aes = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concatBytes(enc.encode(text), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);
  return concatBytes(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}
/* sends one notification to every phone that turned notifications on; phones that unsubscribed are removed */
async function pushAll(env, props, title, body) {
  let subs = [];
  try { subs = JSON.parse(props.push_subs || '[]'); } catch (e) {}
  const res = { devices: subs.length, sent: 0, failed: [] };
  if (!subs.length || !props.vapid_jwk || !props.vapid_pub) return res;
  const keys = { jwk: JSON.parse(props.vapid_jwk), pub: props.vapid_pub };
  const payload = JSON.stringify({ title: String(title).slice(0, 80), body: String(body).slice(0, 300), url: 'admin.html' });
  const gone = [];
  for (const s of subs) {
    try {
      const data = await pushEncrypt(s, payload);
      const r = await fetch(s.endpoint, { method: 'POST', headers: { Authorization: await vapidAuth(s.endpoint, keys), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high' }, body: data });
      if (r.ok) res.sent++;
      else { const why = r.status + ' ' + (await r.text()).slice(0, 150); res.failed.push({ by: s.by || '', why: why });
        if (r.status === 404 || r.status === 410) gone.push(s.endpoint); else await logDirect(env, 'Push failed (' + why + ')'); }
    } catch (e) { res.failed.push({ by: s.by || '', why: String(e).slice(0, 150) }); await logDirect(env, 'Push failed: ' + e); }
  }
  if (gone.length) {
    const left = subs.filter(s => gone.indexOf(s.endpoint) < 0);
    await env.DB.prepare('INSERT INTO props (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind('push_subs', JSON.stringify(left)).run();
  }
  return res;
}
