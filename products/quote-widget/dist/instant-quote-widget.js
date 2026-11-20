/* PRJ Instant Quote widget */
(function(){
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

/* ---- PRJ Instant Quote: the widget a courier company pastes into its website ----
   <div data-prj-quote></div>
   script tag: src="https://YOUR-WORKER/widget.js" data-tenant="company-id" async
   Optional: data-target="#css-selector", data-mode="offline" (sales demo, no server). */
(function () {
  'use strict';
  const S = document.currentScript || document.querySelector('script[src*="widget.js"][data-tenant]');
  if (!S) return;
  const TID = S.getAttribute('data-tenant') || 'demo';
  let OFFLINE = S.getAttribute('data-mode') === 'offline';
  const FALLBACK = S.getAttribute('data-fallback') === 'offline';   // sales page: if the server is not reachable, run the offline demo
  let API = S.getAttribute('data-api') || '';
  if (!API) { try { API = new URL(S.src, location.href).origin; } catch (e) { API = ''; } }

  const host = document.querySelector(S.getAttribute('data-target') || '[data-prj-quote]') || (function () { const d = document.createElement('div'); S.parentNode.insertBefore(d, S.nextSibling); return d; })();
  if (host.__prjq) return; host.__prjq = 1;
  const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  /* ---------- talking to the server (or the offline sales demo) ---------- */
  const SAMPLE = [
    ['14 Broad Street, Reading RG1 2BH', 51.4560, -0.9730], ['Green Park, Reading RG2 6UB', 51.4280, -0.9900], ['Slough Trading Estate, Slough SL1 4LA', 51.5190, -0.6290],
    ['Bracknell Town Centre, Bracknell RG12 1BE', 51.4150, -0.7520], ['Wokingham Market Place, Wokingham RG40 1AL', 51.4110, -0.8340], ['Maidenhead High Street, Maidenhead SL6 1QJ', 51.5220, -0.7190],
    ['Heathrow Airport, Hounslow TW6 1QG', 51.4700, -0.4540], ['Oxford Business Park, Oxford OX4 2RU', 51.7350, -1.1950], ['Basingstoke Business Park, Basingstoke RG24 8WA', 51.2760, -1.0590],
    ['Canary Wharf, London E14 5AB', 51.5050, -0.0190], ['Park Royal, London NW10 7NU', 51.5290, -0.2700], ['Milton Keynes Central, Milton Keynes MK9 2FW', 52.0340, -0.7740],
    ['Birmingham City Centre, Birmingham B2 4RU', 52.4790, -1.9000], ['Bristol Temple Quay, Bristol BS1 6DG', 51.4510, -2.5830], ['Southampton Docks, Southampton SO14 3QN', 50.8990, -1.4040]
  ].map(r => ({ label: r[0], lat: r[1], lon: r[2] }));
  const api = {
    async config() {
      if (OFFLINE) return Object.assign({}, DEFAULT_TENANT, { name: S.getAttribute('data-name') || DEFAULT_TENANT.name, colour: S.getAttribute('data-colour') || DEFAULT_TENANT.colour, phone: S.getAttribute('data-phone') || '' });
      const j = await get('/v1/config?t=' + encodeURIComponent(TID)); return j.tenant;
    },
    async places(q) {
      if (OFFLINE) { const w = q.toLowerCase().split(/\s+/).filter(Boolean); return SAMPLE.filter(p => w.every(x => p.label.toLowerCase().indexOf(x) >= 0)).slice(0, 6); }
      return (await get('/v1/places?t=' + encodeURIComponent(TID) + '&q=' + encodeURIComponent(q))).places;
    },
    async quote(b) {
      if (OFFLINE) {
        await wait(350);
        const miles = crowMiles([b.from.lat, b.from.lon], [b.to.lat, b.to.lon]) * 1.25, p = priceQuote(cfg, miles, b);
        if (!p.ok) throw new Error(p.error);
        return Object.assign(p, { mins: Math.round(miles / 32 * 60), exact: false, line: [[b.from.lat, b.from.lon], [b.to.lat, b.to.lon]] });
      }
      return post('/v1/quote', b);
    },
    async book(b) {
      if (OFFLINE) { await wait(500); return { ok: true, ref: 'Q-DEMO' + Math.floor(Math.random() * 90 + 10), thanks: 'This is a demo, so nothing was sent. On a live website the courier would get your request by email straight away.' }; }
      return post('/v1/book', b);
    }
  };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  async function get(p) { const r = await fetch(API + p); const j = await r.json().catch(() => ({})); if (!r.ok || !j.ok) throw new Error(j.error || 'Could not connect. Please try again.'); return j; }
  async function post(p, b) { const r = await fetch(API + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ t: TID }, b)) }); const j = await r.json().catch(() => ({})); if (!r.ok || !j.ok) throw new Error(j.error || 'Could not connect. Please try again.'); return j; }

  /* ---------- look ---------- */
  const CSS = `
:host{all:initial;display:block;font-family:inherit;color:#111827}
*{box-sizing:border-box}
.q{--c:#0B5FFF;--ink:#111827;--mut:#5B6472;--line:#E3E6EB;--soft:#F5F7FA;font:16px/1.5 var(--font,inherit);color:var(--ink);background:#fff;border:1px solid var(--line);border-radius:14px;padding:22px;max-width:580px;box-shadow:0 1px 2px rgba(17,24,39,.04),0 8px 24px rgba(17,24,39,.06)}
h3{margin:0 0 4px;font-size:1.3rem;line-height:1.2}
.sub{color:var(--mut);font-size:.92rem;margin:0 0 16px}
label{display:block;font-weight:600;font-size:.88rem;margin:14px 0 6px}
input,textarea,select{width:100%;font:inherit;font-size:1rem;color:var(--ink);background:#fff;border:1.5px solid var(--line);border-radius:10px;padding:11px 12px;min-width:0}
textarea{resize:vertical;min-height:70px}
input:focus,textarea:focus{outline:none;border-color:var(--c);box-shadow:0 0 0 3px color-mix(in srgb,var(--c) 22%,transparent)}
.ac{position:relative}
.ac ul{position:absolute;z-index:5;left:0;right:0;top:calc(100% + 4px);margin:0;padding:4px;list-style:none;background:#fff;border:1px solid var(--line);border-radius:10px;box-shadow:0 10px 30px rgba(17,24,39,.12);max-height:260px;overflow:auto}
.ac li{padding:9px 10px;border-radius:7px;cursor:pointer;font-size:.95rem}
.ac li[aria-selected=true],.ac li:hover{background:var(--soft)}
.ac li.none{color:var(--mut);cursor:default}
.ok{display:none;position:absolute;right:12px;top:50%;transform:translateY(-50%);color:#16A34A;font-weight:700}
.ac.set .ok{display:block}.ac.set input{padding-right:34px}
.vans{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:8px}
.van{position:relative;border:1.5px solid var(--line);border-radius:10px;padding:10px 12px;cursor:pointer;display:block;margin:0;font-weight:400}
.van input{position:absolute;opacity:0;pointer-events:none}
.van b{display:block;font-size:.95rem}.van span{display:block;color:var(--mut);font-size:.8rem;line-height:1.35}
.van.on{border-color:var(--c);background:color-mix(in srgb,var(--c) 7%,#fff)}
.van:focus-within{box-shadow:0 0 0 3px color-mix(in srgb,var(--c) 22%,transparent)}
.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.chk{display:flex;gap:9px;align-items:flex-start;font-weight:500;font-size:.92rem;margin-top:12px}
.chk input{width:18px;height:18px;margin:2px 0 0;accent-color:var(--c);flex:none}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;margin-top:18px;padding:14px 18px;border:0;border-radius:10px;background:var(--c);color:#fff;font:inherit;font-weight:700;font-size:1rem;cursor:pointer}
.btn[disabled]{opacity:.55;cursor:progress}
.btn.ghost{background:#fff;color:var(--ink);border:1.5px solid var(--line);margin-top:10px}
.err{color:#B42318;font-size:.9rem;font-weight:600;margin:10px 0 0}
.res{margin-top:18px;border-top:1px solid var(--line);padding-top:18px}
.price{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
.price .big{font-size:2.3rem;font-weight:800;letter-spacing:-.02em;line-height:1}
.price small{color:var(--mut);font-size:.88rem}
.trip{display:grid;grid-template-columns:14px 1fr;column-gap:10px;row-gap:2px;margin:14px 0 4px;font-size:.92rem}
.dot{width:12px;height:12px;border-radius:50%;border:3px solid var(--c);margin-top:4px;background:#fff}.dot.b{background:var(--c)}
.bar{width:2px;height:16px;background:repeating-linear-gradient(var(--line) 0 3px,transparent 3px 6px);margin-left:5px}
.meta{color:var(--mut);font-size:.88rem}
details{margin-top:10px;font-size:.9rem}summary{cursor:pointer;color:var(--mut)}
table{width:100%;border-collapse:collapse;margin-top:6px}td{padding:5px 0;border-bottom:1px solid var(--line)}td:last-child{text-align:right;white-space:nowrap}
.map{height:200px;margin-top:12px;border-radius:10px;overflow:hidden;border:1px solid var(--line);background:var(--soft)}
.done{text-align:center;padding:12px 0}
.done .tick{width:54px;height:54px;border-radius:50%;background:color-mix(in srgb,var(--c) 12%,#fff);color:var(--c);display:grid;place-items:center;margin:0 auto 10px;font-size:1.6rem;font-weight:800}
.ref{display:inline-block;margin:8px 0;padding:6px 12px;border-radius:8px;background:var(--soft);font-weight:700;letter-spacing:.04em}
.by{margin-top:14px;text-align:center;font-size:.75rem;color:var(--mut)}.by a{color:inherit}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
@media (max-width:420px){.q{padding:16px;border-radius:12px}.row{grid-template-columns:1fr}.price .big{font-size:2rem}}
@media (prefers-reduced-motion:no-preference){.res{animation:in .25s ease-out}@keyframes in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}}`;

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const gbp = n => '£' + (+n).toLocaleString('en-GB', { minimumFractionDigits: (+n % 1 ? 2 : 0), maximumFractionDigits: 2 });
  let cfg = null, st = { from: null, to: null, vehicle: null, asap: false, when: '', quote: null, startedAt: Date.now() };

  root.innerHTML = '<style>' + CSS + '</style><div class="q" part="card"><p class="sub">Loading the quote form…</p></div>';
  const box = root.querySelector('.q');
  const $ = s => box.querySelector(s);

  const start = c => { cfg = c; st.vehicle = (cfg.vehicles[0] || {}).id; box.style.setProperty('--c', cfg.colour || '#0B5FFF'); step1(); };
  api.config().then(start).catch(e => {
    if (FALLBACK && !OFFLINE) { OFFLINE = true; return api.config().then(start); }
    box.innerHTML = '<p class="err">' + esc(e.message) + '</p>';
  });

  /* first collection time that is inside working hours, so the first price has no out-of-hours extra */
  function nextSlot() {
    const h = cfg.hours || { start: 8, end: 18, days: [1, 2, 3, 4, 5] }, days = h.days && h.days.length ? h.days : [1, 2, 3, 4, 5];
    const d = new Date(Date.now() + ((cfg.minNoticeMins || 60) + 30) * 60e3); d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
    for (let i = 0; i < 14 && (days.indexOf(d.getDay()) < 0 || d.getHours() < h.start || d.getHours() >= h.end); i++) {
      if (days.indexOf(d.getDay()) >= 0 && d.getHours() < h.start) d.setHours(h.start, 0, 0, 0);
      else { d.setDate(d.getDate() + 1); d.setHours(h.start, 0, 0, 0); }
    }
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function step1() {
    st.when = st.when || nextSlot();
    box.innerHTML = `
      <h3>Get an instant price</h3>
      <p class="sub">${esc(cfg.name)}: same-day courier quote in seconds. No sign-up.</p>
      <label for="qf">Collect from</label>
      <div class="ac" id="acf"><input id="qf" autocomplete="off" placeholder="Postcode or address, e.g. RG1 2BH" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="lf"><span class="ok" aria-hidden="true">✓</span><ul id="lf" role="listbox" hidden></ul></div>
      <label for="qt">Deliver to</label>
      <div class="ac" id="act"><input id="qt" autocomplete="off" placeholder="Postcode or address" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="lt"><span class="ok" aria-hidden="true">✓</span><ul id="lt" role="listbox" hidden></ul></div>
      <label id="vl">Van</label>
      <div class="vans" role="radiogroup" aria-labelledby="vl">${cfg.vehicles.map(v => `<label class="van${v.id === st.vehicle ? ' on' : ''}"><input type="radio" name="veh" value="${esc(v.id)}"${v.id === st.vehicle ? ' checked' : ''}><b>${esc(v.name)}</b><span>${esc(v.desc || '')}</span></label>`).join('')}</div>
      <label for="qw">Collection time</label>
      <input id="qw" type="datetime-local" value="${esc(st.when)}">
      <label class="chk"><input type="checkbox" id="qa"${st.asap ? ' checked' : ''}><span>As soon as possible${+cfg.urgentPct ? ' (urgent, +' + esc(cfg.urgentPct) + '%)' : ''}</span></label>
      <button class="btn" id="go">See my price</button>
      <p class="err" id="e1" role="alert" hidden></p>
      <div id="res" aria-live="polite"></div>
      ${by()}`;
    auto('f', 'from'); auto('t', 'to');
    if (st.from) { $('#qf').value = st.from.label; $('#acf').classList.add('set'); }
    if (st.to) { $('#qt').value = st.to.label; $('#act').classList.add('set'); }
    box.querySelectorAll('input[name=veh]').forEach(r => r.addEventListener('change', () => { st.vehicle = r.value; box.querySelectorAll('.van').forEach(l => l.classList.toggle('on', l.contains(r) && r.checked)); if (st.quote) price(); }));
    const qa = $('#qa'), qw = $('#qw');
    const sync = () => { qw.disabled = qa.checked; qw.style.opacity = qa.checked ? .5 : 1; };
    qa.addEventListener('change', () => { st.asap = qa.checked; sync(); if (st.quote) price(); }); sync();
    qw.addEventListener('change', () => { st.when = qw.value; if (st.quote) price(); });
    $('#go').addEventListener('click', price);
    if (st.quote) showQuote(st.quote);
  }

  /* address search with a list to pick from (arrow keys, Enter, Escape) */
  function auto(k, field) {
    const inp = $('#q' + k), list = $('#l' + k), wrap = $('#ac' + k);
    let items = [], idx = -1, timer = 0, seq = 0;
    const close = () => { list.hidden = true; inp.setAttribute('aria-expanded', 'false'); idx = -1; };
    const draw = () => {
      list.innerHTML = items.length ? items.map((p, i) => `<li role="option" id="o${k}${i}" aria-selected="${i === idx}">${esc(p.label)}</li>`).join('') : '<li class="none">No match. Try the postcode.</li>';
      list.hidden = false; inp.setAttribute('aria-expanded', 'true'); inp.setAttribute('aria-activedescendant', idx >= 0 ? 'o' + k + idx : '');
    };
    const pick = i => { const p = items[i]; if (!p) return; st[field] = p; inp.value = p.label; wrap.classList.add('set'); close(); st.quote = null; $('#res').innerHTML = ''; };
    inp.addEventListener('input', () => {
      st[field] = null; wrap.classList.remove('set'); clearTimeout(timer);
      const q = inp.value.trim(); if (q.length < 3) { close(); return; }
      timer = setTimeout(async () => { const my = ++seq; try { const r = await api.places(q); if (my !== seq) return; items = r || []; idx = items.length ? 0 : -1; draw(); } catch (e) { items = []; draw(); } }, 250);
    });
    inp.addEventListener('keydown', e => {
      if (list.hidden) return;
      if (e.key === 'ArrowDown') { idx = Math.min(items.length - 1, idx + 1); draw(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { idx = Math.max(0, idx - 1); draw(); e.preventDefault(); }
      else if (e.key === 'Enter') { if (idx >= 0) { pick(idx); e.preventDefault(); } }
      else if (e.key === 'Escape') close();
    });
    list.addEventListener('mousedown', e => { const li = e.target.closest('li[role=option]'); if (li) { e.preventDefault(); pick([].indexOf.call(list.children, li)); } });
    inp.addEventListener('blur', () => setTimeout(close, 150));
  }

  async function price() {
    const e1 = $('#e1'), go = $('#go'); e1.hidden = true;
    if (!st.from || !st.to) { e1.textContent = 'Please choose both addresses from the list.'; e1.hidden = false; return; }
    const w = $('#qw').value;
    if (!st.asap && !w) { e1.textContent = 'Please choose a collection time or tick "as soon as possible".'; e1.hidden = false; return; }
    go.disabled = true; go.textContent = 'Working out your price…';
    try {
      const q = await api.quote({ from: st.from, to: st.to, vehicle: st.vehicle, asap: st.asap, when: st.asap ? '' : new Date(w).toISOString() });
      st.quote = q; showQuote(q);
    } catch (err) { e1.textContent = err.message; e1.hidden = false; $('#res').innerHTML = ''; }
    finally { go.disabled = false; go.textContent = st.quote ? 'Update price' : 'See my price'; }
  }

  function vatNote(q) { return q.vatMode === 'add' ? '+ VAT ' + gbp(q.vat) + ' (' + gbp(q.total) + ' in total)' : q.vatMode === 'inc' ? 'Includes VAT' : 'No VAT to add'; }
  function showQuote(q) {
    const t = st.asap ? 'As soon as possible' : new Date($('#qw').value).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    $('#res').innerHTML = `<div class="res">
      <div class="price"><div><div class="big">${gbp(q.net)}</div><small>${esc(vatNote(q))}</small></div><small>${esc(q.vehicleName)} · ${esc(t)}</small></div>
      <div class="trip"><span class="dot"></span><span>${esc(st.from.label)}</span><span class="bar"></span><span class="meta">${Math.round(q.miles)} miles · about ${fmtMins(q.mins)}${q.exact ? '' : ' (approx.)'}</span><span class="dot b"></span><span>${esc(st.to.label)}</span></div>
      <details><summary>How we worked it out</summary><table>${q.lines.map(l => `<tr><td>${esc(l.label)}</td><td>${gbp(l.amount)}</td></tr>`).join('')}<tr><td><b>Price</b></td><td><b>${gbp(q.net)}</b></td></tr></table></details>
      ${OFFLINE ? '' : '<div class="map" id="map" hidden></div>'}
      <button class="btn" id="bk">Book this delivery</button></div>`;
    $('#bk').addEventListener('click', step2);
    if (!OFFLINE) drawMap(q.line);
  }
  const fmtMins = m => m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') + ' min';

  /* route map: Leaflet from cdnjs, loaded only when there is a route to show */
  let leaflet = null;
  function loadLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (leaflet) return leaflet;
    leaflet = new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'; s.onload = () => ok(window.L); s.onerror = no; document.head.appendChild(s); });
    return leaflet;
  }
  async function drawMap(line) {
    try {
      const L = await loadLeaflet(), el = $('#map'); if (!el || !line || line.length < 2) return;
      if (!root.querySelector('link[data-l]')) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'; l.setAttribute('data-l', '1'); root.insertBefore(l, root.firstChild); }
      el.hidden = false;
      const m = L.map(el, { zoomControl: false, attributionControl: true, scrollWheelZoom: false, dragging: !L.Browser.mobile });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(m);
      const pl = L.polyline(line, { color: cfg.colour || '#0B5FFF', weight: 4 }).addTo(m);
      L.circleMarker(line[0], { radius: 6, color: cfg.colour, fillColor: '#fff', fillOpacity: 1, weight: 3 }).addTo(m);
      L.circleMarker(line[line.length - 1], { radius: 6, color: cfg.colour, fillColor: cfg.colour, fillOpacity: 1, weight: 3 }).addTo(m);
      m.fitBounds(pl.getBounds(), { padding: [18, 18] });
    } catch (e) { const el = $('#map'); if (el) el.hidden = true; }
  }

  function step2() {
    const q = st.quote; st.startedAt = Date.now();
    box.innerHTML = `
      <h3>Your details</h3>
      <p class="sub">${gbp(q.net)} · ${esc(q.vehicleName)} · ${esc(st.from.label.split(',')[0])} → ${esc(st.to.label.split(',')[0])}</p>
      <label for="cn">Your name</label><input id="cn" autocomplete="name" maxlength="100">
      <label for="cc">Company (optional)</label><input id="cc" autocomplete="organization" maxlength="100">
      <div class="row"><div><label for="cp">Phone</label><input id="cp" type="tel" autocomplete="tel" maxlength="30" placeholder="07123 456789"></div><div><label for="ce">Email</label><input id="ce" type="email" autocomplete="email" maxlength="200"></div></div>
      <label for="cg">What are we carrying?</label><input id="cg" maxlength="300" placeholder="e.g. 2 boxes, 40 kg">
      <label for="cx">Anything else (optional)</label><textarea id="cx" maxlength="600" placeholder="e.g. loading bay at the back, call 10 min before"></textarea>
      <div class="hp" aria-hidden="true"><label>Leave empty<input id="cw" tabindex="-1" autocomplete="off"></label></div>
      <label class="chk"><input type="checkbox" id="ck"><span>I agree that ${esc(cfg.name)} uses my details to arrange this delivery${cfg.terms ? ' and accept the <a href="' + esc(cfg.terms) + '" target="_blank" rel="noopener">terms</a>' : ''}${cfg.privacy ? ' (<a href="' + esc(cfg.privacy) + '" target="_blank" rel="noopener">privacy</a>)' : ''}.</span></label>
      <button class="btn" id="sb">Send booking request</button>
      <button class="btn ghost" id="bb" type="button">Back</button>
      <p class="err" id="e2" role="alert" hidden></p>
      ${by()}`;
    $('#bb').addEventListener('click', step1);
    $('#sb').addEventListener('click', send);
    $('#cn').focus();
  }

  async function send() {
    const e2 = $('#e2'), sb = $('#sb'), v = id => $(id).value.trim();
    e2.hidden = true;
    const c = { name: v('#cn'), company: v('#cc'), phone: v('#cp'), email: v('#ce') };
    const bad = c.name.length < 2 ? 'Please enter your name.' : c.phone.replace(/\D/g, '').length < 10 ? 'Please enter a phone number we can call.' : !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(c.email) ? 'Please enter a valid email address.' : !$('#ck').checked ? 'Please tick the box to agree.' : '';
    if (bad) { e2.textContent = bad; e2.hidden = false; return; }
    sb.disabled = true; sb.textContent = 'Sending…';
    try {
      const r = await api.book({ from: st.from, to: st.to, vehicle: st.vehicle, asap: st.asap, when: st.asap ? '' : new Date(st.when || $('#qw') && $('#qw').value).toISOString(), customer: c, goods: v('#cg'), notes: v('#cx'), consent: true, website: v('#cw'), startedAt: st.startedAt });
      done(r);
    } catch (err) { e2.textContent = err.message; e2.hidden = false; sb.disabled = false; sb.textContent = 'Send booking request'; }
  }

  function done(r) {
    box.innerHTML = `<div class="done"><div class="tick" aria-hidden="true">✓</div><h3>Request sent</h3><div class="ref">${esc(r.ref)}</div>
      <p class="sub">${esc(r.thanks || cfg.thanks)}${cfg.phone ? ' Need it sooner? Call <a href="tel:' + esc(cfg.phone.replace(/\s/g, '')) + '">' + esc(cfg.phone) + '</a>.' : ''}</p>
      <button class="btn ghost" id="again" type="button">Get another price</button></div>${by()}`;
    $('#again').addEventListener('click', () => { st = { from: null, to: null, vehicle: st.vehicle, asap: false, when: '', quote: null, startedAt: Date.now() }; step1(); });
    try { host.dispatchEvent(new CustomEvent('prjquote:booked', { bubbles: true, detail: { ref: r.ref, total: r.total } })); } catch (e) {}
  }

  function by() { return cfg.plan === 'pro' ? '' : '<div class="by">Instant quotes by <a href="https://www.prjlogistics.co.uk/instant-quote.html" target="_blank" rel="noopener">PRJ Instant Quote</a></div>'; }
})();

})();
