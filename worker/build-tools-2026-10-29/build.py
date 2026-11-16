#!/usr/bin/env python3
"""Builds worker.js for Cloudflare from the Google Apps Script (google-apps-script.gs) plus runtime.js."""
import re, sys, pathlib

SRC = pathlib.Path('/mnt/user-data/outputs/google-apps-script.gs').read_text(encoding='utf-8')
RUNTIME = pathlib.Path('/home/claude/cf/runtime.js').read_text(encoding='utf-8')
OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/home/claude/cf/worker.js')

g = SRC

def func_span(name):
    m = re.search(r'^(async )?function ' + re.escape(name) + r'\(.*?^\}\n', g, re.S | re.M)
    if not m:
        raise SystemExit('function not found: ' + name)
    return m

def remove(name):
    global g
    m = func_span(name)
    g = g[:m.start()] + g[m.end():]

def replace_func(name, code):
    global g
    m = func_span(name)
    g = g[:m.start()] + code.strip('\n') + '\n' + g[m.end():]

# 1) things that only made sense in the Google editor
for n in ['setInitialPasswords', 'setTelegramToken', 'findTelegramChats', 'testTelegram', 'testPaymentMail', 'checkMailQuota',
          'testSuggest', 'testQuoteAck', 'onSheetEdit', 'onOpen', 'sweep', 'installTrigger', 'setTomTomKey']:
    remove(n)

# 2) Google Drive -> photos in the database
replace_func('getPodFolder', 'function getPodFolder() {\n  return DriveApp.folder;\n}')
replace_func('cleanUpOldPhotos', """async function cleanUpOldPhotos() {
  const cut = monthsAgo(KEEP.photosMonths).toISOString();
  const r = await RT.db.prepare('SELECT COUNT(DISTINCT id) AS n FROM photos WHERE created < ?').bind(cut).first();
  await RT.db.prepare('DELETE FROM photos WHERE created < ?').bind(cut).run();
  return (r && r.n) || 0;
}""")
replace_func('findFiles', """async function findFiles(ref) {
  if (!/^[A-Z0-9-]+$/i.test(ref)) return [];
  return await photosForRef(ref);
}""")

# 3) Telegram: sent after the reply, like emails
replace_func('notifyPhones', """function notifyPhones(text) {
  try {
    const token = props().getProperty('tg_token'), chats = props().getProperty('tg_chats');
    const env = RT.env;
    if (token && chats) String(chats).split(',').forEach(id => {   // (no Telegram set up: the phone notifications below still go out)
      if (!id) return;
      if (env.TEST_TELEGRAM) { env.TEST_TELEGRAM.push({ chat_id: id, text: String(text) }); return; }
      RT.queue.push(async () => {
        const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: id, text: String(text).slice(0, 3500) }) });
        if (!r.ok) await logDirect(env, 'Telegram notification failed (' + r.status + ') for chat ' + id);
      });
    });
  } catch (e) { logError('Telegram notification failed: ' + e); }
  try {   // phone notifications (web push) for everyone in the office who turned them on in the admin panel
    const env = RT.env, P = RT.props;
    if (!P.push_subs || P.push_subs === '[]') return;
    const snap = { push_subs: P.push_subs, vapid_jwk: P.vapid_jwk, vapid_pub: P.vapid_pub };
    const lines = String(text).split('\\n'), title = lines[0].slice(0, 80), body = lines.slice(1).join('\\n') || 'Open the admin panel';
    if (env.TEST_PUSH) env.TEST_PUSH.push({ title: title, body: body });
    RT.queue.push(async () => { await pushAll(env, snap, title, body); });
  } catch (e) { logError('Push notification failed: ' + e); }
}""")
replace_func('pushTest', """async function pushTest(by) {
  const P = RT.props;
  let subs = [];
  try { subs = JSON.parse(P.push_subs || '[]'); } catch (e) {}
  if (!subs.length) return { ok: true, devices: 0, sent: 0, failed: [] };
  const r = await pushAll(RT.env, { push_subs: P.push_subs, vapid_jwk: P.vapid_jwk, vapid_pub: P.vapid_pub }, '🔔 Test from PRJ', 'Notifications work on this phone. Sent by ' + (by || 'the office') + '.');
  return { ok: true, devices: r.devices, sent: r.sent, failed: r.failed };
}""")
replace_func('pushTo', """function pushTo(driver, title, body) {
  const env = RT.env, P = RT.props;
  let subs = [];
  try { subs = JSON.parse(P.push_subs || '[]'); } catch (e) {}
  subs = subs.filter(s => s.by === driver);
  if (!subs.length) return 0;
  if (env.TEST_PUSH) env.TEST_PUSH.push({ to: driver, title: title, body: body });
  const snap = { push_subs: JSON.stringify(subs), vapid_jwk: P.vapid_jwk, vapid_pub: P.vapid_pub };
  RT.queue.push(async () => { await pushAll(env, snap, title, body); });
  return subs.length;
}""")
replace_func('stripeKey', """function stripeKey() {
  return String(RT.env.STRIPE_SECRET_KEY || '');
}""")
replace_func('stripeVerifiedEvent', """function stripeVerifiedEvent() {
  return RT.stripeEvent || null;
}""")
replace_func('pushPublicKey', """async function pushPublicKey() {
  return (await vapidKeys(RT)).pub;
}""")

# 4) functions that wait for the network or the database become async
ASYNC = ['stripePayStart', 'handleQuote', 'driverClash', 'jobMilesFor', 'roleWarnings', 'geocodeUK', 'routeMiles', 'osrmRoute', 'suggestPrice', 'busyMinutesFor', 'ensureBusy', 'handleBusy',
         'processRow', 'handlePod', 'handleAdmin', 'doPost', 'doGet', 'cleanUpOldData', 'customerErase',
         'clientInstantPrice', 'clientBookInstant', 'clientBookDemo', 'clientBook', 'handleClient']
for n in ASYNC:
    g, k = re.subn(r'^function ' + n + r'\(', 'async function ' + n + '(', g, flags=re.M)
    if k != 1:
        raise SystemExit('could not make async: ' + n)
ASYNC.append('findFiles')
ASYNC.append('cleanUpOldPhotos')
ASYNC.append('pushPublicKey'); ASYNC.append('pushTest')
for n in ASYNC:
    g = re.sub(r'(?<![\w.])(?<!function )(?<!await )' + n + r'\(', 'await ' + n + '(', g)
    g = g.replace('async function await ' + n + '(', 'async function ' + n + '(')
g = g.replace('UrlFetchApp.fetch(', 'await UrlFetchApp.fetch(')

# sanity: no await inside a non-async function (each top-level function runs until the next one starts)
starts = [m for m in re.finditer(r'^(async )?function (\w+)\(', g, re.M)]
for i, m in enumerate(starts):
    end = starts[i + 1].start() if i + 1 < len(starts) else len(g)
    seg = g[m.start():end]
    if re.search(r'\bawait ', seg) and not m.group(1) and 'async (' not in seg:
        raise SystemExit('await used in non-async function: ' + m.group(2))

ROUTER = r"""

/* ===================== web entry point ===================== */
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS rows (id INTEGER PRIMARY KEY AUTOINCREMENT, sheet TEXT NOT NULL, data TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS rows_sheet ON rows (sheet, id)',
  'CREATE TABLE IF NOT EXISTS props (k TEXT PRIMARY KEY, v TEXT)',
  'CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, v TEXT, exp INTEGER)',
  'CREATE TABLE IF NOT EXISTS photos (id TEXT NOT NULL, part INTEGER NOT NULL, ref TEXT, name TEXT, mime TEXT, size INTEGER, created TEXT, data TEXT, PRIMARY KEY (id, part))',
  'CREATE INDEX IF NOT EXISTS photos_ref ON photos (ref)'
];
let schemaReady = false;
let chain = Promise.resolve();          // one request at a time per server instance
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
  schemaReady = true;
}

/* one-time move of the data from Google (sheets + settings), protected by the SETUP_KEY secret */
async function handleImport(env, body) {
  if (!env.SETUP_KEY || String(body.setupKey || '') !== String(env.SETUP_KEY)) return { ok: false, message: 'Wrong setup key.' };
  const data = body.data || {};
  const sheets = data.sheets || {}, propsIn = data.props || {};
  const existing = await env.DB.prepare("SELECT COUNT(*) AS n FROM rows WHERE sheet = 'Deliveries'").first();
  if (existing && existing.n > 0 && !body.replace) return { ok: false, message: 'There are already jobs in the new database. Tick "replace" to overwrite them.' };
  const st = [];
  if (body.replace) st.push(env.DB.prepare("DELETE FROM rows WHERE sheet IN ('Deliveries','Reviews','Clients','Messages','Problems')"));
  let count = 0;
  Object.keys(sheets).forEach(name => {
    if (['Deliveries', 'Reviews', 'Clients', 'Messages', 'Problems'].indexOf(name) < 0) return;
    (sheets[name] || []).forEach(row => {
      const r = row.map(v => (v && typeof v === 'object' && v.$d) ? new Date(v.$d) : v);
      if (!r.some(x => x !== '' && x !== null)) return;
      st.push(env.DB.prepare('INSERT INTO rows (sheet, data) VALUES (?, ?)').bind(name, pack(r))); count++;
    });
  });
  Object.keys(propsIn).forEach(k => st.push(env.DB.prepare('INSERT INTO props (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, String(propsIn[k]))));
  for (let i = 0; i < st.length; i += 50) await env.DB.batch(st.slice(i, i + 50));
  return { ok: true, rows: count, settings: Object.keys(propsIn).length };
}

async function servePhoto(env, id) {
  if (!/^[0-9a-f]{32}$/.test(id)) return new Response('Not found', { status: 404 });
  const res = await env.DB.prepare('SELECT mime, data FROM photos WHERE id = ? ORDER BY part').bind(id).all();
  const parts = res.results || [];
  if (!parts.length) return new Response('Not found', { status: 404 });
  const bytes = b64ToBytes(parts.map(p => p.data).join(''));
  return new Response(bytes, { headers: { 'Content-Type': parts[0].mime || 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' } });
}

/* Stripe-Signature: t=timestamp,v1=hex(HMAC-SHA256(secret, t + '.' + body)); not older than 5 minutes */
async function verifyStripe(env, body, header) {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !header) return null;
  const parts = {}; header.split(',').forEach(x => { const i = x.indexOf('='); if (i > 0) { const k = x.slice(0, i).trim(); (parts[k] = parts[k] || []).push(x.slice(i + 1).trim()); } });
  const t = (parts.t || [])[0];
  if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 300) return null;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(t + '.' + body)))).map(b => ('0' + b.toString(16)).slice(-2)).join('');
  if (!(parts.v1 || []).some(v => v.length === sig.length && v === sig)) return null;
  try { return JSON.parse(body); } catch (e) { return null; }
}
async function handle(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  await ensureSchema(env);
  const ph = /^\/photo\/([0-9a-f]+)$/.exec(url.pathname);
  if (ph && request.method === 'GET') return servePhoto(env, ph[1]);
  if (url.pathname === '/health') return new Response(JSON.stringify({ ok: true }), { headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) });

  let text = '';
  if (request.method === 'POST') text = await request.text();
  /* Stripe calls this when a card payment went through; the event is used only if its signature is right */
  let stripeEvent = null;
  if (url.pathname === '/stripe-webhook') {
    if (request.method !== 'POST') return new Response('ok');
    stripeEvent = await verifyStripe(env, text, request.headers.get('Stripe-Signature') || '');
    if (!stripeEvent) { await logDirect(env, 'Stripe webhook refused (bad or missing signature)'); return new Response('bad signature', { status: 400 }); }
    text = JSON.stringify({ action: 'stripe_event' });
  }
  if (request.method === 'POST') {
    let d = null; try { d = JSON.parse(text); } catch (e) {}
    if (d && d.action === 'migrate_import') {
      const r = await handleImport(env, d);
      return new Response(JSON.stringify(r), { headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) });
    }
  }
  const rt = new Runtime(env, ctx, url.origin);
  let out;
  const run = async () => {
    RT = rt;
    rt.stripeEvent = stripeEvent;
    await rt.preload();
    if (request.method === 'POST') out = await doPost({ postData: { contents: text } });
    else {
      const parameter = {}; url.searchParams.forEach((v, k) => { parameter[k] = v; });
      out = await doGet({ parameter: parameter });
    }
    await rt.flush();
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  await p;
  const jobs = rt.queue.slice();
  if (jobs.length) {
    const drain = (async () => { for (const j of jobs) { try { await j(); } catch (e) { await logDirect(env, 'Background task failed: ' + e); } } })();
    if (ctx && ctx.waitUntil) ctx.waitUntil(drain); else await drain;
  }
  return new Response(out && out.c !== undefined ? out.c : '{}', { headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS) });
}

/* every night (Cloudflare Cron Trigger): delete personal data we no longer need */
async function nightly(env, ctx, cron) {
  await ensureSchema(env);
  const rt = new Runtime(env, ctx, String(env.PUBLIC_URL || '').replace(/\/$/, ''));
  let out = {};
  // the Cron Trigger can run every hour ("0 * * * *"): clean-up once a night at 3am, review requests during the day
  const hour = Number(formatDate(new Date(), 'Europe/London', 'HH'));
  const run = async () => {
    RT = rt; await rt.preload();
    if (hour === 3 || !cron || cron === '0 3 * * *') out = await cleanUpOldData();
    out.reviews = autoReviewRequests();
    await rt.flush();
    for (const j of rt.queue.splice(0)) { try { await j(); } catch (e) { await logDirect(env, 'Background task failed: ' + e); } }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  await p;
  return out;
}

export default {
  async scheduled(event, env, ctx) {
    try {
      return await nightly(env, ctx, event && event.cron);
    } catch (e) { try { await logDirect(env, 'Nightly clean-up failed: ' + (e && e.stack || e)); } catch (x) {} }
  },
  async fetch(request, env, ctx) {
    try { return await handle(request, env, ctx); }
    catch (e) {
      try { await logDirect(env, 'Server error: ' + (e && e.stack || e)); } catch (x) {}
      return new Response(JSON.stringify({ ok: false, message: 'Server error. Please try again.' }), { status: 500, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) });
    }
  }
};
"""

header = "/* PRJ Logistics Ltd - server for Cloudflare Workers. Paste this whole file into the Worker editor.\n   Built from the Google Apps Script version. */\n"
OUT.write_text(header + RUNTIME + "\n/* ===================== business logic (from the Google Apps Script) ===================== */\n" + g + ROUTER, encoding='utf-8')
print('written', OUT, len(OUT.read_text()))
