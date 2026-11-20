/* where the "Instant quotes by COSO" link points (COSO site; move to its own domain when bought) */
const BRAND_URL = 'https://www.prjlogistics.co.uk/coso.html';

/* ---- shared by the server (worker) and the widget's offline demo: one price formula ---- */

/* A courier's price list. Every company gets its own copy, changed in the admin page. */
const DEFAULT_TENANT = {
  id: 'demo',
  name: 'Demo Couriers',
  email: '',
  phone: '',
  colour: '#0B5FFF',
  logo: '',
  domains: ['*'],
  active: true,
  plan: 'basic',
  vat: 'none',            // 'none' = prices have no VAT, 'add' = VAT is added on top, 'inc' = prices include VAT
  maxMiles: 300,
  minNoticeMins: 60,
  hours: { start: 8, end: 18, days: [1, 2, 3, 4, 5] },
  urgentPct: 25,          // "as soon as possible"
  outOfHoursPct: 25,      // collection outside working hours
  weekendPct: 30,
  roundTo: 1,             // round the price to the nearest £1
  vehicles: [
    { id: 'small', name: 'Small van', desc: 'Boxes and parcels, up to 400 kg', maxKg: 400, base: 30, perMile: 1.10, minimum: 40 },
    { id: 'swb', name: 'SWB van', desc: 'Up to 2 pallets or 800 kg', maxKg: 800, base: 35, perMile: 1.30, minimum: 50 },
    { id: 'lwb', name: 'LWB van', desc: 'Up to 3 pallets or 1,100 kg', maxKg: 1100, base: 40, perMile: 1.50, minimum: 60 }
  ],
  terms: '',
  privacy: '',
  thanks: 'Thank you. We will confirm your booking and the final price shortly.'
};

const r2 = n => Math.round(n * 100) / 100;

/* The day of the week and the hour of a collection time, read in UK time. */
function ukParts(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = t => (p.find(x => x.type === t) || {}).value || '';
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday'));
  return { day: wd, hour: (+g('hour')) % 24, minute: +g('minute') };
}

/* price for one job: miles from the route, the van chosen, "as soon as possible" or a collection time */
function priceQuote(t, miles, opt) {
  opt = opt || {};
  const v = (t.vehicles || []).find(x => x.id === opt.vehicle) || (t.vehicles || [])[0];
  if (!v) return { ok: false, error: 'This company has no vans set up yet.' };
  miles = Math.max(0, +miles || 0);
  if (t.maxMiles && miles > t.maxMiles) return { ok: false, error: 'This journey is ' + Math.round(miles) + ' miles. We quote online up to ' + t.maxMiles + ' miles; please contact us for a price.' };
  const lines = [];
  const distance = (+v.base || 0) + (+v.perMile || 0) * miles;
  let price = Math.max(+v.minimum || 0, distance);
  lines.push({ label: v.name + ', ' + (Math.round(miles * 10) / 10) + ' miles', amount: r2(price) });
  const extra = (pct, label) => { if (+pct > 0) { const a = price * (+pct) / 100; lines.push({ label: label + ' (+' + pct + '%)', amount: r2(a) }); return a; } return 0; };
  let add = 0;
  if (opt.asap) add += extra(t.urgentPct, 'Urgent, as soon as possible');
  else if (opt.when) {
    const u = ukParts(opt.when), h = t.hours || {};
    if (u) {
      const weekend = (h.days || [1, 2, 3, 4, 5]).indexOf(u.day) < 0;
      const mins = u.hour * 60 + u.minute, open = (+h.start || 0) * 60, close = (+h.end || 24) * 60;
      if (weekend) add += extra(t.weekendPct, 'Weekend or day off');
      else if (mins < open || mins >= close) add += extra(t.outOfHoursPct, 'Outside working hours');
    }
  }
  price += add;
  const step = +t.roundTo || 1;
  const net = Math.max(0, Math.round(price / step) * step);
  const out = { ok: true, vehicle: v.id, vehicleName: v.name, miles: r2(miles), lines, net: r2(net), vat: 0, total: r2(net), vatMode: t.vat || 'none' };
  if (t.vat === 'add') { out.vat = r2(net * 0.2); out.total = r2(net * 1.2); }
  if (t.vat === 'inc') { out.vat = r2(net - net / 1.2); }
  return out;
}

/* straight-line miles between two [lat, lon] points */
function crowMiles(a, b) {
  const R = 3958.8, rad = x => x * Math.PI / 180;
  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ---- COSO Instant Quote: the server (one Cloudflare worker for every courier company) ----
   Bindings:  QUOTE      KV namespace (companies, bookings, rate limits)
   Secrets:   ADMIN_KEY  password for /admin (you choose it)
              RESEND_API_KEY, MAIL_FROM   to send booking emails (optional)
              ORS_API_KEY                 openrouteservice key for routing (optional; without it OSRM is used) */

const WIDGET_JS = "/* PRJ Instant Quote widget */\n(function(){\n/* where the \"Instant quotes by COSO\" link points (COSO site; move to its own domain when bought) */\nconst BRAND_URL = 'https://www.prjlogistics.co.uk/coso.html';\n\n/* ---- shared by the server (worker) and the widget's offline demo: one price formula ---- */\n\n/* A courier's price list. Every company gets its own copy, changed in the admin page. */\nconst DEFAULT_TENANT = {\n  id: 'demo',\n  name: 'Demo Couriers',\n  email: '',\n  phone: '',\n  colour: '#0B5FFF',\n  logo: '',\n  domains: ['*'],\n  active: true,\n  plan: 'basic',\n  vat: 'none',            // 'none' = prices have no VAT, 'add' = VAT is added on top, 'inc' = prices include VAT\n  maxMiles: 300,\n  minNoticeMins: 60,\n  hours: { start: 8, end: 18, days: [1, 2, 3, 4, 5] },\n  urgentPct: 25,          // \"as soon as possible\"\n  outOfHoursPct: 25,      // collection outside working hours\n  weekendPct: 30,\n  roundTo: 1,             // round the price to the nearest \u00a31\n  vehicles: [\n    { id: 'small', name: 'Small van', desc: 'Boxes and parcels, up to 400 kg', maxKg: 400, base: 30, perMile: 1.10, minimum: 40 },\n    { id: 'swb', name: 'SWB van', desc: 'Up to 2 pallets or 800 kg', maxKg: 800, base: 35, perMile: 1.30, minimum: 50 },\n    { id: 'lwb', name: 'LWB van', desc: 'Up to 3 pallets or 1,100 kg', maxKg: 1100, base: 40, perMile: 1.50, minimum: 60 }\n  ],\n  terms: '',\n  privacy: '',\n  thanks: 'Thank you. We will confirm your booking and the final price shortly.'\n};\n\nconst r2 = n => Math.round(n * 100) / 100;\n\n/* The day of the week and the hour of a collection time, read in UK time. */\nfunction ukParts(iso) {\n  const d = new Date(iso);\n  if (isNaN(d)) return null;\n  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);\n  const g = t => (p.find(x => x.type === t) || {}).value || '';\n  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday'));\n  return { day: wd, hour: (+g('hour')) % 24, minute: +g('minute') };\n}\n\n/* price for one job: miles from the route, the van chosen, \"as soon as possible\" or a collection time */\nfunction priceQuote(t, miles, opt) {\n  opt = opt || {};\n  const v = (t.vehicles || []).find(x => x.id === opt.vehicle) || (t.vehicles || [])[0];\n  if (!v) return { ok: false, error: 'This company has no vans set up yet.' };\n  miles = Math.max(0, +miles || 0);\n  if (t.maxMiles && miles > t.maxMiles) return { ok: false, error: 'This journey is ' + Math.round(miles) + ' miles. We quote online up to ' + t.maxMiles + ' miles; please contact us for a price.' };\n  const lines = [];\n  const distance = (+v.base || 0) + (+v.perMile || 0) * miles;\n  let price = Math.max(+v.minimum || 0, distance);\n  lines.push({ label: v.name + ', ' + (Math.round(miles * 10) / 10) + ' miles', amount: r2(price) });\n  const extra = (pct, label) => { if (+pct > 0) { const a = price * (+pct) / 100; lines.push({ label: label + ' (+' + pct + '%)', amount: r2(a) }); return a; } return 0; };\n  let add = 0;\n  if (opt.asap) add += extra(t.urgentPct, 'Urgent, as soon as possible');\n  else if (opt.when) {\n    const u = ukParts(opt.when), h = t.hours || {};\n    if (u) {\n      const weekend = (h.days || [1, 2, 3, 4, 5]).indexOf(u.day) < 0;\n      const mins = u.hour * 60 + u.minute, open = (+h.start || 0) * 60, close = (+h.end || 24) * 60;\n      if (weekend) add += extra(t.weekendPct, 'Weekend or day off');\n      else if (mins < open || mins >= close) add += extra(t.outOfHoursPct, 'Outside working hours');\n    }\n  }\n  price += add;\n  const step = +t.roundTo || 1;\n  const net = Math.max(0, Math.round(price / step) * step);\n  const out = { ok: true, vehicle: v.id, vehicleName: v.name, miles: r2(miles), lines, net: r2(net), vat: 0, total: r2(net), vatMode: t.vat || 'none' };\n  if (t.vat === 'add') { out.vat = r2(net * 0.2); out.total = r2(net * 1.2); }\n  if (t.vat === 'inc') { out.vat = r2(net - net / 1.2); }\n  return out;\n}\n\n/* straight-line miles between two [lat, lon] points */\nfunction crowMiles(a, b) {\n  const R = 3958.8, rad = x => x * Math.PI / 180;\n  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);\n  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;\n  return 2 * R * Math.asin(Math.sqrt(h));\n}\n\n/* ---- COSO Instant Quote: the widget a courier company pastes into its website ----\n   <div data-prj-quote></div>\n   script tag: src=\"https://YOUR-WORKER/widget.js\" data-tenant=\"company-id\" async\n   Optional: data-target=\"#css-selector\", data-mode=\"offline\" (sales demo, no server). */\n(function () {\n  'use strict';\n  const S = document.currentScript || document.querySelector('script[src*=\"widget.js\"][data-tenant]');\n  if (!S) return;\n  const TID = S.getAttribute('data-tenant') || 'demo';\n  let OFFLINE = S.getAttribute('data-mode') === 'offline';\n  const FALLBACK = S.getAttribute('data-fallback') === 'offline';   // sales page: if the server is not reachable, run the offline demo\n  let API = S.getAttribute('data-api') || '';\n  if (!API) { try { API = new URL(S.src, location.href).origin; } catch (e) { API = ''; } }\n\n  const host = document.querySelector(S.getAttribute('data-target') || '[data-prj-quote]') || (function () { const d = document.createElement('div'); S.parentNode.insertBefore(d, S.nextSibling); return d; })();\n  if (host.__prjq) return; host.__prjq = 1;\n  const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;\n\n  /* ---------- talking to the server (or the offline sales demo) ---------- */\n  const SAMPLE = [\n    ['14 Broad Street, Reading RG1 2BH', 51.4560, -0.9730], ['Green Park, Reading RG2 6UB', 51.4280, -0.9900], ['Slough Trading Estate, Slough SL1 4LA', 51.5190, -0.6290],\n    ['Bracknell Town Centre, Bracknell RG12 1BE', 51.4150, -0.7520], ['Wokingham Market Place, Wokingham RG40 1AL', 51.4110, -0.8340], ['Maidenhead High Street, Maidenhead SL6 1QJ', 51.5220, -0.7190],\n    ['Heathrow Airport, Hounslow TW6 1QG', 51.4700, -0.4540], ['Oxford Business Park, Oxford OX4 2RU', 51.7350, -1.1950], ['Basingstoke Business Park, Basingstoke RG24 8WA', 51.2760, -1.0590],\n    ['Canary Wharf, London E14 5AB', 51.5050, -0.0190], ['Park Royal, London NW10 7NU', 51.5290, -0.2700], ['Milton Keynes Central, Milton Keynes MK9 2FW', 52.0340, -0.7740],\n    ['Birmingham City Centre, Birmingham B2 4RU', 52.4790, -1.9000], ['Bristol Temple Quay, Bristol BS1 6DG', 51.4510, -2.5830], ['Southampton Docks, Southampton SO14 3QN', 50.8990, -1.4040]\n  ].map(r => ({ label: r[0], lat: r[1], lon: r[2] }));\n  const api = {\n    async config() {\n      if (OFFLINE) return Object.assign({}, DEFAULT_TENANT, { name: S.getAttribute('data-name') || DEFAULT_TENANT.name, colour: S.getAttribute('data-colour') || DEFAULT_TENANT.colour, phone: S.getAttribute('data-phone') || '' });\n      const j = await get('/v1/config?t=' + encodeURIComponent(TID)); return j.tenant;\n    },\n    async places(q) {\n      if (OFFLINE) { const w = q.toLowerCase().split(/\\s+/).filter(Boolean); return SAMPLE.filter(p => w.every(x => p.label.toLowerCase().indexOf(x) >= 0)).slice(0, 6); }\n      return (await get('/v1/places?t=' + encodeURIComponent(TID) + '&q=' + encodeURIComponent(q))).places;\n    },\n    async quote(b) {\n      if (OFFLINE) {\n        await wait(350);\n        const miles = crowMiles([b.from.lat, b.from.lon], [b.to.lat, b.to.lon]) * 1.25, p = priceQuote(cfg, miles, b);\n        if (!p.ok) throw new Error(p.error);\n        return Object.assign(p, { mins: Math.round(miles / 32 * 60), exact: false, line: [[b.from.lat, b.from.lon], [b.to.lat, b.to.lon]] });\n      }\n      return post('/v1/quote', b);\n    },\n    async book(b) {\n      if (OFFLINE) { await wait(500); return { ok: true, ref: 'Q-DEMO' + Math.floor(Math.random() * 90 + 10), thanks: 'This is a demo, so nothing was sent. On a live website the courier would get your request by email straight away.' }; }\n      return post('/v1/book', b);\n    }\n  };\n  const wait = ms => new Promise(r => setTimeout(r, ms));\n  async function get(p) { const r = await fetch(API + p); const j = await r.json().catch(() => ({})); if (!r.ok || !j.ok) throw new Error(j.error || 'Could not connect. Please try again.'); return j; }\n  async function post(p, b) { const r = await fetch(API + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ t: TID }, b)) }); const j = await r.json().catch(() => ({})); if (!r.ok || !j.ok) throw new Error(j.error || 'Could not connect. Please try again.'); return j; }\n\n  /* ---------- look ---------- */\n  const CSS = `\n:host{all:initial;display:block;font-family:inherit;color:#111827}\n*{box-sizing:border-box}\n.q{--c:#0B5FFF;--ink:#111827;--mut:#5B6472;--line:#E3E6EB;--soft:#F5F7FA;font:16px/1.5 var(--font,inherit);color:var(--ink);background:#fff;border:1px solid var(--line);border-radius:14px;padding:22px;max-width:580px;box-shadow:0 1px 2px rgba(17,24,39,.04),0 8px 24px rgba(17,24,39,.06)}\nh3{margin:0 0 4px;font-size:1.3rem;line-height:1.2}\n.sub{color:var(--mut);font-size:.92rem;margin:0 0 16px}\nlabel{display:block;font-weight:600;font-size:.88rem;margin:14px 0 6px}\ninput,textarea,select{width:100%;font:inherit;font-size:1rem;color:var(--ink);background:#fff;border:1.5px solid var(--line);border-radius:10px;padding:11px 12px;min-width:0}\ntextarea{resize:vertical;min-height:70px}\ninput:focus,textarea:focus{outline:none;border-color:var(--c);box-shadow:0 0 0 3px color-mix(in srgb,var(--c) 22%,transparent)}\n.ac{position:relative}\n.ac ul{position:absolute;z-index:5;left:0;right:0;top:calc(100% + 4px);margin:0;padding:4px;list-style:none;background:#fff;border:1px solid var(--line);border-radius:10px;box-shadow:0 10px 30px rgba(17,24,39,.12);max-height:260px;overflow:auto}\n.ac li{padding:9px 10px;border-radius:7px;cursor:pointer;font-size:.95rem}\n.ac li[aria-selected=true],.ac li:hover{background:var(--soft)}\n.ac li.none{color:var(--mut);cursor:default}\n.ok{display:none;position:absolute;right:12px;top:50%;transform:translateY(-50%);color:#16A34A;font-weight:700}\n.ac.set .ok{display:block}.ac.set input{padding-right:34px}\n.vans{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:8px}\n.van{position:relative;border:1.5px solid var(--line);border-radius:10px;padding:10px 12px;cursor:pointer;display:block;margin:0;font-weight:400}\n.van input{position:absolute;opacity:0;pointer-events:none}\n.van b{display:block;font-size:.95rem}.van span{display:block;color:var(--mut);font-size:.8rem;line-height:1.35}\n.van.on{border-color:var(--c);background:color-mix(in srgb,var(--c) 7%,#fff)}\n.van:focus-within{box-shadow:0 0 0 3px color-mix(in srgb,var(--c) 22%,transparent)}\n.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}\n.chk{display:flex;gap:9px;align-items:flex-start;font-weight:500;font-size:.92rem;margin-top:12px}\n.chk input{width:18px;height:18px;margin:2px 0 0;accent-color:var(--c);flex:none}\n.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;margin-top:18px;padding:14px 18px;border:0;border-radius:10px;background:var(--c);color:var(--on,#fff);font:inherit;font-weight:700;font-size:1rem;cursor:pointer}\n.btn[disabled]{opacity:.55;cursor:progress}\n.btn.ghost{background:#fff;color:var(--ink);border:1.5px solid var(--line);margin-top:10px}\n.err{color:#B42318;font-size:.9rem;font-weight:600;margin:10px 0 0}\n.res{margin-top:18px;border-top:1px solid var(--line);padding-top:18px}\n.price{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}\n.price .big{font-size:2.3rem;font-weight:800;letter-spacing:-.02em;line-height:1}\n.price small{color:var(--mut);font-size:.88rem}\n.trip{display:grid;grid-template-columns:14px 1fr;column-gap:10px;row-gap:2px;margin:14px 0 4px;font-size:.92rem}\n.dot{width:12px;height:12px;border-radius:50%;border:3px solid var(--c);margin-top:4px;background:#fff}.dot.b{background:var(--c)}\n.bar{width:2px;height:16px;background:repeating-linear-gradient(var(--line) 0 3px,transparent 3px 6px);margin-left:5px}\n.meta{color:var(--mut);font-size:.88rem}\ndetails{margin-top:10px;font-size:.9rem}summary{cursor:pointer;color:var(--mut)}\ntable{width:100%;border-collapse:collapse;margin-top:6px}td{padding:5px 0;border-bottom:1px solid var(--line)}td:last-child{text-align:right;white-space:nowrap}\n.map{height:200px;margin-top:12px;border-radius:10px;overflow:hidden;border:1px solid var(--line);background:var(--soft)}\n.done{text-align:center;padding:12px 0}\n.done .tick{width:54px;height:54px;border-radius:50%;background:var(--c);color:var(--on,#fff);display:grid;place-items:center;margin:0 auto 10px;font-size:1.6rem;font-weight:800}\n.ref{display:inline-block;margin:8px 0;padding:6px 12px;border-radius:8px;background:var(--soft);font-weight:700;letter-spacing:.04em}\n.by{margin-top:14px;text-align:center;font-size:.75rem;color:var(--mut)}.by a{color:inherit}\n.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}\n@media (max-width:420px){.q{padding:16px;border-radius:12px}.row{grid-template-columns:1fr}.price .big{font-size:2rem}}\n@media (prefers-reduced-motion:no-preference){.res{animation:in .25s ease-out}@keyframes in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}}`;\n\n  const esc = s => String(s == null ? '' : s).replace(/[&<>\"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]));\n  const gbp = n => '\u00a3' + (+n).toLocaleString('en-GB', { minimumFractionDigits: (+n % 1 ? 2 : 0), maximumFractionDigits: 2 });\n  let cfg = null, st = { from: null, to: null, vehicle: null, asap: false, when: '', quote: null, startedAt: Date.now() };\n\n  root.innerHTML = '<style>' + CSS + '</style><div class=\"q\" part=\"card\"><p class=\"sub\">Loading the quote form\u2026</p></div>';\n  const box = root.querySelector('.q');\n  const $ = s => box.querySelector(s);\n\n  /* text on the company colour: dark on light colours (e.g. yellow), white on dark ones */\n  function onColour(hex) { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return '#fff'; const n = parseInt(m[1], 16), c = [n >> 16, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }); return (.2126 * c[0] + .7152 * c[1] + .0722 * c[2]) > .4 ? '#111111' : '#ffffff'; }\n  const start = c => { cfg = c; st.vehicle = (cfg.vehicles[0] || {}).id; box.style.setProperty('--c', cfg.colour || '#0B5FFF'); box.style.setProperty('--on', onColour(cfg.colour)); step1(); };\n  api.config().then(start).catch(e => {\n    if (FALLBACK && !OFFLINE) { OFFLINE = true; return api.config().then(start); }\n    box.innerHTML = '<p class=\"err\">' + esc(e.message) + '</p>';\n  });\n\n  /* first collection time that is inside working hours, so the first price has no out-of-hours extra */\n  function nextSlot() {\n    const h = cfg.hours || { start: 8, end: 18, days: [1, 2, 3, 4, 5] }, days = h.days && h.days.length ? h.days : [1, 2, 3, 4, 5];\n    const d = new Date(Date.now() + ((cfg.minNoticeMins || 60) + 30) * 60e3); d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);\n    for (let i = 0; i < 14 && (days.indexOf(d.getDay()) < 0 || d.getHours() < h.start || d.getHours() >= h.end); i++) {\n      if (days.indexOf(d.getDay()) >= 0 && d.getHours() < h.start) d.setHours(h.start, 0, 0, 0);\n      else { d.setDate(d.getDate() + 1); d.setHours(h.start, 0, 0, 0); }\n    }\n    const p = n => String(n).padStart(2, '0');\n    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());\n  }\n\n  function step1() {\n    st.when = st.when || nextSlot();\n    box.innerHTML = `\n      <h3>Get an instant price</h3>\n      <p class=\"sub\">${esc(cfg.name)}: same-day courier quote in seconds. No sign-up.</p>\n      <label for=\"qf\">Collect from</label>\n      <div class=\"ac\" id=\"acf\"><input id=\"qf\" autocomplete=\"off\" placeholder=\"Postcode or address, e.g. RG1 2BH\" role=\"combobox\" aria-autocomplete=\"list\" aria-expanded=\"false\" aria-controls=\"lf\"><span class=\"ok\" aria-hidden=\"true\">\u2713</span><ul id=\"lf\" role=\"listbox\" hidden></ul></div>\n      <label for=\"qt\">Deliver to</label>\n      <div class=\"ac\" id=\"act\"><input id=\"qt\" autocomplete=\"off\" placeholder=\"Postcode or address\" role=\"combobox\" aria-autocomplete=\"list\" aria-expanded=\"false\" aria-controls=\"lt\"><span class=\"ok\" aria-hidden=\"true\">\u2713</span><ul id=\"lt\" role=\"listbox\" hidden></ul></div>\n      <label id=\"vl\">Van</label>\n      <div class=\"vans\" role=\"radiogroup\" aria-labelledby=\"vl\">${cfg.vehicles.map(v => `<label class=\"van${v.id === st.vehicle ? ' on' : ''}\"><input type=\"radio\" name=\"veh\" value=\"${esc(v.id)}\"${v.id === st.vehicle ? ' checked' : ''}><b>${esc(v.name)}</b><span>${esc(v.desc || '')}</span></label>`).join('')}</div>\n      <label for=\"qw\">Collection time</label>\n      <input id=\"qw\" type=\"datetime-local\" value=\"${esc(st.when)}\">\n      <label class=\"chk\"><input type=\"checkbox\" id=\"qa\"${st.asap ? ' checked' : ''}><span>As soon as possible${+cfg.urgentPct ? ' (urgent, +' + esc(cfg.urgentPct) + '%)' : ''}</span></label>\n      <button class=\"btn\" id=\"go\">See my price</button>\n      <p class=\"err\" id=\"e1\" role=\"alert\" hidden></p>\n      <div id=\"res\" aria-live=\"polite\"></div>\n      ${by()}`;\n    auto('f', 'from'); auto('t', 'to');\n    if (st.from) { $('#qf').value = st.from.label; $('#acf').classList.add('set'); }\n    if (st.to) { $('#qt').value = st.to.label; $('#act').classList.add('set'); }\n    box.querySelectorAll('input[name=veh]').forEach(r => r.addEventListener('change', () => { st.vehicle = r.value; box.querySelectorAll('.van').forEach(l => l.classList.toggle('on', l.contains(r) && r.checked)); if (st.quote) price(); }));\n    const qa = $('#qa'), qw = $('#qw');\n    const sync = () => { qw.disabled = qa.checked; qw.style.opacity = qa.checked ? .5 : 1; };\n    qa.addEventListener('change', () => { st.asap = qa.checked; sync(); if (st.quote) price(); }); sync();\n    qw.addEventListener('change', () => { st.when = qw.value; if (st.quote) price(); });\n    $('#go').addEventListener('click', price);\n    if (st.quote) showQuote(st.quote);\n  }\n\n  /* address search with a list to pick from (arrow keys, Enter, Escape) */\n  function auto(k, field) {\n    const inp = $('#q' + k), list = $('#l' + k), wrap = $('#ac' + k);\n    let items = [], idx = -1, timer = 0, seq = 0;\n    const close = () => { list.hidden = true; inp.setAttribute('aria-expanded', 'false'); idx = -1; };\n    const draw = () => {\n      list.innerHTML = items.length ? items.map((p, i) => `<li role=\"option\" id=\"o${k}${i}\" aria-selected=\"${i === idx}\">${esc(p.label)}</li>`).join('') : '<li class=\"none\">No match. Try the postcode.</li>';\n      list.hidden = false; inp.setAttribute('aria-expanded', 'true'); inp.setAttribute('aria-activedescendant', idx >= 0 ? 'o' + k + idx : '');\n    };\n    const pick = i => { const p = items[i]; if (!p) return; st[field] = p; inp.value = p.label; wrap.classList.add('set'); close(); st.quote = null; $('#res').innerHTML = ''; };\n    inp.addEventListener('input', () => {\n      st[field] = null; wrap.classList.remove('set'); clearTimeout(timer);\n      const q = inp.value.trim(); if (q.length < 3) { close(); return; }\n      timer = setTimeout(async () => { const my = ++seq; try { const r = await api.places(q); if (my !== seq) return; items = r || []; idx = items.length ? 0 : -1; draw(); } catch (e) { items = []; draw(); } }, 250);\n    });\n    inp.addEventListener('keydown', e => {\n      if (list.hidden) return;\n      if (e.key === 'ArrowDown') { idx = Math.min(items.length - 1, idx + 1); draw(); e.preventDefault(); }\n      else if (e.key === 'ArrowUp') { idx = Math.max(0, idx - 1); draw(); e.preventDefault(); }\n      else if (e.key === 'Enter') { if (idx >= 0) { pick(idx); e.preventDefault(); } }\n      else if (e.key === 'Escape') close();\n    });\n    list.addEventListener('mousedown', e => { const li = e.target.closest('li[role=option]'); if (li) { e.preventDefault(); pick([].indexOf.call(list.children, li)); } });\n    inp.addEventListener('blur', () => setTimeout(close, 150));\n  }\n\n  async function price() {\n    const e1 = $('#e1'), go = $('#go'); e1.hidden = true;\n    if (!st.from || !st.to) { e1.textContent = 'Please choose both addresses from the list.'; e1.hidden = false; return; }\n    const w = $('#qw').value;\n    if (!st.asap && !w) { e1.textContent = 'Please choose a collection time or tick \"as soon as possible\".'; e1.hidden = false; return; }\n    go.disabled = true; go.textContent = 'Working out your price\u2026';\n    try {\n      const q = await api.quote({ from: st.from, to: st.to, vehicle: st.vehicle, asap: st.asap, when: st.asap ? '' : new Date(w).toISOString() });\n      st.quote = q; showQuote(q);\n    } catch (err) { e1.textContent = err.message; e1.hidden = false; $('#res').innerHTML = ''; }\n    finally { go.disabled = false; go.textContent = st.quote ? 'Update price' : 'See my price'; }\n  }\n\n  function vatNote(q) { return q.vatMode === 'add' ? '+ VAT ' + gbp(q.vat) + ' (' + gbp(q.total) + ' in total)' : q.vatMode === 'inc' ? 'Includes VAT' : 'No VAT to add'; }\n  function showQuote(q) {\n    const t = st.asap ? 'As soon as possible' : new Date($('#qw').value).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });\n    $('#res').innerHTML = `<div class=\"res\">\n      <div class=\"price\"><div><div class=\"big\">${gbp(q.net)}</div><small>${esc(vatNote(q))}</small></div><small>${esc(q.vehicleName)} \u00b7 ${esc(t)}</small></div>\n      <div class=\"trip\"><span class=\"dot\"></span><span>${esc(st.from.label)}</span><span class=\"bar\"></span><span class=\"meta\">${Math.round(q.miles)} miles \u00b7 about ${fmtMins(q.mins)}${q.exact ? '' : ' (approx.)'}</span><span class=\"dot b\"></span><span>${esc(st.to.label)}</span></div>\n      <details><summary>How we worked it out</summary><table>${q.lines.map(l => `<tr><td>${esc(l.label)}</td><td>${gbp(l.amount)}</td></tr>`).join('')}<tr><td><b>Price</b></td><td><b>${gbp(q.net)}</b></td></tr></table></details>\n      ${OFFLINE ? '' : '<div class=\"map\" id=\"map\" hidden></div>'}\n      <button class=\"btn\" id=\"bk\">Book this delivery</button></div>`;\n    $('#bk').addEventListener('click', step2);\n    if (!OFFLINE) drawMap(q.line);\n  }\n  const fmtMins = m => m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') + ' min';\n\n  /* route map: Leaflet from cdnjs, loaded only when there is a route to show */\n  let leaflet = null;\n  function loadLeaflet() {\n    if (window.L) return Promise.resolve(window.L);\n    if (leaflet) return leaflet;\n    leaflet = new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'; s.onload = () => ok(window.L); s.onerror = no; document.head.appendChild(s); });\n    return leaflet;\n  }\n  async function drawMap(line) {\n    try {\n      const L = await loadLeaflet(), el = $('#map'); if (!el || !line || line.length < 2) return;\n      if (!root.querySelector('link[data-l]')) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'; l.setAttribute('data-l', '1'); root.insertBefore(l, root.firstChild); }\n      el.hidden = false;\n      const m = L.map(el, { zoomControl: false, attributionControl: true, scrollWheelZoom: false, dragging: !L.Browser.mobile });\n      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '\u00a9 OpenStreetMap' }).addTo(m);\n      const pl = L.polyline(line, { color: cfg.colour || '#0B5FFF', weight: 4 }).addTo(m);\n      L.circleMarker(line[0], { radius: 6, color: cfg.colour, fillColor: '#fff', fillOpacity: 1, weight: 3 }).addTo(m);\n      L.circleMarker(line[line.length - 1], { radius: 6, color: cfg.colour, fillColor: cfg.colour, fillOpacity: 1, weight: 3 }).addTo(m);\n      m.fitBounds(pl.getBounds(), { padding: [18, 18] });\n    } catch (e) { const el = $('#map'); if (el) el.hidden = true; }\n  }\n\n  function step2() {\n    const q = st.quote; st.startedAt = Date.now();\n    box.innerHTML = `\n      <h3>Your details</h3>\n      <p class=\"sub\">${gbp(q.net)} \u00b7 ${esc(q.vehicleName)} \u00b7 ${esc(st.from.label.split(',')[0])} \u2192 ${esc(st.to.label.split(',')[0])}</p>\n      <label for=\"cn\">Your name</label><input id=\"cn\" autocomplete=\"name\" maxlength=\"100\">\n      <label for=\"cc\">Company (optional)</label><input id=\"cc\" autocomplete=\"organization\" maxlength=\"100\">\n      <div class=\"row\"><div><label for=\"cp\">Phone</label><input id=\"cp\" type=\"tel\" autocomplete=\"tel\" maxlength=\"30\" placeholder=\"07123 456789\"></div><div><label for=\"ce\">Email</label><input id=\"ce\" type=\"email\" autocomplete=\"email\" maxlength=\"200\"></div></div>\n      <label for=\"cg\">What are we carrying?</label><input id=\"cg\" maxlength=\"300\" placeholder=\"e.g. 2 boxes, 40 kg\">\n      <label for=\"cx\">Anything else (optional)</label><textarea id=\"cx\" maxlength=\"600\" placeholder=\"e.g. loading bay at the back, call 10 min before\"></textarea>\n      <div class=\"hp\" aria-hidden=\"true\"><label>Leave empty<input id=\"cw\" tabindex=\"-1\" autocomplete=\"off\"></label></div>\n      <label class=\"chk\"><input type=\"checkbox\" id=\"ck\"><span>I agree that ${esc(cfg.name)} uses my details to arrange this delivery${cfg.terms ? ' and accept the <a href=\"' + esc(cfg.terms) + '\" target=\"_blank\" rel=\"noopener\">terms</a>' : ''}${cfg.privacy ? ' (<a href=\"' + esc(cfg.privacy) + '\" target=\"_blank\" rel=\"noopener\">privacy</a>)' : ''}.</span></label>\n      <button class=\"btn\" id=\"sb\">Send booking request</button>\n      <button class=\"btn ghost\" id=\"bb\" type=\"button\">Back</button>\n      <p class=\"err\" id=\"e2\" role=\"alert\" hidden></p>\n      ${by()}`;\n    $('#bb').addEventListener('click', step1);\n    $('#sb').addEventListener('click', send);\n    $('#cn').focus();\n  }\n\n  async function send() {\n    const e2 = $('#e2'), sb = $('#sb'), v = id => $(id).value.trim();\n    e2.hidden = true;\n    const c = { name: v('#cn'), company: v('#cc'), phone: v('#cp'), email: v('#ce') };\n    const bad = c.name.length < 2 ? 'Please enter your name.' : c.phone.replace(/\\D/g, '').length < 10 ? 'Please enter a phone number we can call.' : !/^[^\\s@]+@[^\\s@]+\\.[a-z]{2,}$/i.test(c.email) ? 'Please enter a valid email address.' : !$('#ck').checked ? 'Please tick the box to agree.' : '';\n    if (bad) { e2.textContent = bad; e2.hidden = false; return; }\n    sb.disabled = true; sb.textContent = 'Sending\u2026';\n    try {\n      const r = await api.book({ from: st.from, to: st.to, vehicle: st.vehicle, asap: st.asap, when: st.asap ? '' : new Date(st.when || $('#qw') && $('#qw').value).toISOString(), customer: c, goods: v('#cg'), notes: v('#cx'), consent: true, website: v('#cw'), startedAt: st.startedAt });\n      done(r);\n    } catch (err) { e2.textContent = err.message; e2.hidden = false; sb.disabled = false; sb.textContent = 'Send booking request'; }\n  }\n\n  function done(r) {\n    box.innerHTML = `<div class=\"done\"><div class=\"tick\" aria-hidden=\"true\">\u2713</div><h3>Request sent</h3><div class=\"ref\">${esc(r.ref)}</div>\n      <p class=\"sub\">${esc(r.thanks || cfg.thanks)}${cfg.phone ? ' Need it sooner? Call <a href=\"tel:' + esc(cfg.phone.replace(/\\s/g, '')) + '\">' + esc(cfg.phone) + '</a>.' : ''}</p>\n      <button class=\"btn ghost\" id=\"again\" type=\"button\">Get another price</button></div>${by()}`;\n    $('#again').addEventListener('click', () => { st = { from: null, to: null, vehicle: st.vehicle, asap: false, when: '', quote: null, startedAt: Date.now() }; step1(); });\n    try { host.dispatchEvent(new CustomEvent('prjquote:booked', { bubbles: true, detail: { ref: r.ref, total: r.total } })); } catch (e) {}\n  }\n\n  function by() { return cfg.plan === 'pro' ? '' : '<div class=\"by\">Instant quotes by <a href=\"' + BRAND_URL + '\" target=\"_blank\" rel=\"noopener\">COSO</a></div>'; }\n})();\n\n})();\n";
const ADMIN_HTML = "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"robots\" content=\"noindex\">\n<title>COSO \u00b7 Admin</title>\n<style>\n:root{--c:#111111;--ink:#111827;--mut:#5B6472;--line:#E3E6EB;--soft:#F5F7FA}\n*{box-sizing:border-box}body{margin:0;font:15px/1.5 -apple-system,\"Segoe UI\",Roboto,Arial,sans-serif;color:var(--ink);background:var(--soft)}\nheader{background:#111827;color:#fff;padding:14px 20px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}header b{font-size:1.05rem}header span{color:#9CA3AF;font-size:.85rem}\nmain{max-width:1100px;margin:0 auto;padding:20px 16px 60px;display:grid;gap:16px}\n.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:18px;min-width:0}\nh2{margin:0 0 12px;font-size:1.1rem}\nlabel{display:flex;flex-direction:column;gap:4px;font-size:.8rem;font-weight:600;color:var(--mut);min-width:0}\ninput,select,textarea{font:inherit;color:var(--ink);border:1.5px solid var(--line);border-radius:8px;padding:8px 10px;width:100%;min-width:0;background:#fff}\n.g{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}@media(max-width:760px){.g{grid-template-columns:repeat(2,minmax(0,1fr))}}\n.w2{grid-column:span 2}\n.btn{font:inherit;font-weight:600;border:1.5px solid var(--line);background:#fff;border-radius:8px;padding:8px 14px;cursor:pointer}.btn.go{background:var(--c);border-color:var(--c);color:#fff}\n.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}\ntable{width:100%;border-collapse:collapse;font-size:.9rem}th{text-align:left;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);border-bottom:1.5px solid var(--line);padding:6px}td{border-bottom:1px solid var(--line);padding:7px 6px;vertical-align:top}\n.tbl{overflow-x:auto}.r{text-align:right;white-space:nowrap}\n.van{display:grid;grid-template-columns:1fr 1.4fr 2fr .8fr .8fr .8fr .8fr auto;gap:6px;align-items:end;margin-bottom:6px}@media(max-width:760px){.van{grid-template-columns:repeat(2,minmax(0,1fr))}}\n.msg{font-weight:600}.msg.bad{color:#B42318}.msg.ok{color:#15803D}\npre{white-space:pre-wrap;background:var(--soft);padding:10px;border-radius:8px;font-size:.85rem;margin:0}\ncode{background:var(--soft);padding:2px 5px;border-radius:5px;font-size:.85rem;word-break:break-all}\n[hidden]{display:none!important}\n</style></head><body>\n<header><b><span style=\"background:#FFC20E;color:#111;border-radius:6px;padding:2px 7px;margin-right:6px\">COSO</span>Instant Quote \u00b7 Admin</b><span>Companies, price lists and booking requests</span></header>\n<main>\n  <section class=\"card\" id=\"login\">\n    <h2>Sign in</h2>\n    <form class=\"row\" id=\"lf\"><label style=\"flex:1;min-width:220px\">Admin key (the ADMIN_KEY secret you set in Cloudflare)<input id=\"key\" type=\"password\" autocomplete=\"current-password\"></label><button class=\"btn go\">Open</button></form>\n    <p class=\"msg bad\" id=\"lm\"></p>\n  </section>\n\n  <div id=\"app\" hidden style=\"display:grid;gap:16px\">\n  <section class=\"card\">\n    <h2>Companies</h2>\n    <div class=\"tbl\"><table><thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Websites</th><th>Plan</th><th></th></tr></thead><tbody id=\"tl\"></tbody></table></div>\n    <div class=\"row\" style=\"margin-top:10px\"><button class=\"btn\" id=\"new\">+ New company</button></div>\n  </section>\n\n  <section class=\"card\" id=\"ed\" hidden>\n    <h2 id=\"edh\">Company</h2>\n    <div class=\"g\">\n      <label>ID (in the website code)<input id=\"f_id\" pattern=\"[a-z0-9-]{2,40}\" placeholder=\"e.g. swift-couriers\"></label>\n      <label class=\"w2\">Company name<input id=\"f_name\"></label>\n      <label>Colour<input id=\"f_colour\" type=\"color\" value=\"#0B5FFF\"></label>\n      <label class=\"w2\">Email for booking requests<input id=\"f_email\" type=\"email\"></label>\n      <label>Phone shown to customers<input id=\"f_phone\"></label>\n      <label>Plan<select id=\"f_plan\"><option value=\"basic\">Basic (\u00a319, shows \"by COSO\")</option><option value=\"pro\">Pro (\u00a339, no COSO link)</option></select></label>\n      <label class=\"w2\">Websites allowed (comma separated, * = any)<input id=\"f_domains\" placeholder=\"swiftcouriers.co.uk\"></label>\n      <label>VAT<select id=\"f_vat\"><option value=\"none\">No VAT</option><option value=\"add\">Add 20% VAT</option><option value=\"inc\">Prices include VAT</option></select></label>\n      <label>Round price to<select id=\"f_roundTo\"><option value=\"1\">\u00a31</option><option value=\"5\">\u00a35</option><option value=\"0.5\">50p</option><option value=\"0.01\">1p</option></select></label>\n      <label>Max miles online<input id=\"f_maxMiles\" type=\"number\" min=\"1\"></label>\n      <label>Min notice (minutes)<input id=\"f_minNoticeMins\" type=\"number\" min=\"0\"></label>\n      <label>Urgent / ASAP +%<input id=\"f_urgentPct\" type=\"number\" min=\"0\"></label>\n      <label>Outside hours +%<input id=\"f_outOfHoursPct\" type=\"number\" min=\"0\"></label>\n      <label>Weekend +%<input id=\"f_weekendPct\" type=\"number\" min=\"0\"></label>\n      <label>Hours from<input id=\"f_hs\" type=\"number\" min=\"0\" max=\"23\"></label>\n      <label>Hours to<input id=\"f_he\" type=\"number\" min=\"1\" max=\"24\"></label>\n      <label class=\"w2\">Working days (1=Mon \u2026 6=Sat, 0=Sun)<input id=\"f_days\" placeholder=\"1,2,3,4,5\"></label>\n      <label class=\"w2\">Terms page (https)<input id=\"f_terms\"></label>\n      <label class=\"w2\">Privacy page (https)<input id=\"f_privacy\"></label>\n      <label class=\"w2\">Logo (https, optional)<input id=\"f_logo\"></label>\n      <label class=\"w2\">Message after booking<input id=\"f_thanks\"></label>\n      <label>Active<select id=\"f_active\"><option value=\"1\">Yes</option><option value=\"0\">Paused</option></select></label>\n    </div>\n    <h2 style=\"margin-top:18px\">Vans and prices</h2>\n    <div class=\"van\" style=\"font-size:.72rem;color:var(--mut);font-weight:700\"><span>ID</span><span>Name</span><span>Description</span><span>Max kg</span><span>Start \u00a3</span><span>\u00a3 per mile</span><span>Minimum \u00a3</span><span></span></div>\n    <div id=\"vans\"></div>\n    <div class=\"row\"><button class=\"btn\" id=\"addv\" type=\"button\">+ Van</button></div>\n    <div class=\"row\" style=\"margin-top:16px\"><button class=\"btn go\" id=\"save\">Save company</button><button class=\"btn\" id=\"del\" type=\"button\">Delete</button><span class=\"msg\" id=\"em\"></span></div>\n    <p style=\"margin-top:14px;font-size:.85rem;color:var(--mut)\">Code for the company's website:</p>\n    <pre id=\"code\"></pre>\n  </section>\n\n  <section class=\"card\">\n    <h2>Booking requests</h2>\n    <div class=\"row\" style=\"margin-bottom:8px\"><select id=\"lt\" style=\"width:auto\"><option value=\"\">All companies</option></select><button class=\"btn\" id=\"lr\">Refresh</button></div>\n    <div class=\"tbl\"><table><thead><tr><th>When</th><th>Company</th><th>Ref</th><th>Customer</th><th>From \u2192 To</th><th class=\"r\">Price</th></tr></thead><tbody id=\"ll\"></tbody></table></div>\n    <pre id=\"ld\" hidden style=\"margin-top:10px\"></pre>\n  </section>\n  </div>\n</main>\n<script>\n\"use strict\";\nconst $=id=>document.getElementById(id),esc=s=>String(s==null?'':s).replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));\nlet KEY='',T=[],cur=null;\ntry{KEY=sessionStorage.getItem('iq_key')||''}catch(e){}\nasync function call(p,o){o=o||{};const r=await fetch(p,Object.assign({},o,{headers:Object.assign({'Authorization':'Bearer '+KEY,'Content-Type':'application/json'},o.headers||{})}));const j=await r.json().catch(()=>({}));if(!r.ok||!j.ok)throw new Error(j.error||('Error '+r.status));return j}\n$('lf').onsubmit=async e=>{e.preventDefault();KEY=$('key').value.trim();await start()};\nasync function start(){try{await load();try{sessionStorage.setItem('iq_key',KEY)}catch(e){}$('login').hidden=true;$('app').hidden=false;leads()}catch(e){$('lm').textContent=e.message;try{sessionStorage.removeItem('iq_key')}catch(x){}}}\nasync function load(){const j=await call('/admin/tenants');T=j.tenants;$('tl').innerHTML=T.length?T.map((t,i)=>`<tr><td><code>${esc(t.id)}</code></td><td>${esc(t.name)}${t.active===false?' (paused)':''}</td><td>${esc(t.email)}</td><td>${esc((t.domains||[]).join(', '))}</td><td>${esc(t.plan)}</td><td><button class=\"btn\" data-i=\"${i}\">Edit</button></td></tr>`).join(''):'<tr><td colspan=\"6\">No companies yet. The demo works without one.</td></tr>';\n  $('lt').innerHTML='<option value=\"\">All companies</option>'+T.map(t=>`<option value=\"${esc(t.id)}\">${esc(t.name)}</option>`).join('')}\n$('tl').onclick=e=>{const b=e.target.closest('[data-i]');if(b)edit(T[+b.dataset.i])};\n$('new').onclick=()=>edit({id:'',name:'',colour:'#0B5FFF',plan:'basic',domains:['*'],vat:'none',roundTo:1,maxMiles:300,minNoticeMins:60,urgentPct:25,outOfHoursPct:25,weekendPct:30,hours:{start:8,end:18,days:[1,2,3,4,5]},active:true,\n  vehicles:[{id:'small',name:'Small van',desc:'Boxes and parcels, up to 400 kg',maxKg:400,base:30,perMile:1.1,minimum:40},{id:'swb',name:'SWB van',desc:'Up to 2 pallets or 800 kg',maxKg:800,base:35,perMile:1.3,minimum:50},{id:'lwb',name:'LWB van',desc:'Up to 3 pallets or 1,100 kg',maxKg:1100,base:40,perMile:1.5,minimum:60}]});\nconst F=['name','colour','email','phone','plan','vat','roundTo','maxMiles','minNoticeMins','urgentPct','outOfHoursPct','weekendPct','terms','privacy','logo','thanks'];\nfunction edit(t){cur=t;$('ed').hidden=false;$('edh').textContent=t.id?'Edit: '+t.name:'New company';$('f_id').value=t.id;$('f_id').disabled=!!t.id;\n  F.forEach(k=>{$('f_'+k).value=t[k]==null?'':t[k]});$('f_domains').value=(t.domains||['*']).join(', ');$('f_hs').value=t.hours.start;$('f_he').value=t.hours.end;$('f_days').value=(t.hours.days||[]).join(',');$('f_active').value=t.active===false?'0':'1';\n  $('vans').innerHTML='';(t.vehicles||[]).forEach(addVan);code();$('em').textContent='';$('ed').scrollIntoView({behavior:'smooth'})}\nfunction addVan(v){v=v||{id:'',name:'',desc:'',maxKg:'',base:'',perMile:'',minimum:''};const d=document.createElement('div');d.className='van';\n  d.innerHTML=['id','name','desc','maxKg','base','perMile','minimum'].map(k=>`<input data-k=\"${k}\" value=\"${esc(v[k])}\" ${['maxKg','base','perMile','minimum'].includes(k)?'type=\"number\" step=\"0.01\" min=\"0\"':''} aria-label=\"${k}\">`).join('')+'<button class=\"btn\" type=\"button\" aria-label=\"Remove van\">\u2715</button>';\n  d.querySelector('button').onclick=()=>d.remove();$('vans').appendChild(d)}\n$('addv').onclick=()=>addVan();\nfunction code(){const id=$('f_id').value||'company-id';$('code').textContent='<div data-prj-quote></div>\\n<script src=\"'+location.origin+'/widget.js\" data-tenant=\"'+id+'\" async><\\/script>'}\n$('f_id').oninput=code;\n$('save').onclick=async()=>{const id=$('f_id').value.trim().toLowerCase();if(!/^[a-z0-9-]{2,40}$/.test(id)){$('em').className='msg bad';$('em').textContent='ID: 2\u201340 lower-case letters, digits or dashes.';return}\n  const t={};F.forEach(k=>t[k]=$('f_'+k).value);['roundTo','maxMiles','minNoticeMins','urgentPct','outOfHoursPct','weekendPct'].forEach(k=>t[k]=+t[k]);\n  t.domains=$('f_domains').value.split(',').map(s=>s.trim()).filter(Boolean);t.hours={start:+$('f_hs').value,end:+$('f_he').value,days:$('f_days').value.split(',').map(s=>+s.trim()).filter(n=>!isNaN(n))};t.active=$('f_active').value==='1';\n  t.vehicles=[...$('vans').children].map(d=>{const o={};d.querySelectorAll('input').forEach(i=>o[i.dataset.k]=i.type==='number'?+i.value:i.value.trim());return o});\n  try{await call('/admin/tenants/'+id,{method:'PUT',body:JSON.stringify(t)});$('em').className='msg ok';$('em').textContent='Saved.';await load();$('f_id').disabled=true}catch(e){$('em').className='msg bad';$('em').textContent=e.message}};\n$('del').onclick=async()=>{const id=$('f_id').value;if(!id||!confirm('Delete '+id+'? Their website form stops working.'))return;try{await call('/admin/tenants/'+id,{method:'DELETE'});$('ed').hidden=true;await load()}catch(e){$('em').textContent=e.message}};\nasync function leads(){try{const j=await call('/admin/leads?t='+encodeURIComponent($('lt').value));$('ll').innerHTML=j.leads.length?j.leads.map(l=>`<tr data-k=\"${esc(l.key)}\" style=\"cursor:pointer\"><td>${esc(new Date(l.created).toLocaleString('en-GB'))}</td><td>${esc(l.tenant)}</td><td>${esc(l.ref)}</td><td>${esc(l.name)}</td><td>${esc(l.from)} \u2192 ${esc(l.to)}</td><td class=\"r\">\u00a3${(+l.total).toFixed(2)}</td></tr>`).join(''):'<tr><td colspan=\"6\">No booking requests yet.</td></tr>'}catch(e){$('ll').innerHTML='<tr><td colspan=\"6\">'+esc(e.message)+'</td></tr>'}}\n$('lr').onclick=leads;$('lt').onchange=leads;\n$('ll').onclick=async e=>{const tr=e.target.closest('tr[data-k]');if(!tr)return;try{const j=await call('/admin/lead?key='+encodeURIComponent(tr.dataset.k));const l=j.lead;$('ld').hidden=false;$('ld').textContent=`${l.ref} \u00b7 ${l.customer.name}${l.customer.company?' ('+l.customer.company+')':''}\\n${l.customer.phone} \u00b7 ${l.customer.email}\\n\\nFrom: ${l.from.label}\\nTo: ${l.to.label}\\nWhen: ${l.asap?'ASAP':new Date(l.when).toLocaleString('en-GB')}\\nVan: ${l.vehicle} \u00b7 ${l.miles} miles\\nGoods: ${l.goods||'-'}\\nNotes: ${l.notes||'-'}\\n\\n${l.lines.map(x=>x.label+': \u00a3'+x.amount.toFixed(2)).join('\\n')}\\nPrice: \u00a3${l.net.toFixed(2)}${l.vatMode==='add'?' + VAT \u00a3'+l.vat.toFixed(2):''}\\nPage: ${l.page||'-'}`}catch(x){}};\nif(KEY)start();\n</script>\n</body></html>\n";
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
