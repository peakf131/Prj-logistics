/* node test.mjs  — runs the worker with a fake KV and fake address/route/email services */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const W = (await import(pathToFileURL(path.resolve('dist/worker.js')).href + '?t=' + Date.now())).default;

let pass = 0, failN = 0;
const t = (name, ok) => { if (ok) pass++; else { failN++; console.log('FAIL', name); } };

function kv() {
  const m = new Map();
  return {
    m,
    async get(k) { const v = m.get(k); return v ? v.v : null; },
    async put(k, v, o) { m.set(k, { v, meta: o && o.metadata }); },
    async delete(k) { m.delete(k); },
    async list({ prefix, limit }) { return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).slice(0, limit || 1000).map(k => ({ name: k, metadata: m.get(k).meta })) }; }
  };
}
const calls = [];
globalThis.fetch = async (url, init) => {
  url = String(url); calls.push(url);
  const J = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { 'Content-Type': 'application/json' } });
  if (url.includes('api.postcodes.io/postcodes/RG12BH')) return J({ result: { postcode: 'RG1 2BH', admin_ward: 'Abbey', admin_district: 'Reading', latitude: 51.456, longitude: -0.973 } });
  if (url.includes('api.postcodes.io')) return J({ error: 'not found' }, 404);
  if (url.includes('photon.komoot.io')) return J({ features: [
    { properties: { countrycode: 'GB', housenumber: '1', street: 'Bath Road', city: 'Slough', postcode: 'SL1 4LA' }, geometry: { coordinates: [-0.629, 51.519] } },
    { properties: { countrycode: 'FR', name: 'Paris' }, geometry: { coordinates: [2.35, 48.85] } }] });
  if (url.includes('router.project-osrm.org')) return J({ routes: [{ distance: 32186.9, duration: 2400, geometry: { coordinates: [[-0.973, 51.456], [-0.8, 51.48], [-0.629, 51.519]] } }] });
  if (url.includes('api.resend.com')) return J({ id: 'x' });
  return J({}, 404);
};

const env = { QUOTE: kv(), ADMIN_KEY: 'admin-key-123456', TEST_OUTBOX: [] };
const ctx = { waitUntil: p => p };
const req = (p, o) => W.fetch(new Request('https://q.example' + p, Object.assign({ headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4', Origin: 'https://swift.example' } }, o || {})), env, ctx);
const post = (p, b, h) => req(p, { method: 'POST', body: JSON.stringify(b), headers: Object.assign({ 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4', Origin: 'https://swift.example' }, h || {}) });
const js = async r => ({ s: r.status, j: await r.json() });

// static files
let r = await req('/widget.js'); t('widget served', r.status === 200 && (await r.text()).includes('COSO'));
r = await req('/admin'); t('admin page served', r.status === 200 && (await r.text()).includes('Admin key'));
r = await req('/v1/config', { method: 'OPTIONS' }); t('CORS preflight', r.status === 204 && r.headers.get('Access-Control-Allow-Origin') === '*');

// demo company works with no setup
let x = await js(await req('/v1/config?t=demo')); t('demo config', x.j.ok && x.j.tenant.vehicles.length === 3 && !('email' in x.j.tenant));
x = await js(await req('/v1/config?t=nobody')); t('unknown company 404', x.s === 404);

// addresses
x = await js(await req('/v1/places?t=demo&q=RG1%202BH')); t('postcode lookup', x.j.places.length === 1 && x.j.places[0].postcode === 'RG1 2BH');
x = await js(await req('/v1/places?t=demo&q=bath%20road')); t('street search, GB only', x.j.places.length === 1 && /Slough/.test(x.j.places[0].label));
x = await js(await req('/v1/places?t=demo&q=ab')); t('short query empty', x.j.places.length === 0);

// quote: demo SWB, 20 miles (32186.9 m), weekday 10:00 UK
const A = { label: '14 Broad Street, Reading', lat: 51.456, lon: -0.973 }, B = { label: '1 Bath Road, Slough', lat: 51.519, lon: -0.629 };
const nextWeekday = h => { const d = new Date(Date.now() + 2 * 864e5); while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(h - (isBST(d) ? 1 : 0), 0, 0, 0); return d.toISOString(); };
function isBST(d) { const s = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'short' }).format(d); return /BST/.test(s); }
x = await js(await post('/v1/quote', { t: 'demo', from: A, to: B, vehicle: 'swb', when: nextWeekday(10) }));
t('quote ok', x.j.ok && Math.abs(x.j.miles - 20) < 0.01);
t('price = 35 + 1.30 x 20 = 61', x.j.net === 61 && x.j.total === 61 && x.j.vat === 0);
t('route line returned as lat,lon', x.j.line[0][0] === 51.456 && x.j.exact === true);
x = await js(await post('/v1/quote', { t: 'demo', from: A, to: B, vehicle: 'swb', asap: true })); t('ASAP +25% = 76', x.j.net === 76);
x = await js(await post('/v1/quote', { t: 'demo', from: A, to: B, vehicle: 'swb', when: nextWeekday(20) })); t('outside hours +25%', x.j.net === 76 && /Outside/.test(x.j.lines[1].label));
x = await js(await post('/v1/quote', { t: 'demo', from: A, to: B, vehicle: 'small', when: nextWeekday(10) })); t('minimum applies when higher', x.j.net === 52);  // 30+1.1*20=52 > 40
x = await js(await post('/v1/quote', { t: 'demo', from: A, to: { lat: 48.8, lon: 2.3 }, vehicle: 'swb', asap: true })); t('outside UK refused', !x.j.ok);
x = await js(await post('/v1/quote', { t: 'demo', from: A, to: B, vehicle: 'swb', when: new Date(Date.now() - 3600e3).toISOString() })); t('past time refused', !x.j.ok);

// booking
const cust = { name: 'Anna Smith', phone: '07123 456789', email: 'anna@example.com', company: 'Acme Ltd' };
x = await js(await post('/v1/book', { t: 'demo', from: A, to: B, vehicle: 'swb', asap: true, customer: cust, consent: false, startedAt: Date.now() - 10000 })); t('consent needed', !x.j.ok && /agree/.test(x.j.error));
x = await js(await post('/v1/book', { t: 'demo', from: A, to: B, vehicle: 'swb', asap: true, customer: cust, consent: true, startedAt: Date.now() })); t('too fast = robot', !x.j.ok);
x = await js(await post('/v1/book', { t: 'demo', from: A, to: B, vehicle: 'swb', asap: true, customer: cust, consent: true, website: 'spam', startedAt: Date.now() - 10000 })); t('honeypot pretends ok, stores nothing', x.j.ok && ![...env.QUOTE.m.keys()].some(k => k.startsWith('lead:')));
x = await js(await post('/v1/book', { t: 'demo', from: A, to: B, vehicle: 'swb', asap: true, customer: cust, goods: '2 boxes', consent: true, startedAt: Date.now() - 10000, net: 1 }));
t('booking ok with ref', x.j.ok && /^Q-[A-Z0-9]{6}$/.test(x.j.ref) && x.j.total === 76);
const leadKey = [...env.QUOTE.m.keys()].find(k => k.startsWith('lead:demo:'));
const lead = JSON.parse(env.QUOTE.m.get(leadKey).v);
t('server price used, not the browser\'s', lead.net === 76 && lead.customer.email === 'anna@example.com');
t('demo has no owner email: only the customer is emailed', env.TEST_OUTBOX.length === 1 && env.TEST_OUTBOX[0].to[0] === 'anna@example.com');

// admin
x = await js(await req('/admin/tenants', { headers: { Authorization: 'Bearer wrong-key-000000' } })); t('admin wrong key', x.s === 401);
const AH = { Authorization: 'Bearer admin-key-123456', 'Content-Type': 'application/json' };
x = await js(await req('/admin/tenants/swift', { method: 'PUT', headers: AH, body: JSON.stringify({ name: 'Swift Couriers', email: 'jobs@swift.example', colour: '#ff0000', domains: 'swift.example', vat: 'add', vehicles: [{ id: 'lwb', name: 'LWB', base: 50, perMile: 2, minimum: 0 }], terms: 'javascript:alert(1)' }) }));
t('company saved', x.j.ok && x.j.tenant.vat === 'add' && x.j.tenant.terms === '' && x.j.tenant.domains[0] === 'swift.example');
x = await js(await post('/v1/quote', { t: 'swift', from: A, to: B, vehicle: 'lwb', when: nextWeekday(10) })); t('company prices + VAT: 50+40=90, VAT 18', x.j.net === 90 && x.j.vat === 18 && x.j.total === 108);
x = await js(await post('/v1/quote', { t: 'swift', from: A, to: B, vehicle: 'lwb', when: nextWeekday(10) }, { Origin: 'https://evil.example' })); t('other website refused', x.s === 403);
env.TEST_OUTBOX.length = 0;
x = await js(await post('/v1/book', { t: 'swift', from: A, to: B, vehicle: 'lwb', asap: false, when: nextWeekday(10), customer: cust, consent: true, startedAt: Date.now() - 10000 }));
t('company booking emails owner and customer', x.j.ok && env.TEST_OUTBOX.length === 2 && env.TEST_OUTBOX[0].to[0] === 'jobs@swift.example' && env.TEST_OUTBOX[0].reply_to[0] === 'anna@example.com' && /£108\.00/.test(env.TEST_OUTBOX[0].subject));
t('customer email from company name', /^Swift Couriers </.test(env.TEST_OUTBOX[1].from) && /not a confirmed booking/.test(env.TEST_OUTBOX[1].text));
x = await js(await req('/admin/leads?t=swift', { headers: AH })); t('admin lists leads', x.j.leads.length === 1 && x.j.leads[0].total === 108);
x = await js(await req('/admin/lead?key=' + encodeURIComponent(x.j.leads[0].key), { headers: AH })); t('admin reads one lead', x.j.lead.customer.name === 'Anna Smith');
x = await js(await req('/admin/tenants/swift', { method: 'DELETE', headers: AH })); x = await js(await req('/v1/config?t=swift')); t('deleted company stops', x.s === 404);

// rate limit
let last; for (let i = 0; i < 62; i++) last = await post('/v1/quote', { t: 'demo', from: A, to: B, vehicle: 'swb', asap: true }, { 'CF-Connecting-IP': '9.9.9.9' });
t('quote rate limit', last.status === 429);

console.log(pass + ' passed, ' + failN + ' failed');
process.exit(failN ? 1 : 0);
