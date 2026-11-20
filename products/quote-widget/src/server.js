/* ---- COSO Instant Quote: the server (one Cloudflare worker for every courier company) ----
   Bindings:  QUOTE      KV namespace (companies, bookings, rate limits)
   Secrets:   ADMIN_KEY  password for /admin (you choose it)
              RESEND_API_KEY, MAIL_FROM   to send booking emails (optional)
              ORS_API_KEY                 openrouteservice key for routing (optional; without it OSRM is used) */

const WIDGET_JS = __WIDGET_JS__;
const ADMIN_HTML = __ADMIN_HTML__;
const VERSION = '1.0.0';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' };
const json = (o, status, extra) => new Response(JSON.stringify(o), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, CORS, extra || {}) });
const fail = (msg, status) => json({ ok: false, error: msg }, status || 400);

export default {
  async fetch(req, env, ctx) {
    try { return await handle(req, env, ctx); }
    catch (e) { console.log('error', e && e.stack || e); return fail('Something went wrong. Please try again.', 500); }
  }
};

async function handle(req, env, ctx) {
  const url = new URL(req.url), path = url.pathname.replace(/\/+$/, '') || '/';
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  if (path === '/widget.js') return new Response(WIDGET_JS, { headers: Object.assign({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' }, CORS) });
  if (path === '/admin') return new Response(ADMIN_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' } });
  if (path === '/') return new Response('COSO Instant Quote ' + VERSION, { headers: { 'Content-Type': 'text/plain' } });

  if (path === '/v1/config' && req.method === 'GET') {
    const t = await tenant(env, url.searchParams.get('t'));
    if (!t) return fail('Unknown company.', 404);
    const bad = originCheck(t, req); if (bad) return bad;
    return json({ ok: true, tenant: publicTenant(t) });
  }
  if (path === '/v1/places' && req.method === 'GET') {
    const t = await tenant(env, url.searchParams.get('t'));
    if (!t) return fail('Unknown company.', 404);
    const bad = originCheck(t, req); if (bad) return bad;
    if (!(await allow(env, req, 'p', 120))) return fail('Too many searches. Please wait a minute.', 429);
    return json({ ok: true, places: await places(url.searchParams.get('q') || '') }, 200, { 'Cache-Control': 'public, max-age=3600' });
  }
  if (path === '/v1/quote' && req.method === 'POST') {
    const b = await body(req); const t = await tenant(env, b.t);
    if (!t) return fail('Unknown company.', 404);
    const bad = originCheck(t, req); if (bad) return bad;
    if (!(await allow(env, req, 'q', 60))) return fail('Too many quotes. Please wait a few minutes.', 429);
    const q = await quote(env, t, b);
    return q.ok ? json(q) : fail(q.error);
  }
  if (path === '/v1/book' && req.method === 'POST') {
    const b = await body(req); const t = await tenant(env, b.t);
    if (!t) return fail('Unknown company.', 404);
    const bad = originCheck(t, req); if (bad) return bad;
    if (!(await allow(env, req, 'b', 6))) return fail('Too many requests. Please call us instead.', 429);
    return book(env, ctx, t, b, req);
  }
  if (path.startsWith('/admin/')) return admin(req, env, url, path);
  return fail('Not found.', 404);
}

async function body(req) { try { const t = await req.text(); return t.length > 20000 ? {} : JSON.parse(t || '{}'); } catch (e) { return {}; } }
const cleanId = s => String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
const str = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n || 200);

async function tenant(env, id) {
  id = cleanId(id);
  if (!id) return null;
  let t = null;
  if (env.QUOTE) { const raw = await env.QUOTE.get('tenant:' + id); if (raw) t = JSON.parse(raw); }
  if (!t && id === 'demo') t = Object.assign({}, DEFAULT_TENANT);
  if (!t || t.active === false) return null;
  return Object.assign({}, DEFAULT_TENANT, t, { hours: Object.assign({}, DEFAULT_TENANT.hours, t.hours || {}) });
}
function publicTenant(t) {
  return { id: t.id, name: t.name, phone: t.phone, colour: t.colour, logo: t.logo, vat: t.vat, maxMiles: t.maxMiles, minNoticeMins: t.minNoticeMins, hours: t.hours, urgentPct: t.urgentPct, outOfHoursPct: t.outOfHoursPct, weekendPct: t.weekendPct,
    vehicles: (t.vehicles || []).map(v => ({ id: v.id, name: v.name, desc: v.desc, maxKg: v.maxKg })), terms: t.terms, privacy: t.privacy, thanks: t.thanks, plan: t.plan };
}

/* the widget only works on the company's own website(s); '*' = anywhere (demo, testing) */
function originCheck(t, req) {
  const d = t.domains || ['*'];
  if (d.indexOf('*') >= 0) return null;
  const o = req.headers.get('Origin') || '';
  let host = '';
  try { host = new URL(o).hostname.toLowerCase(); } catch (e) {}
  const ok = d.some(x => { x = String(x).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''); return host === x || host.endsWith('.' + x); });
  return ok ? null : fail('This quote form is not set up for this website.', 403);
}

/* simple per-visitor limits, counted per hour */
async function allow(env, req, kind, max) {
  if (!env.QUOTE) return true;
  const ip = req.headers.get('CF-Connecting-IP') || 'local', k = 'rl:' + kind + ':' + ip + ':' + Math.floor(Date.now() / 3600e3);
  const n = +(await env.QUOTE.get(k)) || 0;
  if (n >= max) return false;
  await env.QUOTE.put(k, String(n + 1), { expirationTtl: 3700 });
  return true;
}

/* ---------- addresses ---------- */
const PC_FULL = /^\s*([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\s*$/i;
async function places(q) {
  q = str(q, 120);
  if (q.length < 3) return [];
  const m = PC_FULL.exec(q);
  if (m) {
    const r = await fetch('https://api.postcodes.io/postcodes/' + encodeURIComponent(m[1] + m[2]));
    if (r.ok) { const j = await r.json(), x = j.result; if (x) return [{ label: x.postcode + ', ' + (x.admin_ward ? x.admin_ward + ', ' : '') + (x.admin_district || ''), lat: x.latitude, lon: x.longitude, postcode: x.postcode }]; }
    return [];
  }
  const r = await fetch('https://photon.komoot.io/api/?limit=8&lang=en&lat=51.5&lon=-0.6&q=' + encodeURIComponent(q), { headers: { 'User-Agent': 'COSO-Instant-Quote/1.0' } });
  if (!r.ok) return [];
  const j = await r.json(), seen = {};
  return (j.features || []).filter(f => f.properties && f.properties.countrycode === 'GB').map(f => {
    const p = f.properties, street = [p.housenumber, p.street].filter(Boolean).join(' ');
    const parts = [p.name && p.name !== p.street ? p.name : '', street, p.city || p.district || p.county, p.postcode].filter(Boolean);
    return { label: parts.join(', '), lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], postcode: p.postcode || '' };
  }).filter(x => x.label && !seen[x.label] && (seen[x.label] = 1)).slice(0, 6);
}
const okPoint = p => p && isFinite(+p.lat) && isFinite(+p.lon) && +p.lat > 49 && +p.lat < 61 && +p.lon > -9 && +p.lon < 2.5;

/* ---------- route and price ---------- */
async function route(env, a, b) {
  try {
    if (env.ORS_API_KEY) {
      const r = await fetch('https://api.openrouteservice.org/v2/directions/driving-car/geojson', { method: 'POST', headers: { Authorization: env.ORS_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ coordinates: [[+a.lon, +a.lat], [+b.lon, +b.lat]] }) });
      if (r.ok) { const j = await r.json(), f = j.features && j.features[0]; if (f) return { miles: f.properties.summary.distance / 1609.344, mins: f.properties.summary.duration / 60, line: thin(f.geometry.coordinates), exact: true }; }
    }
    const r = await fetch('https://router.project-osrm.org/route/v1/driving/' + (+a.lon) + ',' + (+a.lat) + ';' + (+b.lon) + ',' + (+b.lat) + '?overview=simplified&geometries=geojson', { headers: { 'User-Agent': 'COSO-Instant-Quote/1.0' } });
    if (r.ok) { const j = await r.json(), x = j.routes && j.routes[0]; if (x) return { miles: x.distance / 1609.344, mins: x.duration / 60, line: thin(x.geometry.coordinates), exact: true }; }
  } catch (e) { console.log('route', e); }
  const miles = crowMiles([+a.lat, +a.lon], [+b.lat, +b.lon]) * 1.25;
  return { miles, mins: miles / 30 * 60, line: [[+a.lat, +a.lon], [+b.lat, +b.lon]], exact: false };
}
function thin(c) { const step = Math.max(1, Math.ceil(c.length / 250)); const o = []; for (let i = 0; i < c.length; i += step) o.push([r5(c[i][1]), r5(c[i][0])]); const l = c[c.length - 1]; o.push([r5(l[1]), r5(l[0])]); return o; }
const r5 = n => Math.round(n * 1e5) / 1e5;

async function quote(env, t, b) {
  if (!okPoint(b.from) || !okPoint(b.to)) return { ok: false, error: 'Please choose both addresses from the list.' };
  if (!b.asap) {
    const w = new Date(b.when);
    if (isNaN(w)) return { ok: false, error: 'Please choose a collection time or tick "as soon as possible".' };
    if (w.getTime() < Date.now() + (t.minNoticeMins || 0) * 60e3 - 60e3) return { ok: false, error: 'Please choose a later collection time, or tick "as soon as possible".' };
    if (w.getTime() > Date.now() + 120 * 864e5) return { ok: false, error: 'We take online bookings up to 4 months ahead.' };
  }
  const rt = await route(env, b.from, b.to);
  const p = priceQuote(t, rt.miles, { vehicle: b.vehicle, asap: !!b.asap, when: b.when });
  if (!p.ok) return p;
  return Object.assign(p, { mins: Math.round(rt.mins), exact: rt.exact, line: rt.line });
}

/* ---------- booking request ---------- */
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;
function newRef() { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', b = crypto.getRandomValues(new Uint8Array(6)); return 'Q-' + Array.from(b, x => a[x % a.length]).join(''); }

async function book(env, ctx, t, b, req) {
  if (b.website) return json({ ok: true, ref: newRef() });          // a robot filled the hidden field: pretend it worked
  if (b.startedAt && Date.now() - +b.startedAt < 3000) return fail('Please check your details and try again.');
  const c = b.customer || {};
  const name = str(c.name, 100), phone = str(c.phone, 30), email = str(c.email, 200).toLowerCase(), company = str(c.company, 100);
  if (name.length < 2) return fail('Please enter your name.');
  if (phone.replace(/\D/g, '').length < 10) return fail('Please enter a phone number we can call.');
  if (!EMAIL.test(email)) return fail('Please enter a valid email address.');
  if (!b.consent) return fail('Please tick the box to agree to the terms.');
  const q = await quote(env, t, b);
  if (!q.ok) return fail(q.error);
  const ref = newRef(), now = new Date().toISOString();
  const lead = {
    ref, tenant: t.id, created: now, status: 'new',
    from: { label: str(b.from.label, 200), lat: +b.from.lat, lon: +b.from.lon }, to: { label: str(b.to.label, 200), lat: +b.to.lat, lon: +b.to.lon },
    vehicle: q.vehicleName, asap: !!b.asap, when: b.asap ? '' : String(b.when), miles: q.miles, mins: q.mins, exact: q.exact,
    lines: q.lines, net: q.net, vat: q.vat, total: q.total, vatMode: q.vatMode,
    customer: { name, phone, email, company }, goods: str(b.goods, 300), notes: str(b.notes, 600),
    page: str(req.headers.get('Referer') || '', 300)
  };
  if (env.QUOTE) await env.QUOTE.put('lead:' + t.id + ':' + now + ':' + ref, JSON.stringify(lead), { metadata: { ref, name, total: q.total, created: now, from: lead.from.label.slice(0, 60), to: lead.to.label.slice(0, 60) } });
  const mails = [];
  if (t.email) mails.push(mail(env, { to: t.email, replyTo: email, fromName: 'COSO Instant Quote', subject: 'New booking request ' + ref + ': ' + money(q.total) + ', ' + short(lead.from.label) + ' to ' + short(lead.to.label), text: ownerText(t, lead) }));
  mails.push(mail(env, { to: email, replyTo: t.email || undefined, fromName: t.name, subject: t.name + ': we have your booking request ' + ref, text: customerText(t, lead) }));
  const all = Promise.all(mails);
  if (ctx && ctx.waitUntil) ctx.waitUntil(all); else await all;
  return json({ ok: true, ref, total: q.total, thanks: t.thanks });
}
const money = n => '£' + (+n).toFixed(2);
const short = s => String(s).split(',')[0].slice(0, 40);
const whenText = l => l.asap ? 'As soon as possible' : new Date(l.when).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function priceText(l) { return l.lines.map(x => '  ' + x.label + ': ' + money(x.amount)).join('\n') + '\n  Price: ' + money(l.net) + (l.vatMode === 'add' ? ' + VAT ' + money(l.vat) + ' = ' + money(l.total) : l.vatMode === 'inc' ? ' (includes VAT ' + money(l.vat) + ')' : ''); }
function ownerText(t, l) {
  return 'New booking request from your website.\n\nReference: ' + l.ref + '\nCustomer: ' + l.customer.name + (l.customer.company ? ' (' + l.customer.company + ')' : '') + '\nPhone: ' + l.customer.phone + '\nEmail: ' + l.customer.email +
    '\n\nCollect from: ' + l.from.label + '\nDeliver to: ' + l.to.label + '\nCollection: ' + whenText(l) + '\nVan: ' + l.vehicle + '\nDistance: ' + l.miles + ' miles, about ' + l.mins + ' min' + (l.exact ? '' : ' (approximate)') +
    '\nGoods: ' + (l.goods || '-') + '\nNotes: ' + (l.notes || '-') + '\n\nPrice shown to the customer:\n' + priceText(l) + '\n\nReply to this email to answer the customer directly.\nThe customer has been told that you will confirm the booking.';
}
function customerText(t, l) {
  return 'Hello ' + l.customer.name.split(' ')[0] + ',\n\nThank you for your booking request. ' + (t.thanks || '') + '\n\nYour reference: ' + l.ref + '\nCollect from: ' + l.from.label + '\nDeliver to: ' + l.to.label + '\nCollection: ' + whenText(l) + '\nVan: ' + l.vehicle +
    '\n\nYour quote:\n' + priceText(l) + '\n\nThis is not a confirmed booking yet. ' + t.name + ' will contact you to confirm.' + (t.phone ? '\nQuestions? Call ' + t.phone + ' or reply to this email.' : '\nQuestions? Reply to this email.') + '\n\n' + t.name;
}
async function mail(env, m) {
  const body = { from: m.fromName + ' <' + (env.MAIL_FROM || 'quotes@prjlogistics.co.uk') + '>', to: [m.to], subject: m.subject, text: m.text, reply_to: m.replyTo ? [m.replyTo] : undefined };
  if (env.TEST_OUTBOX) { env.TEST_OUTBOX.push(body); return; }
  if (!env.RESEND_API_KEY) { console.log('email not sent (no RESEND_API_KEY): ' + m.subject); return; }
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) console.log('email failed ' + r.status + ' ' + (await r.text()).slice(0, 200));
}

/* ---------- admin: add companies, change price lists, see booking requests ---------- */
async function admin(req, env, url, path) {
  const key = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.ADMIN_KEY || key.length < 12 || !(await same(key, env.ADMIN_KEY))) return fail('Wrong admin key.', 401);
  if (!env.QUOTE) return fail('KV namespace QUOTE is not connected.', 500);
  if (path === '/admin/tenants' && req.method === 'GET') {
    const l = await env.QUOTE.list({ prefix: 'tenant:' }), out = [];
    for (const k of l.keys) out.push(JSON.parse(await env.QUOTE.get(k.name)));
    return json({ ok: true, tenants: out });
  }
  const m = /^\/admin\/tenants\/([a-z0-9-]{2,40})$/.exec(path);
  if (m && req.method === 'PUT') {
    const b = await body(req), t = sanitizeTenant(Object.assign({}, b, { id: m[1] }));
    if (!t.ok) return fail(t.error);
    await env.QUOTE.put('tenant:' + m[1], JSON.stringify(t.tenant));
    return json({ ok: true, tenant: t.tenant });
  }
  if (m && req.method === 'DELETE') { await env.QUOTE.delete('tenant:' + m[1]); return json({ ok: true }); }
  if (path === '/admin/leads' && req.method === 'GET') {
    const id = cleanId(url.searchParams.get('t'));
    const l = await env.QUOTE.list({ prefix: 'lead:' + (id ? id + ':' : ''), limit: 1000 });
    const rows = l.keys.map(k => Object.assign({ key: k.name, tenant: k.name.split(':')[1] }, k.metadata || {})).sort((a, b) => String(b.created).localeCompare(String(a.created))).slice(0, 200);
    return json({ ok: true, leads: rows });
  }
  if (path === '/admin/lead' && req.method === 'GET') {
    const k = String(url.searchParams.get('key') || '');
    if (!/^lead:[a-z0-9-]+:/.test(k)) return fail('Bad key.');
    const v = await env.QUOTE.get(k);
    return v ? json({ ok: true, lead: JSON.parse(v) }) : fail('Not found.', 404);
  }
  return fail('Not found.', 404);
}
async function same(a, b) {
  const e = new TextEncoder(), h = async s => new Uint8Array(await crypto.subtle.digest('SHA-256', e.encode(s)));
  const x = await h(a), y = await h(b); let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]; return d === 0;
}
function sanitizeTenant(b) {
  const num = (v, lo, hi, def) => { v = +v; return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; };
  const vehicles = (Array.isArray(b.vehicles) ? b.vehicles : []).slice(0, 8).map((v, i) => ({
    id: cleanId(v.id) || ('van' + (i + 1)), name: str(v.name, 40) || 'Van', desc: str(v.desc, 80), maxKg: num(v.maxKg, 0, 40000, 0),
    base: num(v.base, 0, 5000, 0), perMile: num(v.perMile, 0, 50, 1), minimum: num(v.minimum, 0, 5000, 0)
  }));
  if (!vehicles.length) return { ok: false, error: 'Add at least one van with a price.' };
  const email = str(b.email, 200);
  if (email && !EMAIL.test(email)) return { ok: false, error: 'The company email does not look right.' };
  const colour = /^#[0-9a-f]{6}$/i.test(b.colour || '') ? b.colour : DEFAULT_TENANT.colour;
  const url = s => { s = str(s, 300); return /^https:\/\//i.test(s) ? s : ''; };
  const h = b.hours || {};
  return { ok: true, tenant: {
    id: b.id, name: str(b.name, 80) || b.id, email, phone: str(b.phone, 30), colour, logo: url(b.logo),
    domains: (Array.isArray(b.domains) ? b.domains : String(b.domains || '*').split(',')).map(s => str(s, 100).toLowerCase()).filter(Boolean).slice(0, 10),
    active: b.active !== false, plan: b.plan === 'pro' ? 'pro' : 'basic', vat: ['none', 'add', 'inc'].indexOf(b.vat) >= 0 ? b.vat : 'none',
    maxMiles: num(b.maxMiles, 1, 1000, 300), minNoticeMins: num(b.minNoticeMins, 0, 2880, 60),
    hours: { start: num(h.start, 0, 23, 8), end: num(h.end, 1, 24, 18), days: (Array.isArray(h.days) ? h.days : [1, 2, 3, 4, 5]).map(Number).filter(d => d >= 0 && d <= 6) },
    urgentPct: num(b.urgentPct, 0, 200, 25), outOfHoursPct: num(b.outOfHoursPct, 0, 200, 25), weekendPct: num(b.weekendPct, 0, 200, 30), roundTo: [0.01, 0.5, 1, 5].indexOf(+b.roundTo) >= 0 ? +b.roundTo : 1,
    vehicles, terms: url(b.terms), privacy: url(b.privacy), thanks: str(b.thanks, 300) || DEFAULT_TENANT.thanks, updated: new Date().toISOString()
  } };
}
