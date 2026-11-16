// Tests for the Cloudflare worker: a real SQLite database stands in for D1, web services are faked.
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
process.removeAllListeners('warning');

/* ---- D1 stand-in ---- */
function makeD1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) || null,
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
    _exec: () => /^\s*select/i.test(sql) ? { results: db.prepare(sql).all(...args) } : (db.prepare(sql).run(...args), { results: [] })
  });
  return { prepare: sql => stmt(sql), batch: async list => { db.exec('BEGIN'); try { const r = list.map(s => s._exec()); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }, _db: db };
}

/* ---- fake internet ---- */
const PC = { RG11AA: [51.4543, -0.9781, 'South East'], B11AA: [52.4808, -1.9026, 'West Midlands'], SW1A1AA: [51.501, -0.1416, 'London'], RG401AA: [51.4112, -0.8335, 'South East'] };
global.fetch = async (url, init) => {
  url = String(url);
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
  let m = /postcodes\.io\/postcodes\/([A-Z0-9%]+)/i.exec(url);
  if (m) { const k = decodeURIComponent(m[1]).replace(/\s/g, '').toUpperCase(); const p = PC[k]; return p ? json({ result: { latitude: p[0], longitude: p[1], region: p[2] } }) : json({ error: 'nf' }, 404); }
  if (/router\.project-osrm\.org/.test(url)) return json({ code: 'Ok', routes: [{ distance: 100 * 1609.344, duration: 110 * 60, geometry: { coordinates: [[-0.97, 51.45], [-1.9, 52.48]] } }] });
  if (/api\.tomtom\.com/.test(url)) return json({ routes: [{ summary: { lengthInMeters: 105 * 1609.344, travelTimeInSeconds: 120 * 60, trafficDelayInSeconds: 600 }, legs: [{ points: [{ latitude: 51.45, longitude: -0.97 }, { latitude: 52.48, longitude: -1.9 }] }] }] });
  if (/photon\.komoot\.io/.test(url)) return json({ features: [] });
  if (/api\.resend\.com|api\.telegram\.org/.test(url)) return json({ ok: true });
  return json({}, 404);
};

/* ---- password hash exactly as the Google Apps Script made it ---- */
const signed = b => Array.from(b, x => (x > 127 ? x - 256 : x));
function gasHash(salt, pw) {
  let h = signed(crypto.createHash('sha256').update(salt + ':' + pw).digest());
  for (let i = 0; i < 2000; i++) h = signed(crypto.createHash('sha256').update(Buffer.from(h.concat(signed(Buffer.from(salt))).map(b => b & 255))).digest());
  return h.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}
const gasSign = (text, secret) => crypto.createHmac('sha256', secret).update(text).digest('hex');

const worker = (await import(process.argv[2] || '/tmp/gal/worker.mjs')).default;
const outbox = [], telegram = [], waits = [];
const env = { TEST_PUSH: [], DB: makeD1(), SETUP_KEY: 'setup-123', TEST_OUTBOX: outbox, TEST_TELEGRAM: telegram };
const ctx = { waitUntil: p => waits.push(p) };
const BASE = 'https://prj-api.example.workers.dev';
async function post(d) { const r = await worker.fetch(new Request(BASE + '/', { method: 'POST', body: JSON.stringify(d), headers: { 'Content-Type': 'text/plain' } }), env, ctx); return r.json(); }
async function get(q) { const r = await worker.fetch(new Request(BASE + '/?' + new URLSearchParams(q)), env, ctx); return r.json(); }
let pass = 0, fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); c ? pass++ : fail++; };

/* ---- move data from "Google" ---- */
const SECRET = 'old-secret-' + 'x'.repeat(40);
const header = ['Reference', 'Status', 'Updated', 'Note', 'Customer email', 'Proof of delivery', 'Last emailed', 'Received by', 'Collect from', 'Deliver to', 'Driver', 'Customer name', 'Phone', 'Collection', 'Vehicle', 'Load', 'Miles', 'Estimate', 'Price'];
const old = {
  sheets: {
    Deliveries: [header,
      ['PRJ-261015-ABCDE', 'Delivered', { $d: '2026-10-15T10:00:00Z' }, '', 'old@example.com', 'https://drive.google.com/file/x', 'Delivered', 'J', 'RG1 1AA', 'B1 1AA', 'Pawel', 'Old Customer', '07123 456789', 'Thu, 15 Oct 2026 at 09:00', 'LWB van', 'Boxes', '100', '', '£180']],
    Reviews: [['Received', 'Name', 'Rating', 'Review', 'Status', 'ID', 'Town'], [{ $d: '2026-10-10T10:00:00Z' }, 'Ann Smith', 5, 'Great job, very quick', 'Approved', 'r1', 'Reading']]
  },
  props: { secret: SECRET, 'pw_prjlogistics.ltd@gmail.com': 'salt1:' + gasHash('salt1', 'Pawel-Pass-123'), 'pw_patryk.forgiel@gmail.com': 'salt2:' + gasHash('salt2', 'Patryk-Pass-456'), tg_token: 'TGTOKEN', tg_chats: '111,222' }
};
t('import refused with wrong setup key', !(await post({ action: 'migrate_import', setupKey: 'nope', data: old })).ok);
let r = await post({ action: 'migrate_import', setupKey: 'setup-123', data: old });
t('import works', r.ok && r.rows === 4 && r.settings === 5);
t('import refused twice without replace', !(await post({ action: 'migrate_import', setupKey: 'setup-123', data: old })).ok);

/* ---- accounts: old passwords and old phone logins keep working ---- */
t('Pawel can log in with prj.logisticsltd@gmail.com too', (await post({ action: 'login', username: 'Prj.LogisticsLtd@gmail.com', password: 'Pawel-Pass-123' })).name === 'Pawel');
r = await post({ action: 'login', username: 'prjlogistics.ltd@gmail.com', password: 'Pawel-Pass-123' });
t('old password works after the move', r.ok && r.name === 'Pawel');
const TK = r.token;
const oldExp = Date.now() + 86400000, oldBody = 'patryk.forgiel@gmail.com.' + oldExp + '.1';
const OLDTOKEN = oldBody + '.' + gasSign(oldBody, SECRET);
t('a phone logged in on Google stays logged in', (await post({ action: 'jobs', key: OLDTOKEN })).driver === 'Patryk');
t('wrong password refused', !(await post({ action: 'login', username: 'prjlogistics.ltd@gmail.com', password: 'bad' })).ok);
t('forged token refused', !(await post({ action: 'admin_list', key: TK.slice(0, -2) + '00' })).ok);

/* ---- admin list shows imported job and review ---- */
r = await post({ action: 'admin_list', key: TK });
t('admin list has the imported job', r.ok && r.jobs.some(j => j.ref === 'PRJ-261015-ABCDE' && j.status === 'Delivered'));
t('admin list has reviews', r.reviews && r.reviews.length === 1);
t('public reviews list', (await post({ action: 'reviews_list' })).count === 1);

/* ---- a customer asks for a quote on the website ---- */
const REF = 'PRJ-261022-QWERT';
r = await post({ action: 'quote', ref: REF, name: 'Bob Brown', email: 'bob@example.com', phone: '07123 456789', from: '1 High St, Reading RG1 1AA', to: '5 New St, Birmingham B1 1AA', when: 'Tue, 27 Oct 2099 at 09:00', van: 'LWB van', load: 'Boxes', miles: '100' });
t('quote request saved', r.ok);
t('owner and customer emails queued', outbox.some(m => m.to[0] === 'contact@prjlogistics.co.uk' && /New quote request/.test(m.subject)) && outbox.some(m => m.to[0] === 'bob@example.com'));
t('customer email has the brand footer with logo', outbox.some(m => m.to[0] === 'bob@example.com' && /cid:prjlogo/.test(m.html) && (m.attachments || []).some(a => a.content_id === 'prjlogo')));
t('telegram notification to both phones', telegram.filter(x => /New quote request/.test(x.text)).length === 2);
t('no estimate when the customer type is not private', r.ok && !r.estimate);
{ const ob = outbox.length;
  let q = await post({ action: 'quote', ref: 'PRJ-261029-ESTAA', ctype: 'Private', name: 'Ella Est', email: 'ella@example.com', phone: '07123 456782', from: '1 High St, Reading RG1 1AA', to: '5 New St, Birmingham B1 1AA', when: 'Tue, 27 Oct 2099 at 09:00', van: 'Not specified', load: 'Boxes', miles: '100' });
  const ack = outbox.slice(ob).find(m => m.to[0] === 'ella@example.com'), own = outbox.slice(ob).find(m => m.to[0] === 'contact@prjlogistics.co.uk');
  t('private customer sees an estimated price', q.ok && /^£\d+/.test(q.estimate));
  t('estimate in the customer email and the office email', ack && new RegExp('Estimated price: ' + q.estimate.replace('£', '\u00a3')).test(ack.html) && own && /Estimated price shown to the customer/.test(own.text));
  q = await post({ action: 'quote', ref: 'PRJ-261029-ESTBB', ctype: 'Business', company: 'Biz Ltd', name: 'Bo Biz', email: 'bo@example.com', phone: '07123 456783', from: '1 High St, Reading RG1 1AA', to: '5 New St, Birmingham B1 1AA', when: 'Tue, 27 Oct 2099 at 09:00', van: 'Not specified', load: 'Boxes', miles: '100' });
  t('business customer: no estimate on the website', q.ok && !q.estimate);
  await post({ action: 'admin_settings', key: TK, priceOnWeb: false });
  q = await post({ action: 'quote', ref: 'PRJ-261029-ESTCC', ctype: 'Private', name: 'Off Est', email: 'off@example.com', phone: '07123 456784', from: '1 High St, Reading RG1 1AA', to: '5 New St, Birmingham B1 1AA', when: 'Tue, 27 Oct 2099 at 09:00', van: 'Not specified', load: 'Boxes', miles: '100' });
  t('estimate can be switched off in Settings', q.ok && !q.estimate);
  { let m = await post({ action: 'admin_settings', key: TK, minPrivate: '60', minBusiness: '' });
    t('separate minimum charges saved', m.ok && m.settings.minPrivate === 60 && m.settings.minBusiness === 0);
    const tiny = { action: 'admin_suggest', key: TK, from: '1 High St, Reading RG1 1AA', to: '5 New St, Birmingham B1 1AA' };
    let sp = await post(Object.assign({ kind: 'private' }, tiny)), sb = await post(Object.assign({ kind: 'business' }, tiny));
    m = await post({ action: 'admin_settings', key: TK, minPrivate: '500', minBusiness: '400' });
    sp = await post(Object.assign({ kind: 'private' }, tiny)); sb = await post(Object.assign({ kind: 'business' }, tiny));
    t('private minimum used for private, business minimum for business', sp.price === 500 && sb.price === 400 && /Minimum charge £500/.test(sp.why) && /Minimum charge £400/.test(sb.why));
    t('bad minimum refused', !(await post({ action: 'admin_settings', key: TK, minPrivate: 'abc' })).ok);
    await post({ action: 'admin_settings', key: TK, minPrivate: '', minBusiness: '' }); }
  await post({ action: 'admin_settings', key: TK, priceOnWeb: true });
  for (const rf of ['PRJ-261029-ESTAA', 'PRJ-261029-ESTBB', 'PRJ-261029-ESTCC']) await post({ action: 'admin_update', key: TK, ref: rf, status: 'Cancelled' }); }

/* ---- price suggestion with routing ---- */
r = await post({ action: 'admin_suggest', key: TK, ref: REF });
t('price suggestion (100 mi x £2 = £200, private)', r.ok && r.price === 200 && r.route && r.route.path.length === 2);
env.TOMTOM_KEY = 'tt';
r = await post({ action: 'admin_suggest', key: TK, ref: REF });
t('TomTom key from Cloudflare settings is used (105 mi = £210)', r.ok && r.price === 210 && r.traffic === true && r.route.customer.miles === 100);

/* ---- send the quote, customer accepts ---- */
r = await post({ action: 'admin_update', key: TK, ref: REF, price: '£189', sendQuote: true });
t('quote emailed', r.ok && r.mail === 'quote-sent' && outbox.some(m => /quote/i.test(m.subject) && m.to[0] === 'bob@example.com'));
const qmail = outbox.filter(m => m.to[0] === 'bob@example.com').pop();
const tok = (/[?&]t=([0-9a-f]{32})/.exec(qmail.html) || [])[1];
t('quote link has a token', !!tok);
r = await get({ view: 'quote', ref: REF, t: tok });
t('quote page loads', r.found && r.price === '£189');
r = await post({ action: 'quote_answer', ref: REF, t: tok, answer: 'accept', comment: 'thanks' });
t('customer accepts', r.ok && r.answer === 'Accepted');

/* ---- confirm booking: busy time worked out, booked email ---- */
r = await post({ action: 'admin_update', key: TK, ref: REF, price: '£189', status: 'Booked' });
t('booking confirmed and emailed', r.ok && r.mail === 'sent');
const row = env.DB._db.prepare("SELECT data FROM rows WHERE sheet='Deliveries' AND data LIKE ?").get('%' + REF + '%');
const vals = JSON.parse(row.data);
t('busy minutes saved (120 + 120 + 30)', vals[39] === 270);
r = await post({ action: 'busy', date: '2099-10-27' });
t('one van busy: nothing blocked', r.ok && r.blocked.length === 0);

/* ---- driver: on my way, arrived, collected with photo ---- */
r = await post({ action: 'onway', key: OLDTOKEN, ref: REF });
t('on my way (Patryk)', r.ok && !!r.onway && outbox.some(m => /on the way/i.test(m.subject)));
r = await post({ action: 'arrived', key: OLDTOKEN, ref: REF });
t('arrived at collection', r.ok && r.where === 'collection');
const jpeg = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg-bytes').toString('base64');
r = await post({ action: 'problem', key: OLDTOKEN, ref: REF, kind: 'damage', note: 'Box corner crushed before loading', photos: [jpeg], id: 'pr1' });
t('problem report with photo saved', r.ok && r.photos === 1 && telegram.some(x => /PROBLEM: Damage noticed/.test(x.text)));
r = await post({ action: 'admin_list', key: TK });
{ const pj = r.jobs.find(j => j.ref === REF); if (process.env.DBG) console.log(r.ok, r.message, JSON.stringify(pj && pj.problems)); t('admin sees the problem and its photo link', pj && pj.problems.length === 1 && pj.problems[0].photos[0].startsWith(BASE + '/photo/')); }
r = await post({ action: 'pod', key: OLDTOKEN, ref: REF, status: 'Collected', photos: [jpeg], id: 'up1' });
t('collection photo saved and emailed', r.ok && r.emailed);
const cm = outbox.filter(m => /collected/i.test(m.subject)).pop();
t('collection email has the photo attached', cm && cm.attachments.some(a => /Collected/.test(a.filename) && Buffer.from(a.content, 'base64').toString() === 'fake-jpeg-bytes'));
t('problem photo is not sent as proof of collection', cm && !cm.attachments.some(a => /Problem/.test(a.filename)));
r = await post({ action: 'pod', key: OLDTOKEN, ref: REF, status: 'Collected', photos: [jpeg], id: 'up1' });
t('same upload sent twice is ignored', r.ok && /Already/.test(r.message));
const sigJpeg = 'data:image/jpeg;base64,' + (await import('node:fs')).readFileSync('/home/claude/sig.jpg').toString('base64');
r = await post({ action: 'pod', key: OLDTOKEN, ref: REF, status: 'Delivered', photos: [jpeg], receivedBy: 'Jo', remarks: 'All fine', signature: sigJpeg, id: 'up2' });
t('delivery photo saved', r.ok);
{ const dm = outbox.filter(m => /delivered/i.test(m.subject)).pop();
  t('signed POD PDF attached to the delivered email', dm && dm.attachments.some(a => /POD-signed\.pdf$/.test(a.filename) && Buffer.from(a.content, 'base64').slice(0, 8).toString() === '%PDF-1.4'));
  t('delivered email: POD PDF and the delivery photos attached', dm && dm.attachments.some(a => /\.jpe?g$/i.test(a.filename) && /Delivered/.test(a.filename)) && /Photos taken at delivery are attached/.test(dm.html));
  const al = await post({ action: 'admin_list', key: TK }), j = al.jobs.find(x => x.ref === REF);
  t('admin has the signed POD link', j && j.podPdf.startsWith(BASE + '/photo/') && j.remarks === 'All fine');
  const pr2 = await worker.fetch(new Request(j.podPdf), env, ctx);
  t('signed POD link opens the PDF', pr2.status === 200 && pr2.headers.get('Content-Type') === 'application/pdf'); }
r = await get({ ref: REF });
t('tracking shows delivered with a photo link on the new server', r.found && r.status === 'Delivered' && r.pod.startsWith(BASE + '/photo/'));
const pr = await worker.fetch(new Request(r.pod), env, ctx);
t('photo link opens the photo', pr.status === 200 && pr.headers.get('Content-Type') === 'image/jpeg' && Buffer.from(await pr.arrayBuffer()).toString() === 'fake-jpeg-bytes');

/* ---- contact form, reviews, client accounts ---- */
r = await post({ name: 'Eve', email: 'eve@example.com', message: 'Hello', phone: '' });
t('contact form saved and emailed', r.ok && outbox.some(m => /Website message from Eve/.test(m.subject)));
r = await post({ action: 'review_submit', name: 'Tom Jones', town: 'Wokingham', rating: 4, text: 'Very reliable and polite' });
t('review submitted', r.ok);
r = await post({ action: 'admin_reviews', key: TK });
const pend = r.reviews.find(v => v.status === 'Pending');
t('admin sees pending review', !!pend);
await post({ action: 'admin_review_set', key: TK, id: pend.id, status: 'Approved' });
t('approved review is public', (await post({ action: 'reviews_list' })).count === 2);
r = await post({ action: 'admin_client_save', key: TK, email: 'firm@example.com', name: 'Firm Ltd buyer', company: 'Firm Ltd', phone: '07123 456789', password: 'Client-Pass-789' });
t('admin creates a client', r.ok && r.created);
r = await post({ action: 'client_login', email: 'firm@example.com', password: 'Client-Pass-789' });
t('client logs in', r.ok);
r = await post({ action: 'client_book', key: r.token, from: '1 High St, Reading RG1 1AA', to: 'B1 1AA', load: '2 pallets', van: 'LWB van', when: 'Today' });
t('client books', r.ok && /^PRJ-/.test(r.ref));
{ // agreed per-mile rates: instant price and instant booking
  let q = await post({ action: 'client_login', email: 'firm@example.com', password: 'Client-Pass-789' }); const CK = q.token;
  t('rates: no agreed rate yet -> no instant price', (await post({ action: 'client_price', key: CK, from: '1 High St, Reading RG1 1AA', to: 'B1 1AA' })).instant === false);
  t('rates: bad rate refused', !(await post({ action: 'admin_client_save', key: TK, email: 'firm@example.com', name: 'Firm Ltd buyer', company: 'Firm Ltd', phone: '07123 456789', rateSwb: 'abc' })).ok);
  q = await post({ action: 'admin_client_save', key: TK, email: 'firm@example.com', name: 'Firm Ltd buyer', company: 'Firm Ltd', phone: '07123 456789', rate: '£1.80', minPrice: '45' });
  t('rates: saved', q.ok);
  const cl = (await post({ action: 'admin_clients', key: TK })).clients.find(x => x.email === 'firm@example.com');
  t('rates: admin sees them', cl && cl.rate === 1.8 && cl.minPrice === 45);
  const me = await post({ action: 'client_me', key: CK });
  t('rates: client sees agreed rate', me.agreed && me.agreed.rate === 1.8);
  q = await post({ action: 'client_price', key: CK, from: '1 High St, Reading RG1 1AA', to: 'B1 1AA' });
  t('rates: instant price 100 mi', q.instant && q.miles === 100 && q.text === '£180');
  q = await post({ action: 'client_price', key: CK, from: '1 High St, Reading RG1 1AA', to: 'London SW1A 1AA' });
  t('rates: London goes to normal quote', q.ok && q.instant === false && q.reason === 'london');
  q = await post({ action: 'admin_client_save', key: TK, email: 'firm@example.com', name: 'Firm Ltd buyer', company: 'Firm Ltd', phone: '07123 456789', rate: '0.20', minPrice: '45' });
  t('rates: minimum applies', (await post({ action: 'client_price', key: CK, from: '1 High St, Reading RG1 1AA', to: 'B1 1AA' })).text === '£45');
  await post({ action: 'admin_client_save', key: TK, email: 'firm@example.com', name: 'Firm Ltd buyer', company: 'Firm Ltd', phone: '07123 456789', rate: '1.80', minPrice: '45' });
  q = await post({ action: 'client_book', key: CK, instant: true, from: '1 High St, Reading RG1 1AA', to: 'B1 1AA', load: '1 pallet', van: 'Not sure, you choose', when: 'Today', expect: '£99' });
  t('rates: wrong price refused', !q.ok && q.priceChanged && q.price === '£180');
  q = await post({ action: 'client_book', key: CK, instant: true, from: '1 High St, Reading RG1 1AA', to: 'B1 1AA', load: '1 pallet', van: 'LWB van', when: 'Today', expect: '£180' });
  t('rates: instant booking', q.ok && q.booked && q.price === '£180');
  const L = await post({ action: 'admin_list', key: TK });
  const jb = L.jobs.find(j => j.ref === q.ref);
  t('rates: job accepted with price', jb && jb.price === '£180' && jb.answer === 'Accepted');
  t('rates: client got booking email', env.TEST_OUTBOX.some(m => /Booked at £180/.test(m.subject || '')));
  q = await post({ action: 'admin_client_save', key: TK, email: 'firm@example.com', name: 'Firm Ltd buyer', company: 'Firm Ltd', phone: '07123 456789', rate: '', minPrice: '' });
  t('rates: removed', q.ok && (await post({ action: 'client_price', key: CK, from: '1 High St, Reading RG1 1AA', to: 'B1 1AA' })).instant === false);
}
{ // demo account: looks real in the client panel, but nothing is saved or emailed
  let q = await post({ action: 'admin_client_save', key: TK, email: 'demo@prjlogistics.co.uk', name: 'Demo Client', company: 'Demo Company Ltd', phone: '', password: 'Demo-Pass-2026', rate: '1.80', minPrice: '45', demo: true });
  t('demo: account created', q.ok);
  t('demo: admin sees demo flag', (await post({ action: 'admin_clients', key: TK })).clients.find(x => x.email === 'demo@prjlogistics.co.uk').demo === true);
  const DK = (await post({ action: 'client_login', email: 'demo@prjlogistics.co.uk', password: 'Demo-Pass-2026' })).token;
  t('demo: client panel knows it is a demo', (await post({ action: 'client_me', key: DK })).demo === true);
  const before = (await post({ action: 'admin_list', key: TK })).jobs.length, mails = env.TEST_OUTBOX.length, tg = env.TEST_TELEGRAM.length;
  q = await post({ action: 'client_book', key: DK, instant: true, from: '1 High St, Reading RG1 1AA', to: 'B1 1AA', load: '1 pallet', van: 'LWB van', when: 'Today', expect: '£180' });
  t('demo: instant booking shows as booked', q.ok && q.booked && q.demo && q.price === '£180' && /^DEMO-/.test(q.ref));
  q = await post({ action: 'client_book', key: DK, from: '1 High St, Reading RG1 1AA', to: 'B1 1AA', load: 'Boxes', van: 'Not sure, you choose', when: 'Today' });
  t('demo: normal request also works', q.ok && q.demo && !q.booked);
  await Promise.all(waits);
  t('demo: no job saved', (await post({ action: 'admin_list', key: TK })).jobs.length === before);
  t('demo: client gets [DEMO] emails only', env.TEST_OUTBOX.length === mails + 2 && env.TEST_OUTBOX.slice(mails).every(m => /^\[DEMO\]/.test(m.subject || '') && /demo@prjlogistics/.test(JSON.stringify(m.to))));
  t('demo: phones get a DEMO notice', env.TEST_TELEGRAM.slice(tg).some(m => /DEMO/.test(m.text)));
  const DL = await post({ action: 'client_demo_login' });
  t('demo: QR link logs into the demo account', DL.ok && (await post({ action: 'client_me', key: DL.token })).demo === true);
  q = await post({ action: 'admin_client_save', key: TK, email: 'demo@prjlogistics.co.uk', name: 'Demo Client', company: 'Demo Company Ltd', phone: '', demo: false });
  t('demo: QR link stops when no demo account', !(await post({ action: 'client_demo_login' })).ok);
  t('demo: flag can be removed', q.ok && !(await post({ action: 'admin_clients', key: TK })).clients.find(x => x.email === 'demo@prjlogistics.co.uk').demo);
}

/* ---- several requests at the same time do not lose data ---- */
const many = await Promise.all([1, 2, 3, 4, 5].map(i => post({ action: 'review_submit', name: 'P' + i, town: 'X', rating: 5, text: 'Parallel review number ' + i })));
r = await post({ action: 'admin_reviews', key: TK });
t('5 parallel requests all saved', many.every(x => x.ok) && r.reviews.length === 7);


/* ---- more admin actions ---- */
{ const A = { action: 'admin_suggest', key: TK, from: '1 High St, Reading RG1 1AA', to: 'Unit 2, Birmingham B1 1AA' };
  let q = await post(A);
  t('private rate £2 per mile by default (105 mi)', q.ok && q.kind === 'private' && q.price === 210 && !/inimum/.test(q.why));
  q = await post(Object.assign({ kind: 'business' }, A));
  t('business rate £1.84 per mile (105 mi)', q.ok && q.kind === 'business' && q.price === 193);
  q = await post({ action: 'admin_settings', key: TK, ratePrivate: '2.10', rateBusiness: '1.90', rateLondon: '2.50', minCharge: '250' });
  t('prices saved in settings', q.ok && q.settings.ratePrivate === 2.1 && q.settings.rateBusiness === 1.9 && q.settings.rateLondon === 2.5 && q.settings.minCharge === 250);
  q = await post(A);
  t('minimum charge applies', q.ok && q.price === 250 && /Minimum charge £250/.test(q.why));
  await post({ action: 'admin_settings', key: TK, minCharge: '' });
  q = await post(Object.assign({ kind: 'business' }, A));
  t('suggestion uses the new business rate', q.ok && q.price === 200);
  q = await post({ action: 'admin_settings', key: TK, ratePrivate: 'abc' });
  t('bad rate refused', !q.ok);
  q = await post({ action: 'admin_settings', ratePrivate: '0.5' });
  t('prices need admin login', !q.ok);
  await post({ action: 'admin_settings', key: TK, ratePrivate: '2', rateBusiness: '1.84', rateLondon: '2.40', minCharge: '0' });
}
{ const ob = outbox.length;
  let q = await post({ action: 'admin_quick_quote', key: TK, email: 'Ask@Example.com', company: 'Ask Ltd', name: 'Sam <b>Smith</b>', from: 'RG1 1AA Reading', to: 'OX1 1AA Oxford', van: 'SWB van', load: '3 boxes', price: '£95', note: 'Price for a Saturday.' });
  t('quick quote sent', q.ok && q.mail === 'sent' && /^PRJ-/.test(q.ref) && q.price === '£95');
  const m = outbox[outbox.length - 1], QR = q.ref;
  t('quick quote email to the customer with the price', outbox.length === ob + 1 && m.to.join() === 'ask@example.com' && /£95/.test(m.subject) && /OX1 1AA Oxford/.test(m.html) && /Price for a Saturday/.test(m.html) && /By invoice, within 7 days/.test(m.html) && /Ask Ltd/.test(m.html) && !/<b>Smith/.test(m.html));
  const lk = /quote\.html\?ref=([^&"]+)&(?:amp;)?t=([a-f0-9]+)/.exec(m.html);
  t('quick quote email has the Accept button', !!lk && /Accept this price/.test(m.html));
  let j = (await post({ action: 'admin_list', key: TK })).jobs.find(x => x.ref === QR);
  t('quick quote saved as a quoted request (no collection time)', j && j.status === 'Requested' && j.quoteSent && j.price === '£95' && j.quotedPrice === '£95' && !j.when && !j.answer && j.email === 'ask@example.com' && /^Invoice/.test(j.payment) && j.ctype === 'Business' && j.company === 'Ask Ltd');
  const v = await get({ view: 'quote', ref: decodeURIComponent(lk[1]), t: lk[2] });
  t('customer can open the quote', v.found && v.price === '£95' && v.from === 'RG1 1AA Reading' && v.invoice === true && v.company === 'Ask Ltd');
  q = await post({ action: 'quote_answer', ref: decodeURIComponent(lk[1]), t: lk[2], answer: 'accept', comment: 'Friday 10am please' });
  j = (await post({ action: 'admin_list', key: TK })).jobs.find(x => x.ref === QR);
  t('customer accepts from the email', q.ok && j.answer === 'Accepted' && j.comment === 'Friday 10am please');
  { const ob = outbox.length;
    q = await post({ action: 'admin_update', key: TK, ref: QR, when: 'Fri, 30 Oct 2099 at 10:00', status: 'Booked', force: true });
    const bm = outbox.slice(ob).find(m => /booked/i.test(m.subject));
    { const ob3 = outbox.length;
      const bz = (await post({ action: 'admin_create', key: TK, name: 'Biz Web', email: 'biz@web.co.uk', from: 'RG1 1AA', to: 'OX1 1AA', when: 'Fri, 30 Oct 2099 at 12:00', price: '£80' })).ref;
      const rows = env.DB._db.prepare("SELECT id, data FROM rows WHERE sheet = 'Deliveries'").all(); const rw = rows.find(x => JSON.parse(x.data)[0] === bz); const dd = JSON.parse(rw.data); while (dd.length < 29) dd.push(''); dd[27] = 'Business'; dd[28] = 'Biz Web Ltd'; env.DB._db.prepare('UPDATE rows SET data = ? WHERE id = ?').run(JSON.stringify(dd), rw.id);
      await post({ action: 'admin_update', key: TK, ref: bz, status: 'Booked', force: true });
      const em = outbox.slice(ob3).find(m => /booked/i.test(m.subject) && m.to[0] === 'biz@web.co.uk');
      t('business without a payment choice: invoice text, no payment link text', em && /send you an invoice/.test(em.html) && !/secure payment link/.test(em.html));
      await post({ action: 'admin_update', key: TK, ref: bz, status: 'Cancelled' }); }
    { const ob4 = outbox.length;
      q = await post({ action: 'onway', key: TK, ref: QR });
      t('business customer: no "driver on the way" email', q.ok && !outbox.slice(ob4).some(m => m.to[0] === 'ask@example.com' && /on the way/i.test(m.subject))); }
    t('business booking email does not ask for extra details', q.ok && bm && !/We still need a few details/.test(bm.html) && /invoice/i.test(bm.html));
    q = await post({ action: 'admin_details_save', key: TK, ref: QR, type: 'Business', company: 'Ask Ltd', cName: 'Sam', cPhone: '07123 456789', cNotes: 'Side gate', dName: 'Jo', dPhone: '', dNotes: 'Goods in', signature: true });
    j = (await post({ action: 'admin_list', key: TK })).jobs.find(x => x.ref === QR);
    t('office types the delivery details', q.ok && j.details && j.details.cName === 'Sam' && j.details.cPhone === '07123 456789' && j.details.dNotes === 'Goods in' && j.details.signature === true && j.details.dName === 'Jo');
    q = await post({ action: 'admin_details_save', key: TK, ref: QR, cPhone: '123' });
    t('details: bad phone refused', !q.ok);
    t('details need admin login', !(await post({ action: 'admin_details_save', ref: QR, cName: 'X' })).ok);
    await post({ action: 'admin_update', key: TK, ref: QR, status: 'Requested', force: true });
  }
  { const obp = outbox.length;
    let qp = await post({ action: 'admin_quick_quote', key: TK, kind: 'private', email: 'priv@example.com', name: 'Pat Private', from: '1 High St, Reading RG1 1AA', to: 'OX1 1AA Oxford', price: '£120' });
    const pm = outbox[outbox.length - 1], pj = (await post({ action: 'admin_list', key: TK })).jobs.find(x => x.ref === qp.ref);
    t('quick quote for a private customer (no company needed)', qp.ok && outbox.length === obp + 1 && /By card before collection/.test(pm.html) && !/By invoice/.test(pm.html) && pj.ctype === 'Private' && !pj.payment);
    const lkp = /quote\.html\?ref=([^&"]+)&(?:amp;)?t=([a-f0-9]+)/.exec(pm.html), vp = await get({ view: 'quote', ref: decodeURIComponent(lkp[1]), t: lkp[2] });
    t('private quote page: card payment wording', vp.found && !vp.invoice && !vp.company);
    await post({ action: 'admin_update', key: TK, ref: qp.ref, status: 'Cancelled' }); }
  t('company not saved unless ticked', (await post({ action: 'admin_companies', key: TK })).companies.length === 0);
  q = await post({ action: 'admin_quick_quote', key: TK, saveCompany: true, email: 'Buy@Shop.co.uk', company: 'Shop Ltd', name: 'Tom', from: '2 Shop St, Reading RG1 1AA', to: 'OX1 1AA', price: '60' });
  let C = (await post({ action: 'admin_companies', key: TK })).companies;
  t('company saved for next quotes', q.ok && C.length === 1 && C[0].email === 'buy@shop.co.uk' && C[0].company === 'Shop Ltd' && C[0].name === 'Tom' && C[0].from === '2 Shop St, Reading RG1 1AA');
  await post({ action: 'admin_quick_quote', key: TK, saveCompany: true, email: 'buy@shop.co.uk', company: 'Shop Ltd', name: 'Tina', from: '3 Shop St, Reading RG1 1AA', to: 'OX1 1AA', price: '60' });
  C = (await post({ action: 'admin_companies', key: TK })).companies;
  t('saved company updated, not doubled', C.length === 1 && C[0].name === 'Tina');
  t('saved companies need admin login', !(await post({ action: 'admin_companies' })).ok);
  q = await post({ action: 'admin_company_forget', key: TK, email: 'buy@shop.co.uk' });
  t('company can be forgotten', q.ok && (await post({ action: 'admin_companies', key: TK })).companies.length === 0);
  for (const jj of (await post({ action: 'admin_list', key: TK })).jobs.filter(x => x.email === 'buy@shop.co.uk')) await post({ action: 'admin_update', key: TK, ref: jj.ref, status: 'Cancelled' });
  q = await post({ action: 'admin_quick_quote', key: TK, email: 'nocomp@example.com', from: 'A', to: 'B', price: '50' });
  t('quick quote needs a company', !q.ok && /company/i.test(q.message));
  q = await post({ action: 'admin_quick_quote', key: TK, email: 'bad', company: 'X', from: 'A', to: 'B', price: '50' });
  t('quick quote needs a valid email', !q.ok);
  q = await post({ action: 'admin_quick_quote', key: TK, email: 'a@b.co', from: 'A', to: 'B', price: '' });
  t('quick quote needs a price', !q.ok);
  const n0 = outbox.length;
  q = await post({ action: 'admin_quick_quote', email: 'a@b.co', from: 'A', to: 'B', price: '50' });
  t('quick quote needs admin login', !q.ok && outbox.length === n0);
  q = await post({ action: 'admin_update', key: TK, ref: QR, from: '5 New Rd, Reading RG1 1AA', to: 'OX1 1AA Oxford', when: 'Fri, 30 Oct 2099 at 10:00', van: 'LWB van', load: '4 boxes' });
  j = (await post({ action: 'admin_list', key: TK })).jobs.find(x => x.ref === QR);
  t('admin can change address, time, vehicle and load', q.ok && j.from === '5 New Rd, Reading RG1 1AA' && j.to === 'OX1 1AA Oxford' && j.when === 'Fri, 30 Oct 2099 at 10:00' && j.van === 'LWB van' && j.load === '4 boxes' && j.price === '£95');
  q = await post({ action: 'admin_update', key: TK, ref: QR, to: '  ' });
  j = (await post({ action: 'admin_list', key: TK })).jobs.find(x => x.ref === QR);
  t('an address cannot be emptied', !q.ok && j.to === 'OX1 1AA Oxford');
  q = await post({ action: 'admin_update', ref: QR, from: 'Hacked' });
  t('changing details needs admin login', !q.ok);
  await post({ action: 'admin_update', key: TK, ref: QR, status: 'Cancelled' });
}
r = await post({ action: 'admin_create', key: TK, name: 'Phone Customer', email: 'phone@example.com', phone: '07123 456789', from: 'RG1 1AA', to: 'SW1A 1AA', when: 'Wed, 28 Oct 2099 at 10:00', van: 'SWB van', load: 'Box', price: '£88', confirm: true });
t('phone booking created and confirmed', r.ok && /^PRJ-/.test(r.ref) && r.mail === 'sent');
const PREF = r.ref;
const bm = outbox.filter(m => m.to[0] === 'phone@example.com').pop();
const dtok = (/details=1&(?:amp;)?ref=[^&"]+&(?:amp;)?t=([0-9a-f]{32})/.exec(bm.html) || [])[1];
t('booked email has the details link', !!dtok);
t('booked email shows time and addresses, says hello', /Hello Phone,/.test(bm.html) && /Wed, 28 Oct 2099 at 10:00/.test(bm.html) && /Collect from/.test(bm.html) && /SW1A 1AA/.test(bm.html));
r = await get({ view: 'details', ref: PREF, t: dtok });
t('details form loads', r.found === true);
r = await post({ action: 'details', ref: PREF, t: dtok, type: 'Business', company: 'ACME', invEmail: 'acc@acme.co.uk', invAddress: '1 Road', cName: 'Al', cPhone: '07123 456789', cNotes: 'gate', dName: 'Di', dPhone: '07123 456780', dNotes: '', signature: true });
t('details saved', r.ok);
r = await post({ action: 'admin_list', key: TK });
const pj = r.jobs.find(j => j.ref === PREF);
t('admin sees the details', pj && pj.details && pj.details.company === 'ACME' && pj.details.signature === true);
r = await post({ action: 'admin_update', key: TK, ref: PREF, price: '£88', payment: 'Unpaid', paymentLink: 'https://buy.stripe.com/test', sendPayment: true });
t('payment link emailed', r.ok && r.mail === 'payment-sent' && outbox.some(m => /Payment/.test(m.subject) && m.to[0] === 'phone@example.com'));
r = await post({ action: 'admin_update', key: TK, ref: PREF, payment: 'Paid' });
t('marked paid', r.ok);
r = await post({ action: 'admin_update', key: TK, ref: PREF, status: 'Cancelled' });
t('cancelled', r.ok);
r = await post({ action: 'admin_delete_job', key: TK, ref: PREF });
t('cancelled job deleted', r.ok && !(await post({ action: 'admin_list', key: TK })).jobs.some(j => j.ref === PREF));
r = await post({ action: 'admin_delete_job', key: TK, ref: REF });
t('live job cannot be deleted', !r.ok);
/* ---- problem report email ---- */
t('problem report emailed to the office', outbox.some(m => m.to[0] === 'contact@prjlogistics.co.uk' && /PROBLEM: Damage noticed/.test(m.subject)));

/* ---- customer data: find, export, erase ---- */
r = await post({ action: 'admin_customer', key: TK, q: 'bob@example.com' });
t('customer data found by email', r.ok && r.jobs.some(j => j.ref === REF && j.keep === true && j.all && j.all['Reference'] === REF));
r = await post({ action: 'admin_customer', key: TK, q: '07123 456789' });
t('customer data found by phone', r.ok && r.jobs.some(j => j.ref === REF));
r = await post({ action: 'admin_customer', key: TK, q: 'eve@example.com' });
t('website message found', r.ok && r.messages.length === 1 && r.messages[0].message === 'Hello');
t('customer lookup needs login', !(await post({ action: 'admin_customer', key: 'bad', q: 'bob@example.com' })).ok);
t('erase needs ERASE typed', !(await post({ action: 'admin_customer_erase', key: TK, q: 'eve@example.com', confirm: 'yes' })).ok);
// a quote that never became a job, for the same customer
const ins = (sheet, row) => env.DB._db.prepare('INSERT INTO rows (sheet, data) VALUES (?, ?)').run(sheet, JSON.stringify(row, function (k, v) { const raw = this[k]; return raw instanceof Date ? { $d: raw.toISOString() } : v; }));
ins('Deliveries', ['PRJ-261001-ZZZZZ', 'Requested', new Date(), '', 'bob@example.com', '', '', '', '1 High St, Reading RG1 1AA', '5 New St, Birmingham B1 1AA', '', 'Bob Brown', '07123 456789']);
r = await post({ action: 'admin_customer_erase', key: TK, q: 'bob@example.com', confirm: 'ERASE' });
t('erase: quote deleted, finished job kept for the accounts', r.ok && r.deleted === 1 && r.trimmed === 1 && r.photos >= 1);
r = await post({ action: 'admin_customer', key: TK, q: 'bob@example.com' });
t('erased customer no longer found by email', r.ok && r.jobs.length === 0);
r = await post({ action: 'admin_list', key: TK });
{ const j = r.jobs.find(x => x.ref === REF);
  t('kept job has name and postcodes only', j && j.name === 'Bob Brown' && !j.email && !j.phone && j.from === 'RG1 1AA' && j.to === 'B1 1AA'); }
t('erased photos are gone', env.DB._db.prepare("SELECT COUNT(*) AS n FROM photos WHERE ref = ?").get(REF).n === 0);
r = await post({ action: 'admin_customer_erase', key: TK, q: 'eve@example.com', confirm: 'ERASE' });
t('erase: website message deleted', r.ok && r.messages === 1);

/* ---- nightly clean-up (Cloudflare Cron Trigger) ---- */
const ago = m => { const d = new Date(); d.setMonth(d.getMonth() - m); return d; };
ins('Deliveries', ['PRJ-250101-OLDRQ', 'Requested', ago(7), '', 'old@example.com', '', '', '', 'RG1 1AA', 'RG2 2BB', '', 'Old Quote', '07000 000001']);
ins('Deliveries', ['PRJ-250101-PAIDC', 'Cancelled', ago(7), '', 'paid@example.com', '', '', '', 'RG1 1AA', 'RG2 2BB', '', 'Paid Cancel', '07000 000002', '', '', '', '', '', '', '', '', '', '', '', '', '', 'Refunded']);
ins('Deliveries', ['PRJ-250101-DELIV', 'Delivered', ago(13), '', 'del@example.com', 'https://x/photo/1', '', 'Jo', 'RG1 1AA', 'RG2 2BB', '', 'Del Ivered', '07000 000003']);
ins('Deliveries', ['PRJ-180101-SIXYR', 'Delivered', ago(80), '', '', '', '', '', 'RG1 1AA', 'RG2 2BB', '', 'Very Old']);
ins('Deliveries', ['PRJ-261020-FRESH', 'Requested', new Date(), '', 'new@example.com', '', '', '', 'RG1 1AA', 'RG2 2BB', '', 'New Quote', '07000 000004']);
ins('Problems', [ago(25), 'PRJ-250101-DELIV', 'Pawel', 'Breakdown', 'old', '']);
ins('Problems', [ago(1), 'PRJ-250101-DELIV', 'Pawel', 'Running late', 'new', '']);
ins('Messages', [ago(13), 'Old Msg', 'om@example.com', '', 'hi']);
env.DB._db.prepare('INSERT INTO photos (id, part, ref, name, mime, size, created, data) VALUES (?, 0, ?, ?, ?, 1, ?, ?)').run('a'.repeat(32), 'PRJ-250101-DELIV', 'x.jpg', 'image/jpeg', ago(13).toISOString(), 'eA==');
env.DB._db.prepare('INSERT INTO photos (id, part, ref, name, mime, size, created, data) VALUES (?, 0, ?, ?, ?, 1, ?, ?)').run('b'.repeat(32), 'PRJ-261020-FRESH', 'y.jpg', 'image/jpeg', new Date().toISOString(), 'eA==');
if (process.env.DBG) console.log('BEFORE', env.DB._db.prepare("SELECT id, data FROM rows WHERE sheet = 'Problems'").all());
await worker.scheduled({}, env, ctx);
const refsLeft = env.DB._db.prepare("SELECT data FROM rows WHERE sheet = 'Deliveries'").all().map(x => JSON.parse(x.data)[0]);
t('nightly: old unbooked quote deleted', refsLeft.indexOf('PRJ-250101-OLDRQ') < 0);
t('nightly: refunded job kept for the accounts', refsLeft.indexOf('PRJ-250101-PAIDC') >= 0);
t('nightly: job older than 6 years deleted', refsLeft.indexOf('PRJ-180101-SIXYR') < 0);
t('nightly: fresh quote kept', refsLeft.indexOf('PRJ-261020-FRESH') >= 0);
{ const row = env.DB._db.prepare("SELECT data FROM rows WHERE sheet = 'Deliveries'").all().map(x => JSON.parse(x.data)).find(x => x[0] === 'PRJ-250101-DELIV');
  t('nightly: delivered job after 12 months keeps name, loses contact details', row && row[11] === 'Del Ivered' && row[4] === '' && row[5] === '' && row[7] === '' && row[12] === ''); }
if (process.env.DBG) console.log(env.DB._db.prepare("SELECT data FROM rows WHERE sheet = 'Problems'").all());t('nightly: old problem report deleted, recent kept', env.DB._db.prepare("SELECT COUNT(*) AS n FROM rows WHERE sheet = 'Problems'").get().n === 3 && env.DB._db.prepare("SELECT COUNT(*) AS n FROM rows WHERE sheet = 'Problems' AND data LIKE '%Breakdown%'").get().n === 0);
t('nightly: old website message deleted', env.DB._db.prepare("SELECT COUNT(*) AS n FROM rows WHERE sheet = 'Messages' AND data LIKE '%Old Msg%'").get().n === 0);
t('nightly: old photo deleted, new kept', !env.DB._db.prepare('SELECT id FROM photos WHERE id = ?').get('a'.repeat(32)) && !!env.DB._db.prepare('SELECT id FROM photos WHERE id = ?').get('b'.repeat(32)));

/* ---- delete any job with confirm ---- */
{ const L = (await post({ action: 'admin_list', key: TK })).jobs; const any = L.find(j => j.status !== 'Cancelled');
  if (any) {
    const before = env.DB._db.prepare('SELECT COUNT(*) AS n FROM photos').get().n;
    let q = await post({ action: 'admin_delete_job', key: TK, ref: any.ref });
    t('live job needs DELETE to confirm', !q.ok && /DELETE/.test(q.message));
    q = await post({ action: 'admin_delete_job', key: TK, ref: any.ref, confirm: 'DELETE' });
    const after = env.DB._db.prepare('SELECT COUNT(*) AS n FROM photos').get().n;
    if (process.env.DBG) console.log(any.ref, any.status, q, before, after);
    t('live job deleted with DELETE', q.ok && !(await post({ action: 'admin_list', key: TK })).jobs.some(j => j.ref === any.ref));
  } else t('a live job to delete exists', false);
}
/* ---- office tools: notes, settings, payment reminder, review request, invoices, push ---- */
{
  const M = new Date().toISOString().slice(0, 7), DAY = new Date().toISOString().slice(0, 10);
  let q = await post({ action: 'admin_create', key: TK, name: 'Ivy Invoice', email: 'ivy@example.com', phone: '07111 222333', from: 'RG1 1AA Reading', to: 'OX1 1AA Oxford', when: DAY + ' 10:00', van: 'LWB van', load: 'Pallet', price: '£120', confirm: true, force: true });
  const IREF = q.ref;
  t('office: job for invoice created', q.ok && /^PRJ-/.test(IREF));
  q = await post({ action: 'admin_update', key: TK, ref: IREF, payment: 'Invoice (7 days)' });
  q = await post({ action: 'admin_pay_remind', key: TK, ref: IREF });
  t('payment reminder sent', q.ok && outbox.some(m => /Payment reminder/.test(m.subject) && m.to[0] === 'ivy@example.com'));
  q = await post({ action: 'admin_review_ask', key: TK, ref: IREF });
  t('review request refused before delivery', !q.ok);
  q = await post({ action: 'admin_update', key: TK, ref: IREF, status: 'Delivered' });
  q = await post({ action: 'admin_review_ask', key: TK, ref: IREF });
  t('review request sent after delivery', q.ok && outbox.some(m => /How did we do/.test(m.subject) && m.to[0] === 'ivy@example.com'));
  q = await post({ action: 'admin_invoice', key: TK, ref: IREF });
  t('invoice asks for bank details first', !q.ok && q.needsBank);
  q = await post({ action: 'admin_settings', key: TK, bankName: 'PRJ Logistics Ltd', sortCode: '1234', accNo: '12345678' });
  t('bank details need a 6-digit sort code', !q.ok);
  q = await post({ action: 'admin_settings', key: TK, bankName: 'PRJ Logistics Ltd', sortCode: '12 34 56', accNo: '12345678' });
  t('bank details saved', q.ok && q.settings.sortCode === '12-34-56' && q.settings.accNo === '12345678');
  q = await post({ action: 'admin_settings', key: TK, googleReview: 'http://bad', });
  t('settings refuse non-https review link', !q.ok);
  q = await post({ action: 'admin_settings', key: TK, googleReview: 'https://g.page/r/test/review', autoReview: true, bank: 'PRJ Logistics Ltd, 12-34-56, 12345678' });
  t('settings saved', q.ok && q.settings.autoReview && /12-34-56/.test(q.settings.bank));
  let L = await post({ action: 'admin_list', key: TK });
  const ij = L.jobs.find(j => j.ref === IREF);
  t('list has reminder, review and customer key', ij && ij.payReminded && ij.reviewAsked && ij.ckey === 'ivy@example.com' && L.settings && L.settings.googleReview);
  // notes need the customer key, sent as "key" is the login token, so the note key goes in "ckey"
  q = await post({ action: 'admin_note_save', key: TK, ckey: 'ivy@example.com', note: 'Gate at the back' });
  t('note saved', q.ok && (await post({ action: 'admin_list', key: TK })).notes['ivy@example.com'].note === 'Gate at the back');
  q = await post({ action: 'admin_invoices', key: TK, month: M });
  const cand = q.customers && q.customers.find(c => c.refs.indexOf(IREF) >= 0);
  t('invoice candidate listed', q.ok && cand && cand.total === 120 && cand.unpaid === 1);
  const pv = await post({ action: 'admin_invoice', key: TK, month: M, ikey: cand.key });
  if (process.env.INV) (await import('node:fs')).writeFileSync(process.env.INV, Buffer.from(pv.pdf, 'base64'));
  t('invoice preview is a PDF', pv.ok && Buffer.from(pv.pdf, 'base64').slice(0, 5).toString() === '%PDF-' && /^PRJ-INV-\d{4}-0001$/.test(pv.number));
  const sentBefore = outbox.length;
  q = await post({ action: 'admin_invoice', key: TK, month: M, ikey: cand.key, send: true });
  const im = outbox.slice(sentBefore).find(m => /^Invoice PRJ-INV/.test(m.subject));
  t('invoice emailed with PDF', q.ok && im && im.attachments.some(a => /\.pdf$/.test(a.filename) && Buffer.from(a.content, 'base64').slice(0, 4).toString() === '%PDF'));
  q = await post({ action: 'admin_invoices', key: TK, month: M });
  t('sent invoice remembered', q.customers.find(c => c.key === cand.key).invoices.some(v => v.sentTo === 'ivy@example.com'));
  { const one = await post({ action: 'admin_invoice', key: TK, ref: IREF, save: true });
    if (process.env.INV1) (await import('node:fs')).writeFileSync(process.env.INV1, Buffer.from(one.pdf, 'base64'));
    t('single-job invoice made', one.ok && /^PRJ-INV-\d{4}-\d{4}$/.test(one.number));
    const again = await post({ action: 'admin_invoice', key: TK, ref: IREF, send: true, to: 'accounts@ivy.example' });
    t('single-job invoice keeps its number when sent', again.ok && again.number === one.number && outbox.some(m => m.to[0] === 'accounts@ivy.example' && /Invoice PRJ-INV/.test(m.subject)));
    const LL = await post({ action: 'admin_list', key: TK });
    t('job shows its invoice', LL.jobs.find(j => j.ref === IREF).invoice.number === one.number); }
  { let o = await post({ action: 'admin_outreach_save', key: TK, item: { name: 'Berkshire Solar Supplies Ltd', email: 'info@bss.example', area: 'Reading', ltd: true } });
    t('outreach: company added', o.ok && o.item.status === 'todo' && o.item.ltd);
    const oid = o.item.id;
    o = await post({ action: 'admin_outreach_save', key: TK, item: { name: 'Berkshire Solar Supplies', email: '' } });
    t('outreach: duplicate name refused', !o.ok && o.duplicate);
    o = await post({ action: 'admin_outreach_save', key: TK, item: { name: 'Other Name', email: 'sales@bss.example' } });
    t('outreach: same email domain refused', !o.ok && o.duplicate);
    o = await post({ action: 'admin_outreach_save', key: TK, item: { id: oid, status: 'emailed' } });
    t('outreach: marked emailed with date', o.ok && o.item.status === 'emailed' && !!o.item.emailedAt);
    o = await post({ action: 'admin_outreach_bulk', key: TK, lines: [{ name: 'Thames Prints Ltd', email: 'hi@tp.example', area: 'Reading' }, { name: 'Berkshire Solar Supplies Ltd' }, { name: 'Wokingham Parts', phone: '0118 111 2222' }] });
    t('outreach: bulk adds new, skips known', o.ok && o.added === 2 && o.skipped === 1);
    o = await post({ action: 'admin_outreach', key: TK });
    t('outreach: list has 3', o.ok && o.items.length === 3 && o.items.find(x => x.name === 'Thames Prints Ltd').ltd);
    o = await post({ action: 'admin_outreach_delete', key: TK, id: oid });
    t('outreach: removed', o.ok && (await post({ action: 'admin_outreach', key: TK })).items.length === 2); }
{ let r = await post({ action: 'lead_submit', name: 'Jane Smith', company: 'Acme Parts Ltd', email: 'jane@acmeparts.co.uk', phone: '07700 900123', sends: 'Spare parts', consent: true, event: 'Wokingham networking' });
  t('lead form: accepted', r.ok);
  t('lead form: needs consent', !(await post({ action: 'lead_submit', name: 'X', email: 'x@y.co.uk' })).ok);
  t('lead form: bad email refused', !(await post({ action: 'lead_submit', name: 'X', email: 'nope', consent: true })).ok);
  t('lead form: honeypot', (await post({ action: 'lead_submit', name: 'Bot', email: 'b@b.co.uk', consent: true, website: 'x' })).ok);
  let L = (await post({ action: 'admin_outreach', key: TK })).items;
  const j = L.find(x => x.name === 'Acme Parts Ltd');
  t('lead form: on Outreach list', !!j && j.sector === 'Networking' && j.ltd && /Jane Smith/.test(j.note) && /Spare parts/.test(j.note) && j.status === 'todo');
  t('lead form: bot not saved', !L.find(x => x.name === 'Bot'));
  r = await post({ action: 'lead_submit', name: 'Jane Smith', company: 'Acme Parts', email: 'jane@acmeparts.co.uk', consent: true });
  L = (await post({ action: 'admin_outreach', key: TK })).items;
  t('lead form: duplicate merged', r.ok && L.filter(x => /acme/i.test(x.name)).length === 1); }
  { // email to a company on the Outreach list, sent by our system
    let q = await post({ action: 'admin_outreach_save', key: TK, item: { name: 'Mail Test Ltd', email: 'boss@mailtest.co.uk', area: 'Reading', ltd: true } });
    const id = q.item.id, ob = outbox.length;
    q = await post({ action: 'admin_outreach_email', key: TK, id, subject: 'Courier for {company}', body: 'Hello,\nWe deliver same day around Reading for {company}. See www.prjlogistics.co.uk\nKind regards,' });
    const m = outbox[outbox.length - 1];
    t('outreach email sent', q.ok && outbox.length === ob + 1 && m.to.join() === 'boss@mailtest.co.uk' && m.subject === 'Courier for Mail Test Ltd' && /for Mail Test Ltd/.test(m.html) && /reply "stop"/.test(m.html) && /Director/.test(m.html) && m.bcc && m.bcc[0] === 'contact@prjlogistics.co.uk');
    t('outreach email marks it emailed', q.item.status === 'emailed' && !!q.item.emailedAt && /email: Courier for Mail Test Ltd/.test(q.item.note));
    q = await post({ action: 'admin_outreach_email', key: TK, id, subject: 'Follow up', body: 'Just checking in again about deliveries.' });
    t('second email is the follow-up', q.ok && q.item.status === 'followup');
    { const ob2 = outbox.length;
      await post({ action: 'admin_outreach_save', key: TK, item: { id, status: 'todo' } });
      q = await post({ action: 'admin_outreach_email', key: TK, id, subject: 'Hello from {me}', body: 'My name is {me}, nice to meet you all.', signAs: 'Patryk' });
      const m2 = outbox[outbox.length - 1];
      t('email signed as the chosen director', q.ok && outbox.length === ob2 + 1 && m2.subject === 'Hello from Patryk Forgiel' && /<b>Patryk Forgiel<\/b><br>Director/.test(m2.html) && !/Pawel/.test(m2.html));
      await post({ action: 'admin_outreach_save', key: TK, item: { id, status: 'followup' } }); }
    await post({ action: 'admin_outreach_save', key: TK, item: { id, status: 'stop' } });
    q = await post({ action: 'admin_outreach_email', key: TK, id, subject: 'Again', body: 'Trying once more with a long enough body.' });
    t('no email after "stop"', !q.ok && outbox.length === ob + 3);
    let q2 = await post({ action: 'admin_outreach_save', key: TK, item: { name: 'Joe Sole Trader', email: 'joe@example.com', area: 'Reading' } });
    q = await post({ action: 'admin_outreach_email', key: TK, id: q2.item.id, subject: 'Hi', body: 'A message that is long enough to send.' });
    t('not Ltd: asks to confirm first', !q.ok && q.needsConfirm && outbox.length === ob + 3);
    q = await post({ action: 'admin_outreach_email', key: TK, id: q2.item.id, subject: 'Hi', body: 'A message that is long enough to send.', notLtdOk: true });
    t('not Ltd: sent after confirming', q.ok && outbox.length === ob + 4);
    t('outreach email needs admin login', !(await post({ action: 'admin_outreach_email', id, subject: 'x', body: 'yyyyyyyyyyyyyyyyyyyyyyyyy' })).ok);
    q = await post({ action: 'admin_settings', key: TK, outreachTpl: { subject: 'S {company}', body: 'My template body text' } });
    t('outreach template saved', q.ok && q.settings.outreachTpl.subject === 'S {company}');
    q = await post({ action: 'admin_outreach_save', key: TK, item: { id: q2.item.id, name: 'Joe Bloggs Ltd', email: 'joe@bloggs.co.uk', phone: '0118 111 2222', area: 'Wokingham', sector: 'Builder' } });
    t('outreach details edited', q.ok && q.item.name === 'Joe Bloggs Ltd' && q.item.email === 'joe@bloggs.co.uk' && q.item.phone === '0118 111 2222' && q.item.area === 'Wokingham' && q.item.sector === 'Builder');
    q = await post({ action: 'admin_outreach_save', key: TK, item: { id: q2.item.id, email: 'boss@mailtest.co.uk' } });
    t('edit refused when the email belongs to another company', !q.ok && q.duplicate);
    await post({ action: 'admin_outreach_delete', key: TK, id }); await post({ action: 'admin_outreach_delete', key: TK, id: q2.item.id });
  }
  // push: phone subscribes, a new request arrives, the phone gets an encrypted message it can read
  const kr = await post({ action: 'admin_push_key', key: TK });
  t('push key made', kr.ok && kr.key.length > 80);
  const ua = await crypto.webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPub = new Uint8Array(await crypto.webcrypto.subtle.exportKey('raw', ua.publicKey)), authS = crypto.randomBytes(16);
  const bu = b => Buffer.from(b).toString('base64url');
  q = await post({ action: 'admin_push_sub', key: TK, sub: { endpoint: 'https://push.example.com/abc', keys: { p256dh: bu(uaPub), auth: bu(authS) } } });
  t('push subscription saved', q.ok);
  const pushed = [], realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { if (String(url).startsWith('https://push.example.com/')) { pushed.push({ url, init }); return new Response('', { status: 201 }); } return realFetch(url, init); };
  q = await post({ action: 'quote', ref: 'PRJ-261025-PUSHA', name: 'Pat Push', email: 'pat@example.com', phone: '07123 456780', from: '1 High St, Reading RG1 1AA', to: '5 New St, Oxford OX1 1AA', when: 'Tue, 27 Oct 2099 at 09:00', van: 'LWB van', load: 'Boxes', miles: '30' });
  await Promise.all(waits);
  globalThis.fetch = realFetch;
  let plain = '';
  if (pushed.length) {
    const b = new Uint8Array(pushed[0].init.body), salt = b.slice(0, 16), idlen = b[20], asPub = b.slice(21, 21 + idlen), ct = b.slice(21 + idlen);
    const sub = crypto.webcrypto.subtle;
    const asKey = await sub.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = Buffer.from(await sub.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
    const H = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
    const prkKey = H(authS, shared), ikm = H(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub, Buffer.from([1])]));
    const prk = H(salt, ikm), cek = H(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).slice(0, 16);
    const nonce = H(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).slice(0, 12);
    const dk = await sub.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);
    const pt = Buffer.from(await sub.decrypt({ name: 'AES-GCM', iv: nonce }, dk, ct));
    plain = pt.slice(0, pt.length - 1).toString();
  }
  t('new request pushed to the phone, encrypted and readable', pushed.length === 1 && /^vapid t=/.test(pushed[0].init.headers.Authorization) && /New quote request/.test(plain) && /Pat Push/.test(plain));
  { // without Telegram set up, phone notifications must still go out; and the bell's test reaches the phone
    const tg = (await env.DB.prepare("SELECT v FROM props WHERE k = 'tg_token'").first()) || {};
    await env.DB.prepare("DELETE FROM props WHERE k = 'tg_token'").run();
    const p2 = [];
    globalThis.fetch = async (url, init) => { if (String(url).startsWith('https://push.example.com/')) { p2.push(url); return new Response('', { status: 201 }); } return realFetch(url, init); };
    await post({ action: 'quote', ref: 'PRJ-261025-PUSHB', name: 'No Tele', email: 'nt@example.com', phone: '07123 456781', from: '1 High St, Reading RG1 1AA', to: '5 New St, Oxford OX1 1AA', when: 'Tue, 27 Oct 2099 at 09:00', van: 'LWB van', load: 'Boxes', consent: true });
    await Promise.all(waits);
    t('push works without Telegram', p2.length === 1);
    const pt = await post({ action: 'admin_push_test', key: TK });
    t('bell test notification sent', pt.ok && pt.devices === 1 && pt.sent === 1 && p2.length === 2);
    globalThis.fetch = async (url, init) => String(url).startsWith('https://push.example.com/') ? new Response('BadJwtToken', { status: 403 }) : realFetch(url, init);
    const pf = await post({ action: 'admin_push_test', key: TK });
    t('bell test reports why it failed', pf.ok && pf.sent === 0 && /403/.test(pf.failed[0].why));
    globalThis.fetch = realFetch;
    if (tg.v) await env.DB.prepare("INSERT INTO props (k, v) VALUES ('tg_token', ?)").bind(tg.v).run();
  }
  // automatic review request: hourly run during the day
  const hr = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  q = await post({ action: 'admin_create', key: TK, name: 'Auto Review', email: 'auto@example.com', from: 'RG1', to: 'RG2', when: DAY + ' 08:00', price: '£60', confirm: true, force: true });
  const AREF = q.ref;
  await post({ action: 'admin_update', key: TK, ref: AREF, status: 'Delivered' });
  { const rows = env.DB._db.prepare("SELECT id, data FROM rows WHERE sheet = 'Deliveries'").all(); const row = rows.find(x => JSON.parse(x.data)[0] === AREF); const d = JSON.parse(row.data); d[44] = { $d: new Date(Date.now() - 4 * 3600000).toISOString() }; env.DB._db.prepare('UPDATE rows SET data = ? WHERE id = ?').run(JSON.stringify(d), row.id); }
  const ob = outbox.length;
  await worker.scheduled({ cron: '0 * * * *' }, env, ctx);
  const got = outbox.slice(ob).some(m => m.to[0] === 'auto@example.com' && /How did we do/.test(m.subject));
  t('automatic review request ' + (hr >= 9 && hr <= 19 ? 'sent in the daytime' : 'held back at night'), hr >= 9 && hr <= 19 ? got : !got);
}
{ // card payments with Stripe: automatic "Pay" link, Checkout page for the exact price, webhook marks the job Paid
  env.STRIPE_SECRET_KEY = 'sk_test_x'; env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  const calls = [], realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { if (String(url).startsWith('https://api.stripe.com/')) { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }), { status: 200 }); } return realFetch(url, init); };
  const ob = outbox.length;
  const pr = (await post({ action: 'admin_create', key: TK, name: 'Card Customer', email: 'card@example.com', phone: '07123 456785', from: 'RG1 1AA', to: 'OX1 1AA', when: 'Fri, 30 Oct 2099 at 11:00', price: '£128.50', confirm: true, force: true })).ref;
  const bm = outbox.slice(ob).find(m => m.to[0] === 'card@example.com' && /booked/i.test(m.subject));
  const pl = bm && /quote\.html\?pay=1&(?:amp;)?ref=([^&"]+)&(?:amp;)?t=([0-9a-f]{32})/.exec(bm.html);
  t('booking email has our own Pay link (Stripe)', !!pl && /Pay £128.50 securely/.test(bm.html));
  let q = await post({ action: 'pay_start', ref: decodeURIComponent(pl[1]), t: pl[2] });
  const body = calls.length ? decodeURIComponent(String(calls[0].init.body)) : '';
  t('Stripe Checkout made for the exact price', q.ok && q.url === 'https://checkout.stripe.com/c/pay/cs_test_1' && calls[0].init.headers.Authorization === 'Bearer sk_test_x' && /unit_amount\]=12850/.test(body) && /metadata\[ref\]=/.test(body) && /customer_email=card@example.com/.test(body));
  t('pay link needs the right token', !(await post({ action: 'pay_start', ref: decodeURIComponent(pl[1]), t: '0'.repeat(32) })).ok);
  // webhook
  const ev = JSON.stringify({ type: 'checkout.session.completed', data: { object: { payment_status: 'paid', amount_total: 12850, metadata: { ref: pr }, client_reference_id: pr, payment_intent: 'pi_1' } } });
  const sign = async (b, ts) => { const k = crypto.createHmac('sha256', 'whsec_test').update(ts + '.' + b).digest('hex'); return 't=' + ts + ',v1=' + k; };
  const hook = async (b, sig) => (await worker.fetch(new Request(BASE + '/stripe-webhook', { method: 'POST', body: b, headers: { 'Stripe-Signature': sig } }), env, ctx));
  let h = await hook(ev, 't=1,v1=bad');
  t('webhook with a wrong signature is refused', h.status === 400);
  q = await post({ action: 'stripe_event' });
  let j = (await post({ action: 'admin_list', key: TK })).jobs.find(x => x.ref === pr);
  t('a fake stripe_event without Stripe does nothing', !q.ok && j.payment !== 'Paid');
  const pushedBefore = telegram.length;
  h = await hook(ev, await sign(ev, Math.floor(Date.now() / 1000)));
  j = (await post({ action: 'admin_list', key: TK })).jobs.find(x => x.ref === pr);
  t('paid by card: job marked Paid automatically', h.status === 200 && j.payment === 'Paid');
  t('office told about the payment', telegram.slice(pushedBefore).some(x => /paid by card: £128.50/.test(x.text)));
  q = await post({ action: 'pay_start', ref: decodeURIComponent(pl[1]), t: pl[2] });
  t('paid already: no second payment', q.ok && q.paid && calls.length === 1);
  h = await hook(ev, await sign(ev, Math.floor(Date.now() / 1000) - 3600));
  t('old webhook (replay) refused', h.status === 400);
  // business customers are never sent the card link
  const ob2 = outbox.length;
  const bz = (await post({ action: 'admin_quick_quote', key: TK, kind: 'business', company: 'Card Biz Ltd', email: 'cardbiz@example.com', from: 'RG1 1AA', to: 'OX1 1AA', price: '£90' })).ref;
  await post({ action: 'admin_update', key: TK, ref: bz, when: 'Fri, 30 Oct 2099 at 15:00', status: 'Booked', force: true });
  const bb = outbox.slice(ob2).find(m => m.to[0] === 'cardbiz@example.com' && /booked/i.test(m.subject));
  t('business: no card link, invoice text', bb && !/pay=1/.test(bb.html) && /invoice/i.test(bb.html));
  globalThis.fetch = realFetch; delete env.STRIPE_SECRET_KEY; delete env.STRIPE_WEBHOOK_SECRET;
  for (const r2 of [pr, bz]) await post({ action: 'admin_update', key: TK, ref: r2, status: 'Cancelled' });
}
{ // two drivers: clashes, time off, a notification only to the driver who gets the job
  const PT = (await post({ action: 'login', username: 'patryk.forgiel@gmail.com', password: 'Patryk-Pass-456' })).token;
  const W = h => 'Mon, 2 Mar 2099 at ' + h, mk = async h => (await post({ action: 'admin_create', key: TK, name: 'Two Drivers ' + h, email: 'td@example.com', from: '1 High St, Reading RG1 1AA', to: '5 New St, Birmingham B1 1AA', when: W(h), price: '£100', confirm: true, force: true })).ref;
  const j1 = await mk('10:00'), j2 = await mk('11:00'), j3 = await mk('16:00');
  let q = await post({ action: 'busy', date: '2099-03-02' });
  t('two vans: one job does not block the time', q.ok && !q.blocked.some(b => b[0] <= '16:00' && b[1] > '16:00'));
  await post({ action: 'admin_push_sub', key: PT, sub: { endpoint: 'https://push.example.com/patryk', keys: { p256dh: 'BOr6b9yK1y7xY0aGg8Rm2p6x2n7S2bJ8dH4Q0b7h9yV5wV0kz2c3m3w8f6h4k9q0n2b5c7d1e3f5g7h9j1k3m5n7p9', auth: 'abcdefghijklmnopqrstuv' } } });
  env.TEST_PUSH.length = 0;
  q = await post({ action: 'admin_update', key: TK, ref: j1, driver: 'Patryk' });
  t('driver given a free job', q.ok);
  t('only that driver gets a notification', env.TEST_PUSH.length === 1 && env.TEST_PUSH[0].to === 'Patryk' && /New job for you/.test(env.TEST_PUSH[0].title) && new RegExp(j1).test(env.TEST_PUSH[0].body));
  q = await post({ action: 'admin_update', key: TK, ref: j2, driver: 'Patryk' });
  t('clash: driver already on another job', !q.ok && q.needsForce && q.clash && new RegExp(j1).test(q.message) && /Patryk already has/.test(q.message));
  let L = (await post({ action: 'admin_list', key: TK })).jobs;
  t('clash: nothing saved', !L.find(x => x.ref === j2).driver);
  q = await post({ action: 'admin_update', key: TK, ref: j2, driver: 'Patryk', force: true });
  t('clash: saved when you confirm', q.ok);
  q = await post({ action: 'admin_update', key: TK, ref: j2, driver: 'Pawel' });
  t('both vans on long trips at once: warning', !q.ok && q.clash && /Both vans would be away on long trips/.test(q.message) && !/Pawel already has/.test(q.message));
  q = await post({ action: 'admin_update', key: TK, ref: j2, driver: 'Pawel', force: true });
  t('the other driver is free (saved after the warning)', q.ok);
  // day roles: Patryk local, Pawel long
  q = await post({ action: 'admin_day_role', key: TK, date: '2099-03-03', driver: 'Patryk', role: 'local' });
  t('day role saved', q.ok && q.dayRoles['2099-03-03'].Patryk === 'local');
  const jl = (await post({ action: 'admin_create', key: TK, name: 'Long One', email: 'td@example.com', from: '1 High St, Reading RG1 1AA', to: '5 New St, Birmingham B1 1AA', when: 'Tue, 3 Mar 2099 at 09:00', price: '£150', confirm: true, force: true })).ref;
  q = await post({ action: 'admin_update', key: TK, ref: jl, driver: 'Patryk' });
  t('long trip for the local driver: warning', !q.ok && /Patryk does the local jobs/.test(q.message) && /100 miles/.test(q.message));
  t('miles saved on the job', (await post({ action: 'admin_list', key: TK })).jobs.find(x => x.ref === jl).miles === '100');
  q = await post({ action: 'admin_update', key: TK, ref: jl, driver: 'Pawel' });
  t('long trip for the other driver: fine', q.ok);
  t('day roles in the job list', (await post({ action: 'admin_list', key: TK })).dayRoles['2099-03-03'].Patryk === 'local');
  q = await post({ action: 'admin_day_role', key: TK, date: '2099-03-03', driver: 'Patryk', role: '' });
  t('day role cleared', q.ok && !q.dayRoles['2099-03-03']);
  await post({ action: 'admin_update', key: TK, ref: jl, status: 'Cancelled' });
  q = await post({ action: 'admin_timeoff_save', key: TK, driver: 'Pawel', date: '2099-03-02', note: 'holiday' });
  t('time off saved', q.ok && q.timeOff.some(x => x.driver === 'Pawel' && x.date === '2099-03-02' && !x.from));
  t('time off sent with the job list', (await post({ action: 'admin_list', key: TK })).timeOff.length >= 1);
  q = await post({ action: 'admin_update', key: TK, ref: j3, driver: 'Pawel' });
  t('clash: driver is off that day', !q.ok && q.clash && /Pawel is off/.test(q.message) && /holiday/.test(q.message));
  q = await post({ action: 'busy', date: '2099-03-02' });
  t('time off: one van fewer, the job time is now full on the website', q.ok && q.blocked.some(b => b[0] <= '16:00' && b[1] > '16:00'));
  q = await post({ action: 'admin_timeoff_save', key: TK, driver: 'Nobody', date: '2099-03-02' });
  t('time off needs a real driver', !q.ok);
  q = await post({ action: 'admin_timeoff_save', key: TK, driver: 'Patryk', date: '2099-03-05', from: '13:00', to: '09:00' });
  t('time off: bad times refused', !q.ok);
  q = await post({ action: 'admin_timeoff_save', key: TK, driver: 'Patryk', date: '2099-03-09', days: 3 });
  t('time off for several days', q.ok && ['2099-03-09', '2099-03-10', '2099-03-11'].every(d => q.timeOff.some(x => x.driver === 'Patryk' && x.date === d)));
  for (const x of q.timeOff) await post({ action: 'admin_timeoff_delete', key: TK, id: x.id });
  t('time off removed', (await post({ action: 'admin_list', key: TK })).timeOff.length === 0);
  t('time off needs admin login', !(await post({ action: 'admin_timeoff_save', driver: 'Pawel', date: '2099-03-02' })).ok);
  for (const r of [j1, j2, j3]) await post({ action: 'admin_update', key: TK, ref: r, status: 'Cancelled' });
}
{ let q = await post({ action: 'admin_set_password', key: TK, forUser: 'patryk.forgiel@gmail.com', newPassword: 'Temp-Pass-9999', myPassword: 'wrong' });
  t('set password needs own password', !q.ok);
  q = await post({ action: 'admin_set_password', key: TK, forUser: 'patryk.forgiel@gmail.com', newPassword: 'Temp-Pass-9999', myPassword: 'Pawel-Pass-123' });
  t('password set for the other person', q.ok && q.name === 'Patryk' && (await post({ action: 'login', username: 'patryk.forgiel@gmail.com', password: 'Temp-Pass-9999' })).ok); }
r = await post({ action: 'change_password', key: TK, oldPassword: 'Pawel-Pass-123', newPassword: 'Brand-New-Pass-1' });
t('password changed', r.ok && !!r.token);
t('old session ends after password change', !(await post({ action: 'admin_list', key: TK })).ok);
t('new password works', (await post({ action: 'login', username: 'prjlogistics.ltd@gmail.com', password: 'Brand-New-Pass-1' })).ok);
for (let i = 0; i < 10; i++) await post({ action: 'login', username: 'prjlogistics.ltd@gmail.com', password: 'bad' + i });
t('lockout after 10 wrong passwords', /too many/i.test((await post({ action: 'login', username: 'prjlogistics.ltd@gmail.com', password: 'Brand-New-Pass-1' })).message || ''));
t('errors are logged to the Log table', env.DB._db.prepare("SELECT COUNT(*) AS n FROM rows WHERE sheet='Log'").get().n > 0);

/* ---- errors, CORS, health ---- */
const h = await worker.fetch(new Request(BASE + '/health'), env, ctx);
t('health check', h.status === 200 && h.headers.get('Access-Control-Allow-Origin') === '*');
const o = await worker.fetch(new Request(BASE + '/', { method: 'OPTIONS' }), env, ctx);
t('CORS preflight', o.status === 200 && /POST/.test(o.headers.get('Access-Control-Allow-Methods')));
await Promise.all(waits);
console.log(pass + ' pass, ' + fail + ' fail');
