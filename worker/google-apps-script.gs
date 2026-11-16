// PRJ Logistics: tracking, customer emails, contact form and the driver app
//
// Sheet "Deliveries", columns:
//  A Reference | B Status | C Updated | D Note (shown to customer) | E Customer email
//  F Proof of delivery link | G Last emailed status | H Received by (internal only)
//  I Collect from | J Deliver to   (short text for the driver app list, e.g. "RG1 1AA Reading")
//  K Driver (filled in by the driver app, or chosen in the admin panel)
//  L Name | M Phone | N Collection | O Vehicle | P Load | Q Miles | R Estimate | S Price (agreed, shown to customer in the quote and booking emails)
//  T Quote sent (date, filled in when you press "Send quote to customer" in the admin panel)
//  U-Y quote token, quoted price, customer answer, answered, customer comment
//  Z Payment link (Stripe / SumUp link you paste in the admin panel) | AA Payment (Unpaid / Paid / Invoice (7 days) / Refunded)
//  AB-AM Delivery details the customer fills in after accepting (customer type, company, invoice email and address,
//        collection contact/phone/notes, delivery contact/phone/notes, signature needed, date received)
//  AN Busy (min) | AO On the way | AP Arrived (collection) | AQ Arrived (delivery) | AR Collected at | AS Delivered at
//  (waiting time = AR - AP at the collection and AS - AQ at the delivery) | AT Last problem (from the driver app)
//  AU Remarks at delivery | AV Signed proof of delivery (PDF link)
// Sheet "Problems" is created automatically: every problem the driver reports (breakdown, delay, no one there...).
// Sheet "Log" is created automatically: every photo upload with time, driver and reference.
//
// Drive folder "PRJ Delivery Documents" is created automatically and holds all photos.

const SHEET_NAME = 'Deliveries';
const POD_FOLDER_NAME = 'PRJ Delivery Documents';
const SITE_URL = 'https://www.prjlogistics.co.uk'; // change to your website address
const ADMIN_PAGE = 'admin.html'; // address of the admin panel (change here if the panel file is renamed)
const COMPANY = 'PRJ Logistics Ltd';
const PHONE = '+44 7749 818335'; // shown in customer emails
const OWNER_EMAIL = 'contact@prjlogistics.co.uk'; // where website messages go; customers also reply to this address
const MESSAGES_SHEET = 'Messages';
// People who can log in (to the admin panel and the driver app). Login = username + password.
// Usernames are lower case; an email address works too (e.g. 'anna@gmail.com'). 'name' is what customers see as the driver. Passwords are NOT stored here:
// run setInitialPasswords() once (see below) and then change the password inside the admin panel.
const USERS = {
  'patryk.forgiel@gmail.com': { name: 'Patryk' },
  'prjlogistics.ltd@gmail.com': { name: 'Pawel', login: 'prj.logisticsltd@gmail.com' }   // the account is stored under this key; Pawel logs in with "login"
};
// Other usernames that log in to the same account (the password stays the same).
const USER_ALIASES = {
  'prj.logisticsltd@gmail.com': 'prjlogistics.ltd@gmail.com'
};
const SESSION_DAYS = 30; // how long a phone stays logged in
const STATUSES = ['Requested', 'Booked', 'Collected', 'Delivered', 'Cancelled'];
const MAIL_STATUSES = ['Booked', 'Collected', 'Delivered']; // statuses that trigger an email
// Small note at the bottom of customer emails, so our emails do not get lost in spam
const SPAM_NOTE_HTML = '<p style="font-size:13px;color:#5E6B7C;margin-top:18px">Cannot find our emails? Please check your spam or promotions folder, mark us as "Not spam" and add ' + OWNER_EMAIL + ' to your contacts.</p>';
// Price suggestion shown in the admin panel (you can always type a different price).
// Every job = route miles x the rate per mile (private or business), at least the minimum charge. The rates are changed in the admin panel
// under Settings > Prices; these are the starting values. The London rate applies when collection or delivery is in Greater London,
// which is the ULEZ area and includes the Congestion Charge zone. Postcodes are checked for the region "London";
// for an address without a postcode, LONDON_RADIUS_MILES around central London is used instead.
const RATE_PER_MILE = 1.84, RATE_LONDON = 2.4;
/* the rates saved in Settings > Prices (or the starting values above) */
function priceRates() {
  const p = props(), n = k => { const v = Number(p.getProperty(k)); return isFinite(v) && v > 0 ? v : 0; };
  const r = { business: n('rate_business') || n('rate_mile') || RATE_PER_MILE, private: n('rate_private') || 2, london: n('rate_london') || RATE_LONDON,
    min: Number(p.getProperty('min_charge')) > 0 ? Number(p.getProperty('min_charge')) : 0 };
  // separate minimum charge for private and business customers (the old single minimum is used until they are set)
  const mm = k => { const v = p.getProperty(k); return v === null || v === undefined || v === '' ? r.min : (Number(v) > 0 ? Number(v) : 0); };
  r.minPrivate = mm('min_private'); r.minBusiness = mm('min_business');
  return r;
}
const LOCAL_RADIUS_MILES = 5;
const LOCAL_CENTRES = [[51.4543, -0.9781], [51.4112, -0.8335]]; // Reading, Wokingham
const LONDON_CENTRE = [51.5074, -0.1278], LONDON_RADIUS_MILES = 15;
// Daily limit: the maximum number of confirmed jobs per day. The admin panel warns when a day is full
// (you can still confirm anyway). Change the number here.
const DAY_LIMIT = 6;
const PAY_STATUSES = ['Unpaid', 'Paid', 'Invoice (7 days)', 'Refunded'];
const MAX_ATTACH_BYTES = 20 * 1024 * 1024;

/* ---------- small helpers ---------- */
function cleanText(v, n) { return String(v || '').replace(/[\r\n]+/g, ' ').trim().slice(0, n); }
function safeCell(v) { return /^[=+\-@]/.test(v) ? "'" + v : v; } // stops spreadsheet formulas
/* UK phone numbers only (07..., 01/02/03/08..., with or without +44). Returns a tidy number, '' if empty, or null if not UK. */
function ukPhone(v) {
  var raw = String(v || '').trim();
  if (!raw) return '';
  var n = raw.replace(/\(0\)/g, '').replace(/[\s\-().]/g, '');
  if (/^\+44/.test(n)) n = '0' + n.slice(3); else if (/^0044/.test(n)) n = '0' + n.slice(4);
  if (!/^0(7\d{9}|[1238]\d{8,9})$/.test(n)) return null;
  return /^07/.test(n) ? n.slice(0, 5) + ' ' + n.slice(5) : n;
}

function validEmail(v) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v || '').trim()); }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

/* ---------- website lookup (only towns, postcode districts and first names; no full addresses) ---------- */
function doGet(e) {
  if (e.parameter && e.parameter.view === 'quote') return handleQuoteView(e);
  if (e.parameter && e.parameter.view === 'details') return handleDetailsView(e);
  const ref = String((e.parameter && e.parameter.ref) || '').trim().toUpperCase();
  const out = ContentService.createTextOutput().setMimeType(ContentService.MimeType.JSON);
  if (!ref) return out.setContent(JSON.stringify({ found: false }));
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim().toUpperCase() === ref) {
      const u = rows[i][2];
      const updated = u instanceof Date
        ? Utilities.formatDate(u, 'Europe/London', 'd MMM yyyy, HH:mm') : String(u || '');
      return out.setContent(JSON.stringify({
        found: true, ref: ref, status: String(rows[i][1]), updated: updated,
        note: String(rows[i][3] || ''), pod: String(rows[i][5] || ''),
        onway: String(rows[i][1]).trim() === 'Booked' ? onWayText(rows[i][ONWAY_COL - 1]) : '',
        when: trackWhen(rows[i][13], rows[i][2]), fromArea: areaOf(rows[i][8]), toArea: areaOf(rows[i][9]),
        driver: firstName(rows[i][10]), collectedAt: hhmm(rows[i][DONE_C_COL - 1]), deliveredAt: hhmm(rows[i][DONE_D_COL - 1]),
        receivedBy: String(rows[i][1]).trim() === 'Delivered' ? firstName(rows[i][7]) : '',
        eta: String(rows[i][1]).trim() === 'Collected' ? trackEta(ref, rows[i]) : ''
      }));
    }
  }
  return out.setContent(JSON.stringify({ found: false }));
}

/* ---------- tracking page extras: only towns, postcode districts and first names (no full addresses) ---------- */
function areaOf(addr) {
  const a = String(addr || '').replace(/\s+/g, ' ').trim();
  if (!a) return '';
  const pc = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*\d[A-Z]{2}\b/i.exec(a);
  const district = pc ? pc[1].toUpperCase() : '';
  const parts = a.replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i, '').split(',').map(x => x.trim()).filter(x => x && !/^(uk|united kingdom|england|gb)$/i.test(x));
  let town = '';
  for (let k = parts.length - 1; k >= 0; k--) { if (!/\d/.test(parts[k])) { town = parts[k]; break; } }
  if (!town && parts.length) town = parts[parts.length - 1].replace(/^\d+[a-z]?\s+/i, '');
  return (town + (district ? ' ' + district : '')).trim().slice(0, 60);
}
function firstName(v) { return String(v || '').trim().split(/\s+/)[0].slice(0, 30); }
function hhmm(v) { const d = dateOf(v); return d ? Utilities.formatDate(d, 'Europe/London', 'HH:mm') : ''; }
function trackWhen(whenText, created) {
  const t = String(whenText || '').trim();
  if (!t) return '';
  const start = whenStart(t, created);
  if (start) return Utilities.formatDate(start, 'Europe/London', "EEE, d MMM yyyy 'at' HH:mm");
  const day = jobDay(t, created);
  if (day && !/as soon as possible|asap/i.test(t)) return Utilities.formatDate(new Date(day + 'T12:00:00Z'), 'Europe/London', 'EEE, d MMM yyyy');
  return t.slice(0, 60);
}
/* estimated delivery = time marked Collected + driving time collection -> delivery (minutes cached for 6 hours) */
function trackEta(ref, r) {
  const done = dateOf(r[DONE_C_COL - 1]);
  if (!done) return '';
  const cache = CacheService.getScriptCache(), key = 'eta_' + ref;
  let mins = Number(cache.get(key));
  if (!(mins > 0)) {
    try {
      const ga = geocodeUK(r[8]), gb = geocodeUK(r[9]);
      if (ga && gb) { const rt = routeMiles(ga.p, gb.p, ''); mins = Number(rt && rt.mins) || 0; }
    } catch (e) { mins = 0; }
    if (!(mins > 0)) return '';
    cache.put(key, String(Math.round(mins)), 21600);
  }
  const eta = new Date(done.getTime() + (mins + 10) * 60000);
  if (eta.getTime() < Date.now() - 30 * 60000) return '';   // well past the estimate: hide it rather than show a stale time
  const q = new Date(Math.ceil(eta.getTime() / 300000) * 300000);   // round up to 5 minutes
  return Utilities.formatDate(q, 'Europe/London', 'HH:mm');
}

/* ---------- website + driver app POST requests ---------- */
function doPost(e) {
  const out = ContentService.createTextOutput().setMimeType(ContentService.MimeType.JSON);
  const fail = () => out.setContent(JSON.stringify({ ok: false }));
  try {
    const d = JSON.parse(e.postData.contents);
    if (d.action === 'login') return handleLogin(d, out);
    if (d.action === 'change_password') return handleChangePassword(d, out);
    if (d.action === 'pod') return handlePod(d, out);
    if (d.action === 'jobs') return handleJobs(d, out);
    if (d.action === 'onway') return handleOnWay(d, out);
    if (d.action === 'arrived') return handleArrived(d, out);
    if (d.action === 'problem') return handleProblem(d, out);
    if (d.action === 'quote') return handleQuote(d, out);
    if (d.action === 'quote_answer') return handleQuoteAnswer(d, out);
    if (d.action === 'pay_start') return out.setContent(JSON.stringify(stripePayStart(d)));
    if (d.action === 'stripe_event') return out.setContent(JSON.stringify(stripeEventHandle()));
    if (d.action === 'details') return handleDetailsSave(d, out);
    if (d.action === 'review_submit') return handleReviewSubmit(d, out);
    if (d.action === 'reviews_list') return handleReviewsList(d, out);
    if (d.action === 'busy') return handleBusy(d, out);
    if (d.action === 'lead_submit') return handleLeadSubmit(d, out);
    if (/^client_/.test(String(d.action))) return handleClient(d, out);
    if (/^admin_/.test(String(d.action))) return handleAdmin(d, out);

    // contact form
    if (String(d.website || '').trim()) return out.setContent(JSON.stringify({ ok: true })); // spam bot: pretend OK
    const name = cleanText(d.name, 100), email = cleanText(d.email, 120), phone = ukPhone(d.phone);
    const message = String(d.message || '').trim().slice(0, 3000);
    if (!name || !message || !validEmail(email) || phone === null) return fail();

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const ss = SpreadsheetApp.getActive();
      let sh = ss.getSheetByName(MESSAGES_SHEET);
      if (!sh) {
        sh = ss.insertSheet(MESSAGES_SHEET);
        sh.appendRow(['Received', 'Name', 'Email', 'Phone', 'Message']);
      }
      sh.appendRow([new Date(), safeCell(name), safeCell(email), safeCell(phone), safeCell(message)]);
    } finally { lock.releaseLock(); }

    MailApp.sendEmail({
      to: OWNER_EMAIL,
      subject: 'Website message from ' + name,
      body: 'Name: ' + name + '\nEmail: ' + email + '\nPhone: ' + (phone || '-') + '\n\n' + message,
      replyTo: email,
      name: COMPANY + ' website'
    });
    return out.setContent(JSON.stringify({ ok: true }));
  } catch (err) {
    return fail();
  }
}

/* ---------- website quote request: adds a "Requested" row to Deliveries ---------- */
function handleQuote(d, out) {
  const send = o => out.setContent(JSON.stringify(o));
  try {
    if (String(d.website || '').trim()) return send({ ok: true }); // spam bot
    const ref = String(d.ref || '').trim();
    const name = cleanText(d.name, 100), email = cleanText(d.email, 120), phone = ukPhone(d.phone);
    const from = cleanText(d.from, 200), to = cleanText(d.to, 200);
    if (!/^PRJ-\d{6}-[A-Z2-9]{5}$/.test(ref) || !name || !from || !to || !validEmail(email) || phone === null) return send({ ok: false });
    const miles = cleanText(d.miles, 10), when = cleanText(d.when, 80), van = cleanText(d.van, 60);
    const load = cleanText(d.load, 300), est = cleanText(d.est, 40);
    // private customer or business (chosen on the website form): shows in the admin panel and pre-fills the delivery details form
    const ctype = d.ctype === 'Business' ? 'Business' : d.ctype === 'Private' ? 'Private' : '';
    const company = ctype === 'Business' ? cleanText(d.company, 100) : '';
    const who = ctype ? (ctype === 'Business' ? 'Business' + (company ? ': ' + company : '') : 'Private customer') : '';

    // private customers see an estimated price straight away (Settings > Prices > "Show the estimate"); businesses get a quote from us
    let estimate = '';
    if (ctype === 'Private' && props().getProperty('price_on_web') !== 'off') {
      try { const sp = suggestPrice(from, to, when, 'private'); if (sp && sp.ok) estimate = sp.priceText; } catch (e) {}
    }
    const estCell = estimate ? estimate + ' (shown to the customer)' : est;

    const cache = CacheService.getScriptCache();
    let already = false;
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
      const refs = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 1).getValues();
      for (let i = 0; i < refs.length; i++) if (String(refs[i][0]).trim() === ref) already = true; // clicked again: do not add a second row
      if (already) {
        if (!cache.get('ack_' + ref)) { // the customer has not had their confirmation yet
          try { sendQuoteAck(ref, name, email, from, to, when, load); cache.put('ack_' + ref, '1', 21600); } catch (e) { logError('Customer confirmation email failed for ' + ref + ': ' + e); }
        }
        return send({ ok: true });
      }
      if (sh.getLastRow() === 0) sh.appendRow(['Reference', 'Status', 'Updated', 'Note', 'Customer email', 'Proof of delivery', 'Last emailed', 'Received by', 'Collect from', 'Deliver to', 'Driver', 'Customer name', 'Phone', 'Collection', 'Vehicle', 'Load', 'Miles', 'Estimate', 'Price']);
      const row = [safeCell(ref), 'Requested', new Date(), '', safeCell(email), '', '', '', safeCell(from), safeCell(to), '',
        safeCell(name), safeCell(phone), safeCell(when), safeCell(van), safeCell(load), safeCell(miles), safeCell(estCell)];
      if (ctype) { while (row.length < 27) row.push(''); row.push(ctype, safeCell(company)); ensureDetailHeaders(sh); }
      sh.appendRow(row);
    } finally { lock.releaseLock(); }

    MailApp.sendEmail({
      to: OWNER_EMAIL,
      subject: 'New quote request ' + ref + ' from ' + name + (ctype === 'Business' ? ' (business)' : ''),
      body: 'Reference: ' + ref + '\nName: ' + name + (who ? '\nCustomer: ' + who : '') + '\nPhone: ' + (phone || '-') + '\nEmail: ' + email +
        '\n\nCollect from: ' + from + '\nDeliver to: ' + to + '\nDistance: ' + miles + ' miles\nCollection: ' + when +
        '\nVehicle: ' + van + '\nLoad: ' + load + (estimate ? '\nEstimated price shown to the customer: ' + estimate : est ? '\nEstimate (guide): ' + est : '') +
        '\n\nIt is in your Deliveries sheet with status "Requested". Change it to "Booked" to confirm it, add the driver in column K, and the customer gets an email.',
      replyTo: email,
      name: COMPANY + ' website'
    });
    try { sendQuoteAck(ref, name, email, from, to, when, load, estimate); cache.put('ack_' + ref, '1', 21600); } catch (e) { logError('Customer confirmation email failed for ' + ref + ': ' + e); }
    notifyPhones('🆕 New quote request ' + ref + '\n' + name + (phone ? ' · ' + phone : '') + (who ? '\n' + who : '') + '\n' + from + ' → ' + to +
      '\n' + (when ? when + '\n' : '') + (load ? load + '\n' : '') + (estimate ? 'Customer saw the estimate: ' + estimate + '\n' : est ? 'Estimate: ' + est + '\n' : '') + 'Open the admin panel to send the quote.');
    return send({ ok: true, estimate: estimate });
  } catch (err) {
    return send({ ok: false });
  }
}

/* Customer emails go out from OWNER_EMAIL (it must be added in Gmail > Settings > Accounts > Send mail as).
   If that is not possible, the email is sent from the Gmail account itself so the customer still gets it. */
function sendCustomerMail(o) {
  o = withBrandFooter(o);
  // Send "from" contact@ only if that address is set up as a "Send mail as" alias in this Gmail account.
  let canUseAlias = false;
  try { canUseAlias = GmailApp.getAliases().indexOf(OWNER_EMAIL) >= 0; } catch (e) {}
  if (canUseAlias) {
    try {
      GmailApp.sendEmail(o.to, o.subject, o.body, {
        htmlBody: o.htmlBody, from: OWNER_EMAIL, name: o.name, replyTo: o.replyTo, bcc: o.bcc || '',
        attachments: o.attachments || [], inlineImages: o.inlineImages || {}
      });
      return;
    } catch (e) {
      logError('Could not send from ' + OWNER_EMAIL + ', sent from the Gmail account instead: ' + e);
    }
  }
  MailApp.sendEmail(o);
}

/* Errors that do not stop a request are written to the "Log" sheet so you can see what went wrong */
function logError(msg) {
  try {
    const ss = SpreadsheetApp.getActive();
    let log = ss.getSheetByName('Log');
    if (!log) { log = ss.insertSheet('Log'); log.appendRow(['Time', 'Reference', 'Status', 'Driver', 'Photos']); }
    log.appendRow([new Date(), 'ERROR', String(msg).slice(0, 300), '', '']);
  } catch (e) {}
}

/* TEST: in the editor choose testQuoteAck and click Run. It sends the customer email to YOU (OWNER_EMAIL), from the contact@ address.
   Shows any error in the Execution log, and asks for mail permission if needed. */
function testQuoteAck() {
  sendQuoteAck('PRJ-000000-TEST2', 'Test Customer', OWNER_EMAIL, 'RG1 1AA Reading', 'B1 1AA Birmingham', 'Today', 'Small boxes');
  Logger.log('Sent to ' + OWNER_EMAIL);
}

/* Confirmation email to the customer right after they send a quote request */
function sendQuoteAck(ref, name, email, from, to, when, load, estimate) {
  const first = String(name).split(' ')[0];
  const html =
    '<div style="font-family:Arial,sans-serif;font-size:15px;color:#0E1726;max-width:560px">' +
    '<h2 style="margin:0 0 8px">Thank you for your enquiry</h2>' +
    '<p>Hello ' + esc(first) + ',</p>' +
    '<p>Thank you for your interest in ' + esc(COMPANY) + '. We have received your request and will get back to you with a price as soon as possible.</p>' +
    (estimate ? '<p style="background:#F3FAEA;border-radius:10px;padding:12px 14px"><b>Estimated price: ' + esc(estimate) + '</b><br><span style="font-size:13px;color:#5E6B7C">This estimate is based on the distance. We check every job and confirm the exact price by email before anything is booked.</span></p>' : '') +
    '<p><b>Your request</b><br>Reference: ' + esc(ref) + '<br>Collect from: ' + esc(from) + '<br>Deliver to: ' + esc(to) +
    '<br>Collection: ' + esc(when) + '<br>Load: ' + esc(load) + '</p>' +
    '<p>Nothing is booked yet. Once you accept our price, we will confirm your booking by email.</p>' +
    '<p>Need it urgently? Call us on ' + esc(PHONE) + ' or reply to this email.</p>' +
    '<p>Kind regards,<br>' + esc(COMPANY) + '</p>' + SPAM_NOTE_HTML + '</div>';
  sendCustomerMail({
    to: email,
    subject: 'We have received your request (' + ref + ')',
    htmlBody: html,
    body: 'Thank you for your interest in ' + COMPANY + '. We have received your request (' + ref + ') and will send you a price as soon as possible. Reply to this email or call ' + PHONE + ' with any questions.',
    replyTo: OWNER_EMAIL,
    name: COMPANY
  });
}

/* ---------- admin panel (admin.html): list, confirm, price, driver, new phone booking ---------- */
/* Run this from the editor (choose resetLockout, click Run) to clear the wrong-code lock right away */
function resetLockout() {
  CacheService.getScriptCache().removeAll(Object.keys(USERS).map(u => 'lf_' + u).concat(['lf_unknown']));
}

/* ---------- accounts: username + password -> signed session token ---------- */
function props() { return PropertiesService.getScriptProperties(); }
function toHex(bytes) { return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join(''); }
function hashPassword(salt, password) {
  let h = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + password);
  for (let i = 0; i < 2000; i++) h = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h.concat(Utilities.newBlob(salt).getBytes()));
  return toHex(h);
}
function secret() {
  let k = props().getProperty('secret');
  if (!k) { k = Utilities.getUuid() + Utilities.getUuid(); props().setProperty('secret', k); }
  return k;
}
function sign(text) { return toHex(Utilities.computeHmacSha256Signature(text, secret())); }
function makeToken(user) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const ver = props().getProperty('ver_' + user) || '1';
  const body = user + '.' + exp + '.' + ver;
  return body + '.' + sign(body);
}
function checkToken(key) {
  const parts = String(key || '').split('.');
  if (parts.length < 4) return null;
  const sig = parts.pop(), ver = parts.pop(), expText = parts.pop(), user = parts.join('.'); // the username may contain dots (an email address)
  const exp = Number(expText);
  if (!Object.prototype.hasOwnProperty.call(USERS, user) || !(exp > Date.now())) return null;
  if (ver !== (props().getProperty('ver_' + user) || '1')) return null; // password was changed: old sessions end
  if (sign(user + '.' + expText + '.' + ver) !== sig) return null;
  return user;
}
const LOGIN_AGAIN = 'Please log in again.';
function checkAuth(d) {
  const user = checkToken(d.key);
  if (user) return { ok: true, name: String(USERS[user].name), user: user };
  return { ok: false, message: LOGIN_AGAIN };
}
function checkAdmin(d) { return checkAuth(d); }
function checkKey(d) { return checkAuth(d); }

function setPassword(user, password) {
  if (!Object.prototype.hasOwnProperty.call(USERS, user)) throw new Error('Unknown user ' + user);
  if (String(password).length < 10) throw new Error('Password must be at least 10 characters.');
  const salt = Utilities.getUuid();
  props().setProperty('pw_' + user, salt + ':' + hashPassword(salt, String(password)));
  props().setProperty('ver_' + user, String(Number(props().getProperty('ver_' + user) || '1') + 1));
}
function verifyPassword(user, password) {
  const stored = props().getProperty('pw_' + user);
  if (!stored) return false;
  const salt = stored.split(':')[0];
  return hashPassword(salt, String(password)) === stored.slice(salt.length + 1);
}

function handleLogin(d, out) {
  const send = o => out.setContent(JSON.stringify(o));
  try {
    let user = String(d.username || '').trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(USER_ALIASES, user)) user = USER_ALIASES[user];
    const known = Object.prototype.hasOwnProperty.call(USERS, user);
    const cache = CacheService.getScriptCache();
    const ck = 'lf_' + (known ? user : 'unknown');
    const fails = Number(cache.get(ck) || 0);
    if (fails >= 10) return send({ ok: false, message: 'Too many wrong attempts. Try again in 10 minutes.' });
    if (known && String(d.password || '') && verifyPassword(user, d.password)) {
      cache.remove(ck);
      return send({ ok: true, token: makeToken(user), name: String(USERS[user].name) });
    }
    cache.put(ck, String(fails + 1), 600);
    return send({ ok: false, message: 'Wrong username or password.' });
  } catch (err) {
    return send({ ok: false, message: 'Could not log in.' });
  }
}

function handleChangePassword(d, out) {
  const send = o => out.setContent(JSON.stringify(o));
  try {
    const auth = checkAuth(d);
    if (!auth.ok) return send({ ok: false, message: auth.message });
    const cache = CacheService.getScriptCache(), ck = 'lf_' + auth.user;
    if (Number(cache.get(ck) || 0) >= 10) return send({ ok: false, message: 'Too many wrong attempts. Try again in 10 minutes.' });
    if (!verifyPassword(auth.user, d.oldPassword)) { cache.put(ck, String(Number(cache.get(ck) || 0) + 1), 600); return send({ ok: false, message: 'Current password is wrong.' }); }
    const np = String(d.newPassword || '');
    if (np.length < 10) return send({ ok: false, message: 'New password must be at least 10 characters.' });
    setPassword(auth.user, np);
    return send({ ok: true, token: makeToken(auth.user) });
  } catch (err) {
    return send({ ok: false, message: 'Could not change the password.' });
  }
}

/* RUN THIS ONCE from the editor to create the first passwords:
   1) type a temporary password (10+ characters) for each person below,
   2) choose setInitialPasswords in the function list and press Run,
   3) delete the passwords from the code again, and change them in the admin panel (Change password). */
function setInitialPasswords() {
  const temp = {
    'patryk.forgiel@gmail.com': '',   // type the temporary password between the quotes (10+ characters)
    'prjlogistics.ltd@gmail.com': ''
  };
  Object.keys(temp).forEach(u => { if (temp[u]) setPassword(u, temp[u]); });
  Logger.log('Passwords set for: ' + Object.keys(temp).filter(u => temp[u]).join(', '));
}

function newRef() {
  const c = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const z = n => ('0' + n).slice(-2), now = new Date();
  let r = '';
  for (let i = 0; i < 5; i++) r += c.charAt(Math.floor(Math.random() * c.length));
  return 'PRJ-' + String(now.getFullYear()).slice(2) + z(now.getMonth() + 1) + z(now.getDate()) + '-' + r;
}

function handleAdmin(d, out) {
  const send = o => out.setContent(JSON.stringify(o));
  try {
    const auth = checkAdmin(d);
    if (!auth.ok) return send({ ok: false, message: auth.message });
    const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
    const drivers = Object.keys(USERS).map(u => String(USERS[u].name));

    if (d.action === 'admin_suggest') {
      let from = cleanText(d.from, 200), to = cleanText(d.to, 200), when = cleanText(d.when, 80);
      let kind = d.kind === 'business' ? 'business' : d.kind === 'private' ? 'private' : '';
      if (d.ref) {
        const rows = sh.getDataRange().getValues();
        for (let i = 1; i < rows.length; i++) if (String(rows[i][0]).trim() === String(d.ref).trim()) {
          if (!from || !to) { from = cleanText(rows[i][8], 200); to = cleanText(rows[i][9], 200); when = cleanText(rows[i][13], 80); }
          if (!kind) kind = String(rows[i][27]) === 'Business' || /^Invoice/.test(String(rows[i][26] || '')) ? 'business' : 'private';
        }
      }
      if (!from || !to) return send({ ok: false, message: 'Add both addresses first.' });
      return send(suggestPrice(from, to, when, kind || 'private'));
    }

    if (d.action === 'admin_quick_quote') return send(quickQuote(d, auth.name));
    if (d.action === 'admin_companies') return send({ ok: true, companies: allCompanies() });
    if (d.action === 'admin_spend') return send({ ok: true, items: spendList(), categories: SPEND_CATS, people: Object.keys(USERS).map(u => String(USERS[u].name)) });
    if (d.action === 'admin_diary') {
      const inv = dinvMap(), names = Object.keys(USERS).map(u => String(USERS[u].name)), iss = {};
      names.forEach(n => { iss[n] = issuerOf(n); });
      return send({ ok: true, items: diaryList(d.month).map(x => Object.assign(x, { invoice: inv[x.id] || '' })), drivers: names, issuers: iss, clients: diaryClients(),
        invoices: dinvRows().sort((a, b) => String(b.created).localeCompare(String(a.created))).slice(0, 60), monthStats: (() => { try { return goalStats(sh.getDataRange().getValues(), Utilities.formatDate(new Date(), 'Europe/London', 'yyyy-MM')); } catch (e) { return null; } })() });
    }
    if (d.action === 'admin_company_forget') return send(forgetCompany(d.email));

    if (d.action === 'admin_export') {
      // one-time move to the Cloudflare server: all sheets and settings (incl. password hashes) for the logged-in owner
      const ss = SpreadsheetApp.getActive(), sheets = {};
      ['Deliveries', 'Reviews', 'Clients', 'Messages', 'Problems'].forEach(n => {
        const s = ss.getSheetByName(n);
        if (s && s.getLastRow() > 0) sheets[n] = s.getDataRange().getValues().map(r => r.map(v => v instanceof Date ? { $d: v.toISOString() } : v));
      });
      return send({ ok: true, sheets: sheets, props: props().getProperties() });
    }
    if (d.action === 'admin_clients') return send({ ok: true, clients: allClients() });
    if (d.action === 'admin_customer') return send(customerData(d.q));
    if (d.action === 'admin_client_save') return send(saveClientByAdmin(d));
    if (d.action === 'admin_client_delete') return send(deleteClientByAdmin(d));
    if (d.action === 'admin_reviews') return send({ ok: true, reviews: allReviews() });
    if (d.action === 'admin_review_set') return send(setReviewStatus(cleanText(d.id, 20), cleanText(d.status, 12)));
    if (d.action === 'admin_outreach') return send({ ok: true, items: allOutreach() });
    if (d.action === 'admin_invoices') return send({ ok: true, customers: invoiceCandidates(), settings: officeSettings() });
    if (d.action === 'admin_push_test') return send(pushTest(auth.name));
    if (d.action === 'admin_push_key') { const k = pushPublicKey(); return send(k ? { ok: true, key: k } : { ok: false, message: 'Phone notifications work only on the new server.' }); }

    if (d.action === 'admin_list') {
      const rows = sh.getDataRange().getValues();
      const load = dayLoadMap(rows, 0);
      const jobs = [];
      let probs = {};
      try { probs = problemsByRef(); } catch (e) {}
      const maxJobs = d.all ? 100000 : 150; // d.all: the Records tab (every job, for summaries and the Excel download)
      for (let i = rows.length - 1; i >= 1 && jobs.length < maxJobs; i--) {
        const r = rows[i];
        if (!String(r[0]).trim()) continue;
        jobs.push({
          ref: String(r[0]).trim(), status: String(r[1]).trim() || 'Booked', updated: r[2] ? new Date(r[2]).toISOString() : '',
          note: cleanText(r[3], 300), email: cleanText(r[4], 120), pod: cleanText(r[5], 300), by: cleanText(r[7], 100),
          from: cleanText(r[8], 200), to: cleanText(r[9], 200), driver: cleanText(r[10], 60),
          name: cleanText(r[11], 100), phone: cleanText(r[12], 40), when: cleanText(r[13], 80), van: cleanText(r[14], 60),
          load: cleanText(r[15], 300), miles: cleanText(r[16], 10), est: cleanText(r[17], 40), price: cleanText(r[18], 40),
          quoteSent: r[19] ? new Date(r[19]).toISOString() : '',
          quotedPrice: cleanText(r[21], 40), answer: cleanText(r[22], 20),
          answered: r[23] ? new Date(r[23]).toISOString() : '', comment: cleanText(r[24], 500),
          paymentLink: cleanText(r[25], 300), payment: cleanText(r[26], 30),
          details: detailsOf(r),
          ctype: cleanText(r[27], 20), company: cleanText(r[28], 100),
          remarks: cleanText(r[REMARKS_COL - 1], 300), podPdf: cleanText(r[POD_PDF_COL - 1], 300),
          day: jobDay(r[13], r[2]),
          onway: onWayText(r[ONWAY_COL - 1]), arrivedC: onWayText(r[ARRIVED_C_COL - 1]), arrivedD: onWayText(r[ARRIVED_D_COL - 1]),
          arrCAt: isoOf(r[ARRIVED_C_COL - 1]), arrDAt: isoOf(r[ARRIVED_D_COL - 1]), doneCAt: isoOf(r[DONE_C_COL - 1]), doneDAt: isoOf(r[DONE_D_COL - 1]),
          problems: probs[String(r[0]).trim().toUpperCase()] || [],
          reviewAsked: isoOf(r[REVIEW_ASK_COL - 1]), payReminded: isoOf(r[PAY_REMIND_COL - 1]), ckey: custKey(r[4], r[12]),
          past: (function () { const s = whenStart(r[13], r[2]); return !!(s && s.getTime() < Date.now()); })()
        });
      }
      let reviews = [];
      try { reviews = allReviews(); } catch (e) {}
      let notes = {};
      try { notes = allNotes(); } catch (e) {}
      try {
        const inv = invoiceMap();
        jobs.forEach(j => { if (inv[j.ref]) j.invoice = inv[j.ref]; });
      } catch (e) {}
      let monthStats = null;
      try { monthStats = goalStats(rows, Utilities.formatDate(new Date(), 'Europe/London', 'yyyy-MM')); } catch (e) {}
      return send({ ok: true, monthStats: monthStats, timeOff: timeOffList(), dayRoles: dayRolesAll(), localMaxMiles: LOCAL_MAX_MILES, jobs: jobs, drivers: drivers, statuses: STATUSES, who: auth.name, me: auth.user, people: Object.keys(USERS).filter(u => u !== auth.user).map(u => ({ user: u, name: String(USERS[u].name), login: String(USERS[u].login || u) })), capacity: DAY_LIMIT, load: load, reviews: reviews, notes: notes, settings: officeSettings() });
    }

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      if (d.action === 'admin_set_password') {
        // set a new password for the other person in the office (e.g. forgotten password); your own password confirms it
        let target = String(d.forUser || '').trim().toLowerCase();
        if (Object.prototype.hasOwnProperty.call(USER_ALIASES, target)) target = USER_ALIASES[target];
        if (!Object.prototype.hasOwnProperty.call(USERS, target)) return send({ ok: false, message: 'Unknown user.' });
        if (target === auth.user) return send({ ok: false, message: 'Use "Change password" for your own password.' });
        if (!verifyPassword(auth.user, d.myPassword)) return send({ ok: false, message: 'Your own password is wrong.' });
        const np = String(d.newPassword || '');
        if (np.length < 10) return send({ ok: false, message: 'The new password must be at least 10 characters.' });
        setPassword(target, np);
        CacheService.getScriptCache().remove('lf_' + target);
        try { logUpload('-', 'Password set for ' + USERS[target].name + ' by ' + auth.name, auth.name, 0); } catch (e) {}
        return send({ ok: true, name: String(USERS[target].name) });
      }
      if (d.action === 'admin_diary_save') return send(diarySave(d, auth.name));
      if (d.action === 'admin_diary_miles') return send(diaryFillMiles(d.ids));
      if (d.action === 'admin_diary_order') return send(diaryReorder(d));
      // damrade.html: one shared debt tracker for the people who can log in to the panel
      if (d.action === 'admin_damrade') {
        const raw = props().getProperty('damrade_state') || '', by = String(props().getProperty('damrade_by') || '').split('|');
        let state = null; try { state = raw ? JSON.parse(raw) : null; } catch (e) {}
        return send({ ok: true, who: auth.name, rev: Number(props().getProperty('damrade_rev') || 0), state: state, savedBy: by[0] || '', savedAt: Number(by[1]) || 0 });
      }
      if (d.action === 'admin_damrade_save') {
        const rev = Number(props().getProperty('damrade_rev') || 0), st = d.state;
        if (Number(d.rev) !== rev) { let cur = null; try { cur = JSON.parse(props().getProperty('damrade_state') || 'null'); } catch (e) {} return send({ ok: false, conflict: true, rev: rev, state: cur, savedBy: String(props().getProperty('damrade_by') || '').split('|')[0], message: 'Someone else saved first.' }); }
        if (!st || typeof st !== 'object' || !Array.isArray(st.debts) || !Array.isArray(st.events)) return send({ ok: false, message: 'Nothing to save.' });
        const txt = JSON.stringify(st);
        if (txt.length > 800000) return send({ ok: false, message: 'Too much data to save.' });
        props().setProperty('damrade_state', txt); props().setProperty('damrade_rev', String(rev + 1)); props().setProperty('damrade_by', auth.name + '|' + Date.now());
        return send({ ok: true, rev: rev + 1 });
      }
      if (d.action === 'admin_selfemp' || d.action === 'admin_selfemp_save') {   // the work calculator's private year (payslips, bank income): one per person, only they can read it
        const k = 'selfemp_' + String(auth.name).toLowerCase().replace(/[^a-z0-9]/g, ''), rev = Number(props().getProperty(k + '_rev') || 0);
        if (d.action === 'admin_selfemp') { let state = null; try { state = JSON.parse(props().getProperty(k) || 'null'); } catch (e) {} return send({ ok: true, who: auth.name, rev: rev, state: state }); }
        if (Number(d.rev) !== rev) { let cur = null; try { cur = JSON.parse(props().getProperty(k) || 'null'); } catch (e) {} return send({ ok: false, conflict: true, rev: rev, state: cur, message: 'Saved from another device first.' }); }
        const st = d.state; if (!st || typeof st !== 'object' || Array.isArray(st)) return send({ ok: false, message: 'Nothing to save.' });
        const txt = JSON.stringify(st); if (txt.length > 900000) return send({ ok: false, message: 'Too much data to save.' });
        props().setProperty(k, txt); props().setProperty(k + '_rev', String(rev + 1));
        return send({ ok: true, rev: rev + 1 });
      }
      if (d.action === 'admin_issuer_save') {   // your own details, or the other person's (asked to confirm first in the panel)
        const names = Object.keys(USERS).map(u => String(USERS[u].name)), target = d.for ? cleanText(d.for, 40) : auth.name;
        if (names.indexOf(target) < 0) return send({ ok: false, message: 'Choose whose details these are.' });
        if (target !== auth.name && !d.forOther) return send({ ok: false, needsConfirm: true, message: 'You are changing ' + target + "'s invoice details. Continue?" });
        return send(issuerSave(d, target));
      }
      if (d.action === 'admin_diary_invoice') return send(diaryInvoiceMake(d, auth.name));
      if (d.action === 'admin_diary_invoice_status') return send(diaryInvoiceStatus(d));
      if (d.action === 'admin_diary_invoice_add') return send(diaryInvoiceAdd(d, auth.name));
      if (d.action === 'admin_diary_invoice_delete') return send(diaryInvoiceDelete(d));
      if (d.action === 'admin_spend_save') return send(spendSave(d, auth.name));
      if (d.action === 'admin_spend_paid') return send(spendPaid(cleanText(d.id, 20), !!d.paid, auth.name));
      if (d.action === 'admin_spend_delete') return send(spendDelete(cleanText(d.id, 20)));
      if (d.action === 'admin_diary_delete') return send(diaryDelete(cleanText(d.id, 20)));
      if (d.action === 'admin_outreach_save') return send(outreachSave(d, auth.name));
      if (d.action === 'admin_outreach_bulk') return send(outreachBulk(d, auth.name));
      if (d.action === 'admin_outreach_delete') return send(outreachDelete(cleanText(d.id, 20)));
      if (d.action === 'admin_outreach_email') return send(outreachEmail(d, auth.name));
      if (d.action === 'admin_outreach_email_many') return send(outreachEmailMany(d, auth.name));
      if (d.action === 'admin_timeoff_save') return send(timeOffSave(d, auth.name));
      if (d.action === 'admin_day_role') return send(dayRoleSave(d));
      if (d.action === 'admin_details_save') return send(adminDetailsSave(sh, d, auth.name));
      if (d.action === 'admin_timeoff_delete') return send(timeOffDelete(d.id));
      if (d.action === 'admin_note_save') return send(saveNote(d.ckey, d.note, auth.name));   // d.key is the login token
      if (d.action === 'admin_settings') return send(saveOfficeSettings(d));
      if (d.action === 'admin_push_sub') return send(savePushSub(d.sub, auth.name));
      if (d.action === 'admin_invoice') return send(makeInvoice(d, auth.name));
      if (d.action === 'admin_invoice_status') return send(invoiceStatus(sh, d, auth.name));
      if (d.action === 'admin_pay_remind' || d.action === 'admin_review_ask') {
        const row = findJobRow(sh, d.ref);
        if (!row) return send({ ok: false, message: 'Job not found.' });
        const q = rowValues(sh, row, PAY_REMIND_COL);
        const em = String(q[4]).trim();
        if (!validEmail(em)) return send({ ok: false, message: 'This job has no customer email.' });
        if (d.action === 'admin_review_ask') {
          if (String(q[1]).trim() !== 'Delivered') return send({ ok: false, message: 'Ask for a review after the delivery.' });
          sendReviewAskMail(String(q[0]).trim(), cleanText(q[11], 100), em);
          sh.getRange(row, REVIEW_ASK_COL).setValue(new Date());
          return send({ ok: true, mail: 'review-sent' });
        }
        const pay = String(q[26]).trim(), pr = cleanText(q[18], 40) || cleanText(q[21], 40);
        if (pay === 'Paid' || pay === 'Refunded') return send({ ok: false, message: 'This job is already marked ' + pay + '.' });
        if (!pr) return send({ ok: false, message: 'Add the price first.' });
        if (['Booked', 'Collected', 'Delivered'].indexOf(String(q[1]).trim()) < 0) return send({ ok: false, message: 'Only confirmed jobs can get a payment reminder.' });
        const dd = dateOf(q[DONE_D_COL - 1]);
        sendPayReminderMail(String(q[0]).trim(), cleanText(q[11], 100), em, pr, cleanText(q[25], 300), /^Invoice/.test(pay), dd ? Utilities.formatDate(dd, 'Europe/London', 'd MMM yyyy') : '');
        sh.getRange(row, PAY_REMIND_COL).setValue(new Date());
        return send({ ok: true, mail: 'reminder-sent' });
      }
      if (d.action === 'admin_customer_erase') {
        if (d.confirm !== 'ERASE') return send({ ok: false, message: 'Type ERASE to confirm.' });
        return send(customerErase(d.q));
      }
      if (d.action === 'admin_delete_job') {
        // any job can be deleted (e.g. test jobs). A job that is not cancelled needs confirm: 'DELETE',
        // so a live booking is never removed by one click. Its photos and POD are deleted too.
        const ref = String(d.ref || '').trim();
        const vals = sh.getRange(1, 1, sh.getLastRow(), 2).getValues();
        for (let i = 1; i < vals.length; i++) {
          if (String(vals[i][0]).trim() === ref) {
            const st = String(vals[i][1]).trim();
            if (st !== 'Cancelled' && String(d.confirm || '') !== 'DELETE') return send({ ok: false, message: 'Type DELETE to confirm.' });
            let n = 0;
            try { const files = findFiles(ref); files.forEach(f => { try { f.setTrashed(true); n++; } catch (e) {} }); } catch (e) {}
            sh.deleteRow(i + 1);
            try { logUpload(ref, 'Job deleted by admin (was ' + (st || 'no status') + ')', 'admin', n); } catch (e) {}
            return send({ ok: true, photos: n });
          }
        }
        return send({ ok: false, message: 'Job not found.' });
      }
      if (d.action === 'admin_update') {
        const ref = String(d.ref || '').trim();
        const refs = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
        let row = 0;
        for (let i = 1; i < refs.length; i++) if (String(refs[i][0]).trim() === ref) { row = i + 1; break; }
        if (!row) return send({ ok: false, message: 'Job not found.' });
        const set = (col, v) => sh.getRange(row, col).setValue(safeCell(v));
        /* two drivers: before saving, check the driver is free at that time (another job, or time off) */
        const before = sh.getRange(row, 1, 1, 14).getValues()[0];
        const curDrv = cleanText(before[10], 60), curSt = String(before[1]).trim(), curWhen = cleanText(before[13], 80);
        const newDrv = d.driver !== undefined ? cleanText(d.driver, 60) : curDrv, newWhen = d.when !== undefined ? cleanText(d.when, 80) : curWhen;
        const newSt = d.status !== undefined ? String(d.status) : curSt;
        const drvChanged = newDrv && newDrv !== curDrv, gotJob = newDrv && ['Booked', 'Collected'].indexOf(newSt) >= 0 && (drvChanged || (newSt === 'Booked' && curSt !== 'Booked'));
        if (newDrv && !d.force && ['Cancelled', 'Delivered'].indexOf(newSt) < 0 && (drvChanged || newWhen !== curWhen || (newSt === 'Booked' && curSt !== 'Booked'))) {
          const clash = [driverClash(sh, row, newDrv, newWhen), roleWarnings(sh, row, newDrv, newWhen)].filter(Boolean).join('\n\n\u26A0 ');
          if (clash) return send({ ok: false, needsForce: true, clash: true, message: '\u26A0 ' + clash });
        }
        const tellDriver = () => { if (gotJob && newDrv !== auth.name) { try { const now = sh.getRange(row, 1, 1, 14).getValues()[0];
          pushTo(newDrv, '\uD83D\uDE90 New job for you: ' + (cleanText(now[13], 80) || 'time to agree'), cleanText(now[8], 80) + ' \u2192 ' + cleanText(now[9], 80) + ' (' + ref + ')'); } catch (e) {} } };
        // job details changed in the admin panel (address, collection time, vehicle, load), e.g. the customer gave a different address
        {
          const cur = sh.getRange(row, 1, 1, 16).getValues()[0], changed = [];
          const edit = (key, col, max, label, required) => {
            if (d[key] === undefined) return null;
            const v = cleanText(d[key], max);
            if (required && !v) return label + ' cannot be empty.';
            if (v !== cleanText(cur[col - 1], max)) { set(col, v); changed.push(label + ': ' + (cleanText(cur[col - 1], max) || '-') + ' \u2192 ' + (v || '-')); }
            return null;
          };
          const bad = edit('from', 9, 200, 'Collect from', true) || edit('to', 10, 200, 'Deliver to', true) || edit('when', 14, 80, 'Collection') || edit('van', 15, 60, 'Vehicle') || edit('load', 16, 300, 'Load');
          if (bad) return send({ ok: false, message: bad });
          if (changed.length) {
            if (changed.some(x => /^(Collect from|Deliver to)/.test(x))) set(17, '');   // old miles no longer apply
            try { if (String(cur[1]).trim() === 'Booked') { ensureBusy(sh, row, rowValues(sh, row, BUSY_COL), true); CacheService.getScriptCache().removeAll(busyCacheKeys()); } } catch (e) { logError('Busy time: ' + e); }
            try { logUpload(ref, 'Changed in admin: ' + changed.join('; ').slice(0, 400), auth.name, 0); } catch (e) {}
          }
        }
        if (d.price !== undefined) set(19, cleanText(d.price, 40));
        if (d.note !== undefined) set(4, cleanText(d.note, 300));
        if (d.driver !== undefined) {
          const dn = cleanText(d.driver, 60);
          if (dn && drivers.indexOf(dn) < 0) return send({ ok: false, message: 'Unknown driver.' });
          set(11, dn);
        }
        if (d.payment !== undefined || d.paymentLink !== undefined) ensurePayHeaders(sh);
        if (d.payment !== undefined) {
          const p = String(d.payment).trim();
          if (p && PAY_STATUSES.indexOf(p) < 0) return send({ ok: false, message: 'Unknown payment status.' });
          set(27, p);
          try { syncInvoicePaid(sh, ref); } catch (e) {}
        }
        if (d.paymentLink !== undefined) {
          const l = String(d.paymentLink).trim();
          if (l && !/^https:\/\/[^\s<>"']{4,280}$/.test(l)) return send({ ok: false, message: 'The payment link must start with https://' });
          set(26, l);
        }
        if (d.sendPayment || d.sendRefund) {
          const q = sh.getRange(row, 1, 1, 27).getValues()[0];
          const st = String(q[1]).trim(), em = String(q[4]).trim(), pr = cleanText(q[18], 40), lk = cleanText(q[25], 300), pay = cleanText(q[26], 30);
          if (!validEmail(em)) return send({ ok: true, mail: 'no-email' });
          if (!pr) return send({ ok: false, message: 'Add the price first.' });
          if (d.sendPayment) {
            if (MAIL_STATUSES.indexOf(st) < 0) return send({ ok: false, message: 'Confirm the booking first. The payment link is sent only after the booking is confirmed.' });
            if (!lk) return send({ ok: false, message: 'Paste the payment link first.' });
            if (pay === 'Paid' || pay === 'Refunded') return send({ ok: false, message: 'This job is already marked ' + pay + '.' });
            sendPaymentMail(String(q[0]).trim(), cleanText(q[11], 100), em, cleanText(q[8], 200), cleanText(q[9], 200), cleanText(q[13], 80), pr, lk);
            if (!pay) set(27, 'Unpaid');
            sh.getRange(row, 3).setValue(new Date());
            return send({ ok: true, mail: 'payment-sent' });
          }
          sendRefundMail(String(q[0]).trim(), cleanText(q[11], 100), em, pr);
          set(27, 'Refunded');
          sh.getRange(row, 3).setValue(new Date());
          return send({ ok: true, mail: 'refund-sent' });
        }
        let mail = '';
        if (d.sendQuote) {
          const q = sh.getRange(row, 1, 1, 19).getValues()[0];
          const qPrice = cleanText(q[18], 40), qEmail = String(q[4]).trim();
          if (!qPrice) return send({ ok: false, message: 'Add the price first.' });
          if (!validEmail(qEmail)) return send({ ok: true, mail: 'no-email' });
          const token = Utilities.getUuid().replace(/-/g, '');
          sendQuoteMail(String(q[0]).trim(), cleanText(q[11], 100), qEmail, cleanText(q[8], 200), cleanText(q[9], 200),
            cleanText(q[13], 80), cleanText(q[15], 300), qPrice, cleanText(q[3], 300), token);
          if (!sh.getRange(1, 20).getValue()) sh.getRange(1, 20).setValue('Quote sent');
          if (!sh.getRange(1, 21).getValue()) sh.getRange(1, 21, 1, 5).setValues([['Quote token', 'Quoted price', 'Customer answer', 'Answered', 'Customer comment']]);
          sh.getRange(row, 20).setValue(new Date());
          sh.getRange(row, 21, 1, 5).setValues([[token, qPrice, '', '', '']]); // new quote: any earlier answer no longer counts
          sh.getRange(row, 3).setValue(new Date());
          return send({ ok: true, mail: 'quote-sent' });
        }
        if (d.status !== undefined) {
          const st = String(d.status);
          if (STATUSES.indexOf(st) < 0) return send({ ok: false, message: 'Unknown status.' });
          if (st === 'Booked' && String(sh.getRange(row, 2).getValue()).trim() !== 'Booked' && !d.force) {
            const all = sh.getDataRange().getValues(), cur = all[row - 1];
            const startAt = whenStart(cur[13], cur[2]);
            if (startAt && startAt.getTime() < Date.now()) return send({ ok: false, needsForce: true, message: 'The collection time (' + cleanText(cur[13], 80) + ') has already passed. Agree a new time with the customer first (and change it in column N), or confirm anyway if you have already agreed it.' });
            const day = jobDay(cur[13], cur[2]);
            const used = day ? (dayLoadMap(all, row)[day] || 0) : 0;
            if (day && used + 1 > DAY_LIMIT) return send({ ok: false, needsForce: true, message: capacityMessage(day, used) });
          }
          sh.getRange(row, 2).setValue(st);
          sh.getRange(row, 3).setValue(new Date());
          markDone(sh, row, st);
          if (st === 'Cancelled' || st === 'Requested') sh.getRange(row, 7).setValue(''); // allows a later re-send
          if (st === 'Booked') { try { ensureBusy(sh, row, rowValues(sh, row, BUSY_COL), true); CacheService.getScriptCache().removeAll(busyCacheKeys()); } catch (e) { logError('Busy time: ' + e); } }
          if (st === 'Cancelled') { try { CacheService.getScriptCache().removeAll(busyCacheKeys()); } catch (e) {} }
          mail = processRow(sh, row, null, cleanText(sh.getRange(row, 11).getValue(), 60));
        } else sh.getRange(row, 3).setValue(new Date());
        tellDriver();   // only after everything was saved
        return send({ ok: true, mail: mail });
      }

      if (d.action === 'admin_create') {
        const name = cleanText(d.name, 100), email = cleanText(d.email, 120);
        const from = cleanText(d.from, 200), to = cleanText(d.to, 200);
        if (!name || !from || !to || (email && !validEmail(email))) return send({ ok: false, message: 'Name, collect from and deliver to are required. Check the email address.' });
        if (d.confirm && !d.force) {
          const day = jobDay(cleanText(d.when, 80), new Date());
          if (day) {
            const used = dayLoadMap(sh.getDataRange().getValues(), 0)[day] || 0;
            if (used + 1 > DAY_LIMIT) return send({ ok: false, needsForce: true, message: capacityMessage(day, used) });
          }
        }
        const ref = newRef();
        sh.appendRow([ref, 'Requested', new Date(), '', safeCell(email), '', '', '', safeCell(from), safeCell(to), '',
          safeCell(name), safeCell(cleanText(d.phone, 40)), safeCell(cleanText(d.when, 80)), safeCell(cleanText(d.van, 60)),
          safeCell(cleanText(d.load, 300)), '', '', safeCell(cleanText(d.price, 40))]);
        let mail = '';
        if (d.confirm) {
          const row = sh.getLastRow();
          sh.getRange(row, 2).setValue('Booked');
          mail = processRow(sh, row, null, '');
        }
        return send({ ok: true, ref: ref, mail: mail });
      }
      return send({ ok: false, message: 'Unknown action.' });
    } finally { lock.releaseLock(); }
  } catch (err) {
    return send({ ok: false, message: 'Something went wrong.' });
  }
}

/* ---------- driver app: saves photos, updates the sheet, emails the customer ---------- */
function handlePod(d, out) {
  const reply = (ok, msg, extra) =>
    out.setContent(JSON.stringify(Object.assign({ ok: ok, message: msg || '' }, extra || {})));
  try {
    const auth = checkKey(d);
    if (!auth.ok) return reply(false, auth.message);
    const ref = String(d.ref || '').trim().toUpperCase();
    const status = String(d.status || '');
    if (!/^[A-Z0-9-]{6,30}$/.test(ref)) return reply(false, 'Check the reference number.');
    if (['Collected', 'Delivered'].indexOf(status) < 0) return reply(false, 'Choose Collected or Delivered.');
    const photos = Array.isArray(d.photos) ? d.photos.slice(0, 8) : [];
    if (!photos.length) return reply(false, 'Add at least one photo.');

    // The driver app can resend after a bad signal. The same upload id is only processed once.
    const reqId = String(d.id || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 60);
    const seen = CacheService.getScriptCache();

    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      if (reqId && seen.get('pod_' + reqId)) return reply(true, 'Already received.', { emailed: false });
      const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
      const rows = sh.getDataRange().getValues();
      let row = 0;
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][0]).trim().toUpperCase() === ref) { row = i + 1; break; }
      }
      if (!row) return reply(false, 'Reference not found in the sheet. Add the job to the sheet first.');

      const typed = cleanText(d.email, 120);
      if (!validEmail(rows[row - 1][4]) && validEmail(typed)) sh.getRange(row, 5).setValue(safeCell(typed));

      const folder = getPodFolder();
      const stamp = Utilities.formatDate(new Date(), 'Europe/London', 'yyyyMMdd-HHmm');
      const saved = [], photoBytes = [];
      photos.forEach((p, i) => {
        const m = /^data:image\/jpeg;base64,([A-Za-z0-9+\/=]+)$/.exec(String(p));
        if (!m || m[1].length > 5000000) return;
        const bytes = Utilities.base64Decode(m[1]);
        photoBytes.push(bytes);
        const blob = Utilities.newBlob(bytes, 'image/jpeg',
          ref + '-' + status + '-' + stamp + '-' + (i + 1) + '.jpg');
        saved.push(folder.createFile(blob));
      });
      if (!saved.length) return reply(false, 'The photos could not be read. Please try again.');

      sh.getRange(row, 2).setValue(status);
      sh.getRange(row, 3).setValue(new Date());
      markDone(sh, row, status, d.at);
      const note = cleanText(d.note, 200);
      if (note) sh.getRange(row, 4).setValue(safeCell(note));
      const by = cleanText(d.receivedBy, 80);
      if (by) sh.getRange(row, 8).setValue(safeCell(by));
      sh.getRange(row, 7).setValue(''); // allows a new email for this status
      sh.getRange(row, 11).setValue(auth.name);
      logUpload(ref, status, auth.name, saved.length);
      try {   // tell the office (not the driver who did it) on their phones
        const jr = rows[row - 1];
        notifyPhones((status === 'Delivered' ? '✅ ' + auth.name + ' delivered ' : '📦 ' + auth.name + ' collected ') + ref +
          '\n' + (cleanText(jr[28], 100) || cleanText(jr[11], 100)) + ' · ' + (areaOf(jr[8]) || cleanText(jr[8], 80)) + ' → ' + (areaOf(jr[9]) || cleanText(jr[9], 80)) +
          (status === 'Delivered' && by ? '\nReceived by ' + by : '') + (note ? '\n' + note : ''), auth.name);
      } catch (e) {}

      if (status === 'Delivered') {
        // signed proof of delivery: signature + remarks from the driver app, saved as a PDF next to the photos
        const remarks = cleanText(d.remarks, 300);
        if (remarks) { if (!sh.getRange(1, REMARKS_COL).getValue()) sh.getRange(1, REMARKS_COL, 1, 2).setValues([['Remarks at delivery', 'Signed POD (PDF)']]); sh.getRange(row, REMARKS_COL).setValue(safeCell(remarks)); }
        const sm = /^data:image\/jpeg;base64,([A-Za-z0-9+\/=]+)$/.exec(String(d.signature || ''));
        try {
          const r = rowValues(sh, row, DONE_D_COL), fmtT = v => { const t = dateOf(v); return t ? Utilities.formatDate(t, 'Europe/London', 'd MMM yyyy, HH:mm') : ''; };
          const bytes = buildPodPdf({
            ref: ref, customer: cleanText(r[11], 100), company: cleanText(r[28], 100), from: cleanText(r[8], 200), to: cleanText(r[9], 200),
            load: cleanText(r[15], 300), driver: auth.name, collectedAt: fmtT(r[DONE_C_COL - 1]), arrivedAt: fmtT(r[ARRIVED_D_COL - 1]),
            deliveredAt: fmtT(r[DONE_D_COL - 1]) || fmtT(new Date()), receivedBy: by, remarks: remarks,
            signature: sm && sm[1].length < 600000 ? Utilities.base64Decode(sm[1]) : null, photos: photoBytes
          });
          const pdfFile = folder.createFile(Utilities.newBlob(bytes, 'application/pdf', ref + '-Delivered-' + stamp + (sm ? '-POD-signed.pdf' : '-POD.pdf')));
          saved.push(pdfFile);
          if (!sh.getRange(1, POD_PDF_COL).getValue()) sh.getRange(1, REMARKS_COL, 1, 2).setValues([['Remarks at delivery', 'Signed POD (PDF)']]);
          sh.getRange(row, POD_PDF_COL).setValue(pdfFile.getUrl());
        } catch (e) { logError('Proof of delivery PDF failed for ' + ref + ': ' + e); }
      }

      const result = processRow(sh, row, saved, auth.name);
      if (reqId) seen.put('pod_' + reqId, '1', 21600);
      if (result === 'sent') return reply(true, 'Saved and sent to the customer.', { emailed: true });
      if (result === 'no-email') return reply(true, 'Saved. There is no customer email in the sheet, so nothing was sent.', { emailed: false });
      return reply(true, 'Saved.', { emailed: false });
    } finally { lock.releaseLock(); }
  } catch (err) {
    return reply(false, 'Something went wrong. Please try again.');
  }
}

/* Driver code check with a lockout after 10 wrong tries. Returns {ok, name} or {ok:false, message}. */
/* Driver app: open jobs for this driver (assigned to them, or not assigned yet), their own first.
   Shows what the driver needs on the road: full addresses, time, load, customer name and phone. */
function handleJobs(d, out) {
  const send = o => out.setContent(JSON.stringify(o));
  try {
    const auth = checkKey(d);
    if (!auth.ok) return send({ ok: false, message: auth.message });
    const rows = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME).getDataRange().getValues();
    const mine = [], open = [];
    for (let i = rows.length - 1; i >= 1; i--) {
      const r = rows[i];
      const ref = String(r[0]).trim(), st = String(r[1]).trim();
      if (!ref || st === 'Delivered' || st === 'Cancelled' || st === 'Requested') continue;
      const drv = cleanText(r[10], 60);
      if (drv && drv !== auth.name) continue; // belongs to another driver
      const job = {
        ref: ref, status: st || 'Booked', mine: drv === auth.name,
        from: cleanText(r[8], 200), to: cleanText(r[9], 200), when: cleanText(r[13], 80), load: cleanText(r[15], 300),
        name: cleanText(r[11], 100), phone: cleanText(r[12], 40), note: cleanText(r[3], 300),
        details: detailsOf(r), onway: onWayText(r[ONWAY_COL - 1]),
        arrivedC: onWayText(r[ARRIVED_C_COL - 1]), arrivedD: onWayText(r[ARRIVED_D_COL - 1]),
        arrCAt: isoOf(r[ARRIVED_C_COL - 1]), arrDAt: isoOf(r[ARRIVED_D_COL - 1]), doneCAt: isoOf(r[DONE_C_COL - 1]), doneDAt: isoOf(r[DONE_D_COL - 1]),
        problem: cleanText(r[PROBLEM_COL - 1], 300),
        now: new Date().toISOString()
      };
      (job.mine ? mine : open).push(job);
    }
    return send({ ok: true, jobs: mine.slice(0, 30).concat(open.slice(0, 30)), driver: auth.name });
  } catch (err) {
    return send({ ok: false, message: 'Could not load jobs.' });
  }
}

/* ===================== signed Proof of Delivery (PDF) =====================
   The driver app sends the customer's signature (a JPEG drawn with a finger) with the delivery photos.
   The PDF is built by hand (no Google-only tools), so it works the same on Google and on Cloudflare.
   It is attached to the "delivered" email, linked in the admin panel (column AV) and deleted with the photos after 12 months. */
const REMARKS_COL = 47;      // column AU: condition / remarks written at delivery, before signing
const POD_PDF_COL = 48;      // column AV: link to the signed proof of delivery PDF
const POD_LOGO_JPG = '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';
function pdfBytesOf(arr) { const out = new Array(arr.length); for (let i = 0; i < arr.length; i++) out[i] = arr[i] & 255; return out; }
function pdfAscii(str) {
  str = String(str == null ? '' : str).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/→/g, '->').replace(/·/g, '-').replace(/ł/g, 'l').replace(/Ł/g, 'L');
  try { str = str.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) {}
  return str;
}
function pdfStr(str) {
  str = pdfAscii(str);
  let o = '';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 92 || c === 40 || c === 41) o += '\\' + str[i];
    else if (c >= 32 && c < 127) o += str[i];
    else if (c === 163) o += '\\243';
    else o += '?';
  }
  return o;
}
function pdfWrap(text, width, size, bold) {
  const cw = size * (bold ? 0.58 : 0.53), max = Math.max(8, Math.floor(width / cw)), out = [];
  String(text || '').split(/\n/).forEach(par => {
    let line = '';
    pdfAscii(par).split(/\s+/).forEach(w => {
      while (w.length > max) { if (line) { out.push(line); line = ''; } out.push(w.slice(0, max)); w = w.slice(max); }
      if (!w) return;
      if ((line ? line.length + 1 : 0) + w.length > max) { out.push(line); line = w; } else line = line ? line + ' ' + w : w;
    });
    out.push(line);
  });
  return out.filter((l, i, a) => l !== '' || (i > 0 && i < a.length - 1));
}
function jpegInfo(b) {
  if (!b || b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xFF) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8], comps: b[i + 9] };
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return null;
}
/* o = {ref, customer, company, from, to, load, when, driver, collectedAt, arrivedAt, deliveredAt, receivedBy, remarks, signature (bytes), photos ([bytes])} */
function buildPodPdf(o) {
  const W = 595, H = 842, M = 40;
  const imgs = [];   // {name, bytes, info}
  const addImg = bytes => { const b = pdfBytesOf(bytes || []), info = jpegInfo(b); if (!info) return null; const name = 'Im' + (imgs.length + 1); imgs.push({ name: name, bytes: b, info: info }); return imgs[imgs.length - 1]; };
  const ops = [];
  const T = (x, y, size, bold, color, str) => ops.push('BT /' + (bold ? 'F2' : 'F1') + ' ' + size + ' Tf ' + color + ' rg ' + x.toFixed(1) + ' ' + (H - y).toFixed(1) + ' Td (' + pdfStr(str) + ') Tj ET');
  const R = (x, y, w, h, color) => ops.push(color + ' rg ' + x.toFixed(1) + ' ' + (H - y - h).toFixed(1) + ' ' + w.toFixed(1) + ' ' + h.toFixed(1) + ' re f');
  const S = (x, y, w, h) => ops.push('0.80 0.83 0.86 RG 0.8 w ' + x.toFixed(1) + ' ' + (H - y - h).toFixed(1) + ' ' + w.toFixed(1) + ' ' + h.toFixed(1) + ' re S');
  const D = (img, x, y, w, h) => ops.push('q ' + w.toFixed(1) + ' 0 0 ' + h.toFixed(1) + ' ' + x.toFixed(1) + ' ' + (H - y - h).toFixed(1) + ' cm /' + img.name + ' Do Q');
  const INK = '0.055 0.090 0.149', GREY = '0.40 0.45 0.52', WHITE = '1 1 1', GREEN = '0.467 0.718 0.169', NAVY = '0.016 0.047 0.094';
  // header band
  R(0, 0, W, 92, NAVY); R(0, 92, W, 4, GREEN);
  const logo = addImg(Utilities.base64Decode(POD_LOGO_JPG));
  if (logo) D(logo, 26, 12, 68 * logo.info.w / logo.info.h, 68);
  T(W - M - 214, 44, 20, true, WHITE, 'PROOF OF DELIVERY');
  T(W - M - 214, 66, 11, false, '0.79 0.83 0.88', 'Reference ' + o.ref);
  let y = 126;
  const field = (x, w, label, value) => { T(x, y, 8, true, GREY, String(label).toUpperCase()); const lines = pdfWrap(value || '-', w, 11, false); lines.forEach((l, i) => T(x, y + 16 + i * 14, 11, false, INK, l)); return 16 + lines.length * 14; };
  const row = (a, b) => { const h1 = field(M, 245, a[0], a[1]), h2 = b ? field(310, 245, b[0], b[1]) : 0; y += Math.max(h1, h2) + 12; };
  row(['Delivered', o.deliveredAt], ['Collected', o.collectedAt]);
  row(['Customer', [o.customer, o.company].filter(String).join(', ')], ['Driver', o.driver]);
  row(['Collect from', o.from], ['Deliver to', o.to]);
  row(['Load', o.load], ['Arrived at delivery', o.arrivedAt]);
  R(M, y - 4, W - 2 * M, 0.8, '0.86 0.89 0.84'); y += 14;
  row(['Received by', o.receivedBy], ['Condition / remarks at delivery', o.remarks || 'None']);
  // signature
  T(M, y, 8, true, GREY, 'SIGNATURE');
  const sig = addImg(o.signature);
  S(M, y + 8, 260, 96);
  if (sig) { const sc = Math.min(252 / sig.info.w, 88 / sig.info.h); D(sig, M + 4 + (252 - sig.info.w * sc) / 2, y + 12 + (88 - sig.info.h * sc) / 2, sig.info.w * sc, sig.info.h * sc); }
  else T(M + 12, y + 60, 10, false, GREY, 'No signature taken');
  T(310, y + 30, 10, false, INK, 'Signed by: ' + (o.receivedBy || '-'));
  T(310, y + 48, 10, false, INK, 'Date and time: ' + (o.deliveredAt || '-'));
  pdfWrap('By signing, the receiver confirms the goods above were delivered. Any damage or missing items are noted under remarks.', 245, 8.5, false)
    .forEach((l, i) => T(310, y + 70 + i * 11, 8.5, false, GREY, l));
  y += 124;
  // photos
  const pics = (o.photos || []).slice(0, 3).map(addImg).filter(Boolean);
  if (pics.length && y < H - 120) {
    T(M, y, 8, true, GREY, 'PHOTOS AT DELIVERY'); y += 10;
    const room = H - 70 - y, slot = (W - 2 * M - 20) / 3;
    pics.forEach((im, i) => { const sc = Math.min(slot / im.info.w, Math.min(170, room) / im.info.h); D(im, M + i * (slot + 10), y, im.info.w * sc, im.info.h * sc); });
  }
  // footer
  R(0, H - 44, W, 44, '0.96 0.97 0.95');
  T(M, H - 26, 7.5, false, GREY, COMPANY_LEGAL);
  T(M, H - 14, 7.5, false, GREY, 'contact@prjlogistics.co.uk - ' + PHONE + ' - prjlogistics.co.uk');
  // assemble
  const parts = [], offsets = [];
  let len = 0;
  const enc = str => { const a = new Array(str.length); for (let i = 0; i < str.length; i++) a[i] = str.charCodeAt(i) & 255; return a; };
  const push = a => { parts.push(a); len += a.length; };
  const content = ops.join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + W + ' ' + H + '] /Contents 6 0 R /Resources << /Font << /F1 4 0 R /F2 5 0 R >> /XObject << ' +
      imgs.map((im, i) => '/' + im.name + ' ' + (7 + i) + ' 0 R').join(' ') + ' >> >> >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    { dict: '<< /Length ' + content.length + ' >>', data: enc(content) }
  ];
  imgs.forEach(im => objs.push({ dict: '<< /Type /XObject /Subtype /Image /Width ' + im.info.w + ' /Height ' + im.info.h + ' /ColorSpace /' +
    (im.info.comps === 1 ? 'DeviceGray' : im.info.comps === 4 ? 'DeviceCMYK' : 'DeviceRGB') + ' /BitsPerComponent 8 /Filter /DCTDecode /Length ' + im.bytes.length + ' >>', data: im.bytes }));
  push(enc('%PDF-1.4\n%âãÏÓ\n'));
  objs.forEach((ob, i) => {
    offsets.push(len);
    if (typeof ob === 'string') push(enc((i + 1) + ' 0 obj\n' + ob + '\nendobj\n'));
    else { push(enc((i + 1) + ' 0 obj\n' + ob.dict + '\nstream\n')); push(ob.data); push(enc('\nendstream\nendobj\n')); }
  });
  const xref = len;
  let x = 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
  offsets.forEach(off => { x += ('0000000000' + off).slice(-10) + ' 00000 n \n'; });
  x += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  push(enc(x));
  const out = new Array(len);
  let k = 0;
  parts.forEach(a => { for (let i = 0; i < a.length; i++) out[k++] = a[i] > 127 ? a[i] - 256 : a[i]; });
  return out;   // signed bytes, as Utilities.newBlob expects
}

/* ===================== personal data: keep it only as long as it is needed =====================
   Runs every night (installTrigger sets this up; on Cloudflare a Cron Trigger does it):
   - quotes that never became a job (Requested, or Cancelled without payment): deleted after 6 months
   - finished jobs older than 12 months: customer phone/email, the people at the addresses, notes and the photo link removed;
     name, company, invoice details, price and dates stay for the accounts
   - every job: deleted after 6 years (HMRC record keeping)
   - photos (proof of delivery and problem reports): deleted after 12 months
   - problem reports: deleted after 2 years; website messages: deleted after 12 months
   Reviews and client accounts are kept until you delete them. */
const KEEP = { requestsMonths: 6, contactsMonths: 12, photosMonths: 12, problemsMonths: 24, messagesMonths: 12, jobsMonths: 72 };
function monthsAgo(n) { const d = new Date(); d.setMonth(d.getMonth() - n); return d; }
function dateOf(v) { if (!v) return null; const d = v instanceof Date ? v : new Date(v); return isNaN(d.getTime()) ? null : d; }
/* a job that is part of the accounts: paid, invoiced, refunded, or carried out */
function inAccounts(r) {
  const st = String(r[1]).trim(), pay = String(r[26]).trim();
  return /^(Paid|Invoice|Refunded)/.test(pay) || st === 'Collected' || st === 'Delivered';
}
function postcodeOnly(s) {
  const m = String(s || '').toUpperCase().match(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/);
  return m ? m[0].replace(/\s+/, ' ').replace(/^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})$/, '$1 $2') : '';
}
/* removes contact details from a finished job, keeps what the accounts need */
function trimJobRow(sh, row, full) {
  sh.getRange(row, 5).setValue('');                 // E customer email
  sh.getRange(row, 6).setValue('');                 // F photo link
  sh.getRange(row, 8).setValue('');                 // H received by
  sh.getRange(row, 13).setValue('');                // M phone
  sh.getRange(row, 25).setValue('');                // Y customer comment
  sh.getRange(row, 32, 1, 6).setValues([['', '', '', '', '', '']]); // AF-AK people at the addresses, phones, notes
  sh.getRange(row, REMARKS_COL, 1, 2).setValues([['', '']]);      // AU-AV remarks, signed POD link (the PDF itself goes with the photos)
  if (full) {                                       // erasure request: addresses cut down to the postcode
    const v = sh.getRange(row, 9, 1, 2).getValues()[0];
    sh.getRange(row, 9, 1, 2).setValues([[postcodeOnly(v[0]), postcodeOnly(v[1])]]);
    sh.getRange(row, 4).setValue('Personal data erased ' + Utilities.formatDate(new Date(), 'Europe/London', 'd MMM yyyy'));
  }
}
function cleanUpOldData() {
  const ss = SpreadsheetApp.getActive(), out = { deleted: 0, trimmed: 0, problems: 0, messages: 0, photos: 0 };
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = ss.getSheetByName(SHEET_NAME);
    if (sh && sh.getLastRow() > 1) {
      const rows = sh.getDataRange().getValues();
      const reqCut = monthsAgo(KEEP.requestsMonths), conCut = monthsAgo(KEEP.contactsMonths), jobCut = monthsAgo(KEEP.jobsMonths);
      for (let i = rows.length - 1; i >= 1; i--) {
        const r = rows[i];
        if (!String(r[0]).trim()) continue;
        const d = dateOf(r[2]);
        if (!d) continue;
        const st = String(r[1]).trim();
        if (d < jobCut || (d < reqCut && (st === 'Requested' || st === 'Cancelled') && !inAccounts(r))) { sh.deleteRow(i + 1); out.deleted++; continue; }
        if (d < conCut && (st === 'Delivered' || st === 'Cancelled') && [4, 5, 7, 12, 24, 31, 32, 33, 34, 35, 36, REMARKS_COL - 1, POD_PDF_COL - 1].some(k => String(r[k] || '') !== '')) {
          trimJobRow(sh, i + 1, false); out.trimmed++;
        }
      }
    }
    const pr = ss.getSheetByName(PROBLEMS_SHEET);
    if (pr && pr.getLastRow() > 1) {
      const rows = pr.getDataRange().getValues(), cut = monthsAgo(KEEP.problemsMonths);
      for (let i = rows.length - 1; i >= 1; i--) { const d = dateOf(rows[i][0]); if (d && d < cut) { pr.deleteRow(i + 1); out.problems++; } }
    }
    const ms = ss.getSheetByName(MESSAGES_SHEET);
    if (ms && ms.getLastRow() > 1) {
      const rows = ms.getDataRange().getValues(), cut = monthsAgo(KEEP.messagesMonths);
      for (let i = rows.length - 1; i >= 1; i--) { const d = dateOf(rows[i][0]); if (d && d < cut) { ms.deleteRow(i + 1); out.messages++; } }
    }
  } finally { lock.releaseLock(); }
  try { out.photos = cleanUpOldPhotos(); } catch (e) { logError('Photo clean-up: ' + e); }
  if (out.deleted + out.trimmed + out.problems + out.messages + out.photos) {
    try { logUpload('-', 'Data clean-up: ' + out.deleted + ' old jobs/quotes deleted, ' + out.trimmed + ' trimmed, ' + out.problems + ' problem reports, ' + out.messages + ' messages', 'automatic', out.photos); } catch (e) {}
  }
  return out;
}
function cleanUpOldPhotos() {
  const folders = DriveApp.getFoldersByName(POD_FOLDER_NAME);
  if (!folders.hasNext()) return 0;
  const it = folders.next().getFiles(), cut = monthsAgo(KEEP.photosMonths);
  let n = 0;
  while (it.hasNext() && n < 400) { const f = it.next(); if (f.getDateCreated() < cut) { f.setTrashed(true); n++; } }
  return n;
}

/* ---------- a customer asks what data we hold, or asks us to delete it (admin panel > Customer data) ---------- */
function customerKey(q) {
  q = String(q || '').trim().toLowerCase();
  if (validEmail(q)) return { email: q };
  const digits = q.replace(/\D/g, '');
  if (digits.length >= 9) return { phone: digits.slice(-10) };
  return null;
}
function sameCustomer(k, email, phone, email2) {
  if (k.email) return [email, email2].some(e => String(e || '').trim().toLowerCase() === k.email);
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 9 && d.slice(-10) === k.phone;
}
function customerData(q) {
  const k = customerKey(q);
  if (!k) return { ok: false, message: 'Enter the customer\'s email address or phone number.' };
  const ss = SpreadsheetApp.getActive(), out = { ok: true, jobs: [], client: null, messages: [] };
  const sh = ss.getSheetByName(SHEET_NAME), rows = sh.getDataRange().getValues(), head = rows[0] || [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!String(r[0]).trim() || !sameCustomer(k, r[4], r[12], r[29])) continue;
    const all = {};
    r.forEach((v, j) => { if (v !== '' && v !== null) all[String(head[j] || ('Column ' + (j + 1)))] = v instanceof Date ? v.toISOString() : String(v); });
    out.jobs.push({ ref: String(r[0]).trim(), status: String(r[1]).trim(), updated: isoOf(r[2]), name: cleanText(r[11], 100), from: cleanText(r[8], 200), to: cleanText(r[9], 200),
      payment: cleanText(r[26], 30), active: ['Booked', 'Collected'].indexOf(String(r[1]).trim()) >= 0, keep: inAccounts(r), all: all });
  }
  const cs = ss.getSheetByName(CLIENTS_SHEET);
  if (cs) cs.getDataRange().getValues().slice(1).forEach(r => {
    if (sameCustomer(k, r[0], r[3])) out.client = { email: String(r[0]), name: String(r[1]), company: String(r[2] || ''), phone: String(r[3] || ''), created: isoOf(r[5]), addresses: String(r[6] || '') };
  });
  const ms = ss.getSheetByName(MESSAGES_SHEET);
  if (ms && ms.getLastRow() > 1) ms.getDataRange().getValues().slice(1).forEach(r => {
    if (sameCustomer(k, r[2], r[3])) out.messages.push({ received: isoOf(r[0]), name: String(r[1]), email: String(r[2]), phone: String(r[3] || ''), message: String(r[4] || '') });
  });
  const ns = ss.getSheetByName(NOTES_SHEET);
  if (ns && ns.getLastRow() > 1) ns.getDataRange().getValues().slice(1).forEach(r => {
    const nk = String(r[0]);
    if (sameCustomer(k, nk, nk.replace(/^tel:/, ''))) out.note = { note: String(r[1] || ''), updated: isoOf(r[2]) };
  });
  return out;
}
/* Erasure: jobs that are not part of the accounts are deleted; jobs in the accounts keep only what HMRC needs.
   Jobs still in progress are left alone. Photos, the client account and website messages are deleted. */
function customerErase(q) {
  const k = customerKey(q);
  if (!k) return { ok: false, message: 'Enter the customer\'s email address or phone number.' };
  const ss = SpreadsheetApp.getActive(), sh = ss.getSheetByName(SHEET_NAME), rows = sh.getDataRange().getValues();
  const res = { ok: true, deleted: 0, trimmed: 0, skipped: [], photos: 0, client: false, messages: 0 };
  for (let i = rows.length - 1; i >= 1; i--) {
    const r = rows[i], ref = String(r[0]).trim();
    if (!ref || !sameCustomer(k, r[4], r[12], r[29])) continue;
    if (['Booked', 'Collected'].indexOf(String(r[1]).trim()) >= 0) { res.skipped.push(ref); continue; }
    const files = findFiles(ref);
    files.forEach(f => { try { f.setTrashed(true); res.photos++; } catch (e) {} });
    if (inAccounts(r)) { trimJobRow(sh, i + 1, true); res.trimmed++; }
    else { sh.deleteRow(i + 1); res.deleted++; }
  }
  const cs = ss.getSheetByName(CLIENTS_SHEET);
  if (cs) {
    const cr = cs.getDataRange().getValues();
    for (let i = cr.length - 1; i >= 1; i--) if (sameCustomer(k, cr[i][0], cr[i][3])) {
      const e = String(cr[i][0]).trim().toLowerCase();
      cs.deleteRow(i + 1); props().deleteProperty('cpw_' + e); props().deleteProperty('cver_' + e); res.client = true;
    }
  }
  const os = ss.getSheetByName(OUTREACH_SHEET);
  if (os && os.getLastRow() > 1) {
    const orr = os.getDataRange().getValues();
    for (let i = orr.length - 1; i >= 1; i--) if (sameCustomer(k, orr[i][2], orr[i][3])) { os.deleteRow(i + 1); res.outreach = (res.outreach || 0) + 1; }
  }
  const ns = ss.getSheetByName(NOTES_SHEET);
  if (ns && ns.getLastRow() > 1) {
    const nr = ns.getDataRange().getValues();
    for (let i = nr.length - 1; i >= 1; i--) { const nk = String(nr[i][0]); if (sameCustomer(k, nk, nk.replace(/^tel:/, ''))) { ns.deleteRow(i + 1); res.notes = (res.notes || 0) + 1; } }
  }
  const cos = ss.getSheetByName('Companies');
  if (cos && cos.getLastRow() > 1) {
    const cr2 = cos.getDataRange().getValues();
    for (let i = cr2.length - 1; i >= 1; i--) if (sameCustomer(k, cr2[i][0], '')) { cos.deleteRow(i + 1); res.companies = (res.companies || 0) + 1; }
  }
  const ms = ss.getSheetByName(MESSAGES_SHEET);
  if (ms && ms.getLastRow() > 1) {
    const mr = ms.getDataRange().getValues();
    for (let i = mr.length - 1; i >= 1; i--) if (sameCustomer(k, mr[i][2], mr[i][3])) { ms.deleteRow(i + 1); res.messages++; }
  }
  try { logUpload('-', 'Customer data erased (' + res.deleted + ' deleted, ' + res.trimmed + ' kept for accounts, ' + res.skipped.length + ' in progress)', 'admin', res.photos); } catch (e) {}
  return res;
}

/* ---------- driver app: report a problem (breakdown, running late, nobody there, load not as described, damage...) ----------
   Saved in sheet "Problems" (and the latest one in column AT), photos go in the documents folder,
   and both phones get a notification straight away. Nothing is sent to the customer automatically. */
const PROBLEM_COL = 46;      // column AT
const PROBLEMS_SHEET = 'Problems';
const PROBLEM_KINDS = {
  breakdown: 'Breakdown', late: 'Running late', no_customer: 'Nobody at collection', no_receiver: 'Nobody at delivery',
  load: 'Load not as described', damage: 'Damage noticed', accident: 'Accident', other: 'Other problem'
};
function problemsSheet() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(PROBLEMS_SHEET);
  if (!sh) { sh = ss.insertSheet(PROBLEMS_SHEET); sh.appendRow(['Time', 'Reference', 'Driver', 'Problem', 'Note', 'Photos']); }
  return sh;
}
function handleProblem(d, out) {
  const send = o => out.setContent(JSON.stringify(o));
  try {
    const auth = checkKey(d);
    if (!auth.ok) return send({ ok: false, message: auth.message });
    const ref = String(d.ref || '').trim().toUpperCase();
    if (!/^[A-Z0-9-]{6,30}$/.test(ref)) return send({ ok: false, message: 'Check the reference number.' });
    const kind = String(d.kind || '');
    if (!PROBLEM_KINDS[kind]) return send({ ok: false, message: 'Choose what happened.' });
    const label = PROBLEM_KINDS[kind];
    let note = cleanText(d.note, 500);
    const eta = parseInt(d.eta, 10);
    if (kind === 'late' && eta > 0 && eta < 1000) note = 'About ' + eta + ' min late' + (note ? '. ' + note : '');
    const photos = Array.isArray(d.photos) ? d.photos.slice(0, 4) : [];
    const reqId = String(d.id || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 60);
    const seen = CacheService.getScriptCache();
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    let r, links = [];
    try {
      if (reqId && seen.get('prob_' + reqId)) return send({ ok: true, already: true });
      const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
      const refs = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
      let row = 0;
      for (let i = 1; i < refs.length; i++) if (String(refs[i][0]).trim().toUpperCase() === ref) { row = i + 1; break; }
      if (!row) return send({ ok: false, message: 'Job not found.' });
      r = rowValues(sh, row, 13);
      const drv = cleanText(r[10], 60);
      if (drv && drv !== auth.name) return send({ ok: false, message: 'This job belongs to ' + drv + '.' });
      if (photos.length) {
        const folder = getPodFolder();
        const stamp = Utilities.formatDate(new Date(), 'Europe/London', 'yyyyMMdd-HHmm');
        photos.forEach((p, i) => {
          const m = /^data:image\/jpeg;base64,([A-Za-z0-9+\/=]+)$/.exec(String(p));
          if (!m || m[1].length > 5000000) return;
          const f = folder.createFile(Utilities.newBlob(Utilities.base64Decode(m[1]), 'image/jpeg', ref + '-Problem-' + stamp + '-' + (i + 1) + '.jpg'));
          try { f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
          links.push(f.getUrl());
        });
      }
      const now = new Date();
      problemsSheet().appendRow([now, ref, auth.name, label, safeCell(note), links.join(' ')]);
      if (!sh.getRange(1, PROBLEM_COL).getValue()) sh.getRange(1, PROBLEM_COL).setValue('Last problem');
      sh.getRange(row, PROBLEM_COL).setValue(safeCell(Utilities.formatDate(now, 'Europe/London', 'd MMM HH:mm') + ' ' + label + (note ? ': ' + note : '') + ' (' + auth.name + ')'));
      sh.getRange(row, 3).setValue(now);
      if (reqId) seen.put('prob_' + reqId, '1', 21600);
    } finally { lock.releaseLock(); }
    try { logUpload(ref, 'Problem: ' + label, auth.name, links.length); } catch (e) {}
    try {
      MailApp.sendEmail({ to: OWNER_EMAIL, name: COMPANY + ' driver app',
        subject: '⚠ PROBLEM: ' + label + ' - ' + ref + ' (' + auth.name + ')',
        body: label + ' reported by ' + auth.name + ' for ' + ref + '.\n\n' + (note ? 'Note: ' + note + '\n' : '') +
          'Customer: ' + [cleanText(r[11], 100), cleanText(r[12], 40)].filter(String).join(', ') + '\n' +
          (links.length ? 'Photos: ' + links.join(' ') + '\n' : '') + '\nOpen the admin panel: ' + SITE_URL + '/' + ADMIN_PAGE });
    } catch (e) { logError('Problem email failed: ' + e); }
    notifyPhones('⚠️ PROBLEM: ' + label + ' - ' + ref + ' (' + auth.name + ')' + (note ? '\n' + note : '') +
      '\nCustomer: ' + [cleanText(r[11], 100), cleanText(r[12], 40)].filter(String).join(', ') + (links.length ? '\n' + links.length + ' photo(s) in the admin panel' : ''));
    return send({ ok: true, label: label, photos: links.length });
  } catch (err) {
    logError('Problem report failed: ' + err);
    return send({ ok: false, message: 'Could not send. Call the office.' });
  }
}
/* all reported problems by reference, newest first (for the admin panel) */
function problemsByRef() {
  const ss = SpreadsheetApp.getActive(), sh = ss.getSheetByName(PROBLEMS_SHEET), map = {};
  if (!sh || sh.getLastRow() < 2) return map;
  const rows = sh.getDataRange().getValues();
  for (let i = rows.length - 1; i >= 1; i--) {
    const ref = String(rows[i][1]).trim().toUpperCase();
    if (!ref) continue;
    (map[ref] = map[ref] || []);
    if (map[ref].length >= 10) continue;
    map[ref].push({ at: isoOf(rows[i][0]), when: onWayText(rows[i][0]), driver: cleanText(rows[i][2], 60), label: cleanText(rows[i][3], 60),
      note: cleanText(rows[i][4], 500), photos: String(rows[i][5] || '').split(/\s+/).filter(u => /^https:\/\/[^\s<>"']+$/.test(u)) });
  }
  return map;
}

function logUpload(ref, status, driver, count) {
  const ss = SpreadsheetApp.getActive();
  let log = ss.getSheetByName('Log');
  if (!log) {
    log = ss.insertSheet('Log');
    log.appendRow(['Time', 'Reference', 'Status', 'Driver', 'Photos']);
  }
  log.appendRow([new Date(), ref, status, driver, count]);
}

function getPodFolder() {
  const it = DriveApp.getFoldersByName(POD_FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(POD_FOLDER_NAME);
}

/* ---------- runs when you change a status in column B ---------- */
function onSheetEdit(e) {
  const r = e.range, sh = r.getSheet();
  if (sh.getName() !== SHEET_NAME || r.getRow() < 2 || r.getColumn() !== 2) return;
  sh.getRange(r.getRow(), 3).setValue(new Date()); // Updated = now
  processRow(sh, r.getRow());
}

/* Menu: Sheet > PRJ > Send pending emails (use if a photo was added after the status) */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('PRJ').addItem('Send pending emails', 'sweep').addToUi();
}
function sweep() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  for (let row = 2; row <= sh.getLastRow(); row++) processRow(sh, row);
}

/* Run this ONCE after pasting the script (it also asks for permissions) */
function installTrigger() {
  const ss = SpreadsheetApp.getActive();
  const exists = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'onSheetEdit');
  if (!exists) ScriptApp.newTrigger('onSheetEdit').forSpreadsheet(ss).onEdit().create();
  // every night at about 3am: delete personal data we no longer need (see cleanUpOldData)
  if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'cleanUpOldData')) {
    ScriptApp.newTrigger('cleanUpOldData').timeBased().everyDays(1).atHour(3).create();
  }
}

/* Returns 'sent', 'no-email' or 'skip' */
function processRow(sh, row, extra, driver) {
  const v = sh.getRange(row, 1, 1, 8).getValues()[0];
  const ref = String(v[0]).trim(), status = String(v[1]).trim();
  const email = String(v[4]).trim(), sent = String(v[6]).trim();
  if (!ref || MAIL_STATUSES.indexOf(status) < 0 || status === sent) return 'skip';
  if (!validEmail(email)) return 'no-email';

  let files = [], podUrl = '';
  if (status === 'Delivered' || status === 'Collected') {
    const all = uniqueFiles((extra || []).concat(findFiles(ref)));
    const pod = all.filter(f => f.getName().indexOf('-Problem-') < 0); // photos sent with a problem report are not proof of delivery
    files = status === 'Delivered'
      ? pod.filter(f => f.getName().indexOf('-Collected-') < 0)
      : pod.filter(f => f.getName().indexOf('-Collected-') >= 0);
    if (status === 'Delivered' && files.length) {
      const main = files.find(f => /^image\//.test(f.getMimeType())) || files[0];
      main.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      podUrl = main.getUrl();
      sh.getRange(row, 6).setValue(podUrl);
    }
  }
  const price = status === 'Booked' ? cleanText(sh.getRange(row, 19).getValue(), 40) : '';
  let detailsLink = '', pay = null;
  if (status === 'Booked') {
    const all = rowValues(sh, row, 39);
    // business customers are not asked for the extra details (company name, from and to are enough); you can add them in the admin panel
    if (!all[38] && String(all[27]) !== 'Business' && !/^Invoice/.test(String(all[26] || ''))) detailsLink = detailsUrl(sh, row, ref);
    pay = { link: cleanText(all[25], 300), state: cleanText(all[26], 30) };
    // private customer, no link pasted, Stripe connected: the email gets our own "Pay" link (a Stripe page for the exact price is made when they click)
    if (!pay.link && !/^(Invoice|Paid|Refunded)/.test(pay.state) && String(all[27]) !== 'Business' && stripeKey() && Number(String(price).replace(/[^0-9.]/g, '')) > 0) {
      pay.link = SITE_URL + '/quote.html?pay=1&ref=' + encodeURIComponent(ref) + '&t=' + encodeURIComponent(detailsUrl(sh, row, ref).split('&t=')[1] || '');
    }
    // a business customer with no payment chosen yet pays by invoice: no "payment link" text in the email
    if (!pay.state && !pay.link && String(all[27]) === 'Business') { pay.state = 'Invoice (7 days)'; ensurePayHeaders(sh); sh.getRange(row, 27).setValue(pay.state); }
  }
  const jr = rowValues(sh, row, 16);
  const job = { name: cleanText(jr[11], 100), when: cleanText(jr[13], 80), from: cleanText(jr[8], 200), to: cleanText(jr[9], 200), load: cleanText(jr[15], 300) };
  sendMail(ref, status, email, files, podUrl, String(v[3] || ''), String(v[7] || ''), driver || '', price, detailsLink, pay, job);
  // the payment link went out with the booking confirmation: the job now waits for payment
  if (pay && pay.link && /^https:\/\//.test(pay.link) && !pay.state) sh.getRange(row, 27).setValue('Unpaid');
  sh.getRange(row, 7).setValue(status);
  return 'sent';
}

function uniqueFiles(list) {
  const seen = {}, out = [];
  list.forEach(f => { const id = f.getId(); if (!seen[id]) { seen[id] = 1; out.push(f); } });
  return out;
}

function findFiles(ref) {
  if (!/^[A-Z0-9-]+$/i.test(ref)) return [];
  const folders = DriveApp.getFoldersByName(POD_FOLDER_NAME);
  if (!folders.hasNext()) return [];
  const it = folders.next().searchFiles("title contains '" + ref + "' and trashed=false");
  const list = [];
  while (it.hasNext()) list.push(it.next());
  return list;
}

/* ---------- daily capacity ---------- */
/* Works out the collection day (yyyy-MM-dd, UK time) from the Collection text, e.g. "Sun, 20 Oct 2026 at 10:00",
   "As soon as possible" (counts as the day the request came in), "2026-10-20" or "20/10/2026". Returns '' if it cannot tell. */
function jobDay(whenText, created) {
  const t = String(whenText || '').trim(), tz = 'Europe/London';
  const fmt = d => Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  const z = n => ('0' + n).slice(-2);
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})/.exec(t);
  if (m) {
    const mi = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2].toLowerCase());
    if (mi >= 0) return m[3] + '-' + z(mi + 1) + '-' + z(parseInt(m[1], 10));
  }
  m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
  if (m) return m[3] + '-' + z(parseInt(m[2], 10)) + '-' + z(parseInt(m[1], 10));
  const base = created ? new Date(created) : new Date();
  if (/tomorrow/i.test(t)) return fmt(new Date(base.getTime() + 86400000));
  if (/as soon as possible|asap|today|now/i.test(t)) return fmt(base);
  return '';
}

/* Number of confirmed jobs on each day (Booked, Collected, Delivered). excludeRow is a 1-based sheet row to skip. */
function dayLoadMap(rows, excludeRow) {
  const map = {};
  for (let i = 1; i < rows.length; i++) {
    if (excludeRow && i + 1 === excludeRow) continue;
    const r = rows[i];
    if (!String(r[0]).trim() || MAIL_STATUSES.indexOf(String(r[1]).trim()) < 0) continue;
    const day = jobDay(r[13], r[2]);
    if (day) map[day] = (map[day] || 0) + 1;
  }
  return map;
}

function capacityMessage(day, used) {
  return 'On ' + day + ' there are already ' + used + ' confirmed jobs (limit ' + DAY_LIMIT + ').';
}

/* Payment columns: headers are added the first time they are needed */
function ensurePayHeaders(sh) {
  if (!sh.getRange(1, 26).getValue()) sh.getRange(1, 26, 1, 2).setValues([['Payment link', 'Payment']]);
}

/* Email with the payment link. Sent from the admin panel only after the booking is confirmed. */
function sendPaymentMail(ref, name, email, from, to, when, price, link) {
  if (!validEmail(email)) throw new Error('sendPaymentMail needs a customer email. Do not run it directly; use testPaymentMail to test, or the Email payment link button in the admin panel.');
  const first = String(name).split(' ')[0] || 'there';
  const html =
    '<div style="font-family:Arial,sans-serif;font-size:15px;color:#0E1726;max-width:560px">' +
    '<h2 style="margin:0 0 8px">Payment for your delivery</h2>' +
    '<p>Hello ' + esc(first) + ',</p>' +
    '<p>Your booking is confirmed. Please pay securely online before collection.</p>' +
    '<p style="font-size:20px;margin:14px 0"><b>Amount: ' + esc(price) + '</b></p>' +
    '<p><b>Reference:</b> ' + esc(ref) + '<br><b>Collect from:</b> ' + esc(from) + '<br><b>Deliver to:</b> ' + esc(to) +
    (when ? '<br><b>Collection:</b> ' + esc(when) : '') + '</p>' +
    '<p style="margin:22px 0"><a href="' + esc(link) + '" style="background:#77B72B;color:#0E1726;text-decoration:none;font-weight:bold;padding:14px 24px;border-radius:10px;display:inline-block">Pay ' + esc(price) + ' securely</a></p>' +
    '<p>We are not VAT registered, so no VAT is added. If we are unable to carry out your delivery, we will refund you in full.</p>' +
    '<p style="font-size:13px;color:#5E6B7C"><b>Cancellation:</b> free before the driver sets off to collect. Up to 50% of the price once the driver is on the way or has arrived (load not yet collected). Full price once the load has been collected. <a href="' + SITE_URL + '/terms.html" style="color:#5E6B7C">Terms and conditions</a></p>' +
    '<p>Questions? Reply to this email or call us on ' + esc(PHONE) + '.</p>' +
    '<p>Kind regards,<br>' + esc(COMPANY) + '</p>' + SPAM_NOTE_HTML + '</div>';
  sendCustomerMail({
    to: email,
    subject: 'Payment for your delivery (' + ref + ')',
    htmlBody: html,
    body: 'Your booking ' + ref + ' with ' + COMPANY + ' is confirmed. Please pay ' + price + ' securely before collection: ' + link + ' . If we cannot carry out your delivery we will refund you in full. Cancellation is free before the driver sets off, 50% once the driver is on the way or has arrived (load not yet collected), and the full price once the load is collected. Questions: reply to this email.',
    replyTo: OWNER_EMAIL,
    name: COMPANY
  });
}

/* Email to tell the customer a refund has been made (the refund itself is done in Stripe / SumUp) */
function sendRefundMail(ref, name, email, price) {
  const first = String(name).split(' ')[0] || 'there';
  const html =
    '<div style="font-family:Arial,sans-serif;font-size:15px;color:#0E1726;max-width:560px">' +
    '<h2 style="margin:0 0 8px">Your refund</h2>' +
    '<p>Hello ' + esc(first) + ',</p>' +
    '<p>We have refunded <b>' + esc(price) + '</b> for booking <b>' + esc(ref) + '</b>. It can take a few working days to appear, depending on your bank or card provider.</p>' +
    '<p>We are sorry we could not help this time. If you need a delivery again, you are always welcome to ask for a new quote. Questions? Reply to this email or call us on ' + esc(PHONE) + '.</p>' +
    '<p>Kind regards,<br>' + esc(COMPANY) + '</p></div>';
  sendCustomerMail({
    to: email,
    subject: 'Your refund (' + ref + ')',
    htmlBody: html,
    body: 'We have refunded ' + price + ' for booking ' + ref + '. It can take a few working days to appear. ' + COMPANY,
    replyTo: OWNER_EMAIL,
    name: COMPANY
  });
}

/* Email with the price for a transport request (status stays "Requested" until the customer accepts) */
function sendQuoteMail(ref, name, email, from, to, when, load, price, note, token) {
  const link = SITE_URL + '/quote.html?ref=' + encodeURIComponent(ref) + '&t=' + encodeURIComponent(token);
  const first = String(name).split(' ')[0] || 'there';
  const html =
    '<div style="font-family:Arial,sans-serif;font-size:15px;color:#0E1726;max-width:560px">' +
    '<h2 style="margin:0 0 8px">Your transport quote</h2>' +
    '<p>Hello ' + esc(first) + ',</p>' +
    '<p>Thank you for your enquiry. Here is our price for your delivery.</p>' +
    '<p style="font-size:20px;margin:14px 0"><b>Price: ' + esc(price) + '</b></p>' +
    '<p><b>Reference:</b> ' + esc(ref) + '<br><b>Collect from:</b> ' + esc(from) + '<br><b>Deliver to:</b> ' + esc(to) +
    (when ? '<br><b>Collection:</b> ' + esc(when) : '') + (load ? '<br><b>Load:</b> ' + esc(load) : '') + '</p>' +
    (note ? '<p>' + esc(note) + '</p>' : '') +
    '<p style="margin:22px 0"><a href="' + link + '" style="background:#77B72B;color:#0E1726;text-decoration:none;font-weight:bold;padding:14px 24px;border-radius:10px;display:inline-block">Review and accept your quote</a></p>' +
    '<p>Click the button to accept the price, or let us know it does not suit you. We will then confirm your collection time. You can also reply to this email.</p>' +
    '<p>If anything about the load or addresses changes, please let us know so we can confirm the price.</p>' +
    '<p>Kind regards,<br>' + esc(COMPANY) + '</p>' + SPAM_NOTE_HTML + '</div>';
  sendCustomerMail({
    to: email,
    subject: 'Your transport quote (' + ref + ')',
    htmlBody: html,
    body: 'Your quote from ' + COMPANY + ' (' + ref + '): ' + price + '. Collect from ' + from + ', deliver to ' + to + '. To accept the price, open ' + link + ' or reply to this email.',
    replyTo: OWNER_EMAIL,
    name: COMPANY
  });
}

/* Quick quote from the admin panel: a price by email for a customer who asked "how much from A to B".
   The quote is saved as a job with status Requested and "Quote sent" (tab Quoted in the admin panel), with no collection time.
   The customer accepts with the button in the email (quote.html) and tells us when; then you confirm the booking as usual. */
/* Sheet "Companies": business customers saved from Quick quote, so the next quote fills in by itself.
   A: Email | B: Company | C: Contact name | D: Usual collection address | E: Saved | F: Saved by */
function companiesSheet() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName('Companies');
  if (!sh) { sh = ss.insertSheet('Companies'); sh.appendRow(['Email', 'Company', 'Contact name', 'Usual collection address', 'Saved', 'Saved by']); }
  return sh;
}
function allCompanies() {
  const v = companiesSheet().getDataRange().getValues(), out = [];
  for (let i = 1; i < v.length; i++) if (validEmail(String(v[i][0]))) out.push({ email: String(v[i][0]).trim().toLowerCase(), company: String(v[i][1]), name: String(v[i][2]), from: String(v[i][3]) });
  return out.sort((a, b) => a.company.localeCompare(b.company));
}
function saveCompany(email, company, name, from, who) {
  const sh = companiesSheet(), v = sh.getDataRange().getValues(), row = [email, safeCell(company), safeCell(name), safeCell(from), new Date(), who || ''];
  for (let i = 1; i < v.length; i++) if (String(v[i][0]).trim().toLowerCase() === email) { sh.getRange(i + 1, 1, 1, 6).setValues([row]); return; }
  sh.appendRow(row);
}
function forgetCompany(email) {
  email = String(email || '').trim().toLowerCase();
  const sh = companiesSheet(), v = sh.getDataRange().getValues();
  for (let i = v.length - 1; i >= 1; i--) if (String(v[i][0]).trim().toLowerCase() === email) { sh.deleteRow(i + 1); return { ok: true }; }
  return { ok: false, message: 'Not found.' };
}
function quickQuote(d, who) {
  const email = String(d.email || '').trim().toLowerCase(), from = cleanText(d.from, 200), to = cleanText(d.to, 200);
  const van = cleanText(d.van, 60), load = cleanText(d.load, 300), note = cleanText(d.note, 500), n = rateNum(d.price);
  if (!validEmail(email)) return { ok: false, message: 'Enter the customer email.' };
  if (!from || !to) return { ok: false, message: 'Enter both addresses.' };
  if (!n || n > 20000) return { ok: false, message: 'Enter the price.' };
  const cache = CacheService.getScriptCache(), dk = 'qq_' + Utilities.formatDate(new Date(), 'Europe/London', 'yyyyMMdd'), cnt = Number(cache.get(dk) || 0);
  if (cnt >= 100) return { ok: false, message: 'Too many quotes today. Please try again tomorrow.' };
  cache.put(dk, String(cnt + 1), 86400);
  let c = null;
  try { c = findClient(email); } catch (e) {}
  const biz = d.kind !== 'private';   // business (pays by invoice) or private customer (pays by card before collection)
  const name = cleanText(d.name, 100) || (c && c.name) || '', company = biz ? (cleanText(d.company, 100) || (c && c.company) || '') : '';
  if (biz && !company) return { ok: false, message: 'Enter the company name (or choose Private customer).' };
  const price = priceText(n), token = Utilities.getUuid().replace(/-/g, '');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let ref;
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
    ref = newRef();
    const row = [ref, 'Requested', new Date(), safeCell(note), safeCell(email), '', '', '', safeCell(from), safeCell(to), '',
      safeCell(name || email), safeCell((c && c.phone) || ''), '', safeCell(van), safeCell(load), '', '', price,
      new Date(), token, price, '', '', ''];
    while (row.length < 26) row.push('');
    if (biz) row.push('Invoice (7 days)', 'Business', safeCell(company));   // business customer: pays by invoice after the job
    else row.push('', 'Private', '');                                       // private customer: the card payment link is sent with the booking
    ensureDetailHeaders(sh);
    if (!sh.getRange(1, 20).getValue()) sh.getRange(1, 20).setValue('Quote sent');
    if (!sh.getRange(1, 21).getValue()) sh.getRange(1, 21, 1, 5).setValues([['Quote token', 'Quoted price', 'Customer answer', 'Answered', 'Customer comment']]);
    sh.appendRow(row);
  } finally { lock.releaseLock(); }
  const link = SITE_URL + '/quote.html?ref=' + encodeURIComponent(ref) + '&t=' + encodeURIComponent(token);
  const first = (name.split(' ')[0] || '').replace(/[^A-Za-zÀ-ſ'-]/g, '') || 'there';
  const tr = (k, v) => v ? '<tr><td style="padding:4px 14px 4px 0;color:#5E6B7C;white-space:nowrap;vertical-align:top">' + k + '</td><td style="padding:4px 0"><b>' + esc(v) + '</b></td></tr>' : '';
  const html =
    '<div style="font-family:Arial,sans-serif;font-size:15px;color:#0E1726;max-width:560px">' +
    '<h2 style="margin:0 0 8px">Your delivery quote</h2>' +
    '<p>Hello ' + esc(first) + ',</p>' +
    '<p>Thank you for your enquiry. Here is our price for this delivery.</p>' +
    '<p style="font-size:26px;margin:16px 0"><b>' + esc(price) + '</b></p>' +
    '<table style="border-collapse:collapse;font-size:15px">' + tr('Company', company) + tr('Collect from', from) + tr('Deliver to', to) + tr('Vehicle', van) + tr('Load', load) + tr('Payment', biz ? 'By invoice, within 7 days' : 'By card before collection (we email you a secure link)') + tr('Reference', ref) + '</table>' +
    (note ? '<p>' + esc(note).replace(/\n/g, '<br>') + '</p>' : '') +
    '<p style="margin:22px 0"><a href="' + link + '" style="background:#77B72B;color:#0E1726;text-decoration:none;font-weight:bold;padding:14px 26px;border-radius:10px;display:inline-block">Accept this price</a></p>' +
    '<p>Tap the button to accept and tell us when you would like the collection. We will then confirm your booking. You can also reply to this email, or call or WhatsApp us.</p>' +
    '<p style="font-size:13px;color:#5E6B7C">The price is for the addresses and load above and is valid for 7 days. No VAT is added. Waiting time over 20 minutes and extra stops are charged as set out in our <a href="' + SITE_URL + '/terms.html" style="color:#5E6B7C">terms</a>.</p>' +
    '<p>Kind regards,<br>' + esc(who || '') + (who ? '<br>' : '') + esc(COMPANY) + '<br>' + esc(PHONE) + ' · +44 7598 888192 (WhatsApp)</p>' + SPAM_NOTE_HTML + '</div>';
  try {
    sendCustomerMail({
      to: email, subject: 'Your delivery quote: ' + price + ' (' + ref + ')', htmlBody: html, replyTo: OWNER_EMAIL, name: COMPANY,
      body: 'Your delivery quote from ' + COMPANY + ': ' + price + '\nCollect from: ' + from + '\nDeliver to: ' + to + (van ? '\nVehicle: ' + van : '') + (load ? '\nLoad: ' + load : '') +
        '\nReference: ' + ref + (note ? '\n\n' + note : '') + '\n\nTo accept the price, open ' + link + ' or reply to this email. Valid for 7 days. No VAT is added.'
    });
  } catch (e) { logError('Quick quote email failed (' + ref + '): ' + e); return { ok: true, ref: ref, price: price, mail: 'failed', message: 'Saved as ' + ref + ', but the email could not be sent. Open it in Quoted and press "Resend quote".' }; }
  try { logUpload(ref, 'Quick quote ' + price + ' sent', who, 0); } catch (e) {}
  if (d.saveCompany && biz) { try { saveCompany(email, company, name, from, who); } catch (e) { logError('Company not saved: ' + e); } }
  return { ok: true, ref: ref, price: price, mail: 'sent' };
}

function sendMail(ref, status, to, files, podUrl, note, receivedBy, driver, price, detailsLink, pay, job) {
  job = job || {};
  const first = (String(job.name || '').split(/[\s(]/)[0] || '').replace(/[^A-Za-z\u00C0-\u017F'-]/g, '');
  const link = SITE_URL + '/track.html?ref=' + encodeURIComponent(ref);
  const titles = {
    Booked: 'Your delivery is booked',
    Collected: 'Your delivery has been collected',
    Delivered: 'Your delivery has been delivered'
  };
  const lines = {
    Booked: 'Thank you for booking with ' + COMPANY + '. Here are the details of your booking.',
    Collected: 'Your load has been collected and is safely with us. We will email you again as soon as it has been delivered.',
    Delivered: 'Your load has been delivered. Thank you for choosing ' + COMPANY + ', we hope to help you again soon.'
  };
  // the job at a glance: collection time and addresses (the most important part of the "booked" email)
  const row2 = (k, val) => val ? '<tr><td style="padding:4px 14px 4px 0;color:#5E6B7C;white-space:nowrap;vertical-align:top">' + k + '</td><td style="padding:4px 0"><b>' + esc(val) + '</b></td></tr>' : '';
  const summary = status === 'Booked'
    ? '<table style="border-collapse:collapse;font-size:15px;margin:8px 0 6px">' + row2('Collection', job.when && !/not specified/i.test(job.when) ? job.when : 'We will confirm the time with you') + row2('Collect from', job.from) + row2('Deliver to', job.to) + row2('Load', job.load) + '</table>'
    : (job.from && job.to ? '<p style="color:#5E6B7C;margin:4px 0 10px">' + esc(job.from) + ' \u2192 ' + esc(job.to) + '</p>' : '');
  let extra = '';
  let attachments = [];
  let inline = {};
  const pdfs = files.filter(f => f.getMimeType() === 'application/pdf');
  files = files.filter(f => f.getMimeType() !== 'application/pdf');
  const total = files.reduce((n, f) => n + f.getSize(), 0);
  if (pdfs.length) {
    attachments = pdfs.map(f => f.getBlob());
    extra += '<p><b>Your ' + (pdfs.some(f => /signed/.test(f.getName())) ? 'signed ' : '') + 'proof of delivery (PDF) is attached.</b></p>';
  }
  if (pdfs.length) {
    // proof of delivery PDF plus the delivery photos (with our logo on them) as attachments
    if (files.length && total <= MAX_ATTACH_BYTES) {
      attachments = attachments.concat(files.map(f => f.getBlob()));
      extra += '<p>Photos taken at delivery are attached to this email.</p>';
    }
  } else if (files.length && total <= MAX_ATTACH_BYTES) {
    attachments = attachments.concat(files.map(f => f.getBlob()));
    const firstImg = files.find(f => /^image\//.test(f.getMimeType()));
    if (firstImg) {
      inline = { photo1: firstImg.getBlob() };
      extra += '<p><img src="cid:photo1" alt="Photo" style="max-width:100%;border-radius:8px"></p>';
    }
    extra += '<p>' + (status === 'Delivered'
      ? 'Your proof of delivery is attached to this email.'
      : 'Photos taken at collection are attached to this email.') + '</p>';
  } else if (podUrl) {
    extra += '<p>View your proof of delivery: <a href="' + esc(podUrl) + '">open photo</a></p>';
  }
  if (status === 'Delivered' && receivedBy) extra += '<p><b>Received by:</b> ' + esc(receivedBy) + '</p>';
  if (price) extra += '<p><b>Price:</b> ' + esc(price) + '</p>';
  if (status === 'Booked') {
    const ps = (pay && pay.state) || '', pl = pay && /^https:\/\/[^\s<>"']{4,280}$/.test(pay.link || '') ? pay.link : '';
    if (ps === 'Paid') extra += '<p><b>Payment:</b> received, thank you.</p>';
    else if (/^Invoice/.test(ps)) extra += '<p><b>Payment:</b> we will send you an invoice (payment within 7 days).</p>';
    else if (pl) extra += '<p><b>Payment is due before collection.</b> Pay securely by card:</p>' +
      '<p style="margin:18px 0"><a href="' + esc(pl) + '" style="background:#77B72B;color:#0E1726;text-decoration:none;font-weight:bold;padding:14px 24px;border-radius:10px;display:inline-block">Pay ' + esc(price || 'now') + ' securely</a></p>' +
      '<p style="font-size:13px;color:#5E6B7C"><b>Cancellation:</b> free before the driver sets off to collect. Up to 50% of the price once the driver is on the way or has arrived (load not yet collected). Full price once the load has been collected. <a href="' + SITE_URL + '/terms.html" style="color:#5E6B7C">Terms and conditions</a></p>';
    else extra += '<p><b>Next step:</b> you will receive a separate email with a secure payment link shortly. Payment is due before collection.</p>';
  }
  if (status === 'Booked' && detailsLink) extra += '<p><b>We still need a few details</b> for the collection and delivery (who to meet, phone numbers, access notes' +
    ' and, for businesses, invoice details):</p><p><a href="' + esc(detailsLink) + '" style="background:#77B72B;color:#0E1726;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:10px;display:inline-block">Add delivery details</a></p>';
  if (driver && status !== 'Booked') extra += '<p><b>Your driver:</b> ' + esc(driver) + '</p>';
  const html =
    '<div style="font-family:Arial,sans-serif;font-size:15px;color:#0E1726;max-width:560px">' +
    '<h2 style="margin:0 0 8px">' + titles[status] + '</h2>' +
    (first ? '<p>Hello ' + esc(first) + ',</p>' : '') +
    '<p>' + lines[status] + '</p>' + summary +
    '<p><b>Reference:</b> ' + esc(ref) + '</p>' +
    (note ? '<p>' + esc(note) + '</p>' : '') + extra +
    '<p><a href="' + esc(link) + '">Track your delivery</a></p>' +
    '<p>Questions? Reply to this email or call us on ' + esc(PHONE) + '.<br>' + COMPANY + '</p>' + (status === 'Booked' ? SPAM_NOTE_HTML : '') + '</div>';
  sendCustomerMail({
    to: to,
    subject: titles[status] + ' (' + ref + ')',
    htmlBody: html,
    body: titles[status] + '. Reference: ' + ref + '. Track: ' + link,
    name: COMPANY,
    replyTo: OWNER_EMAIL,
    attachments: attachments,
    inlineImages: inline
  });
}


/* ---------- customer accepts or declines the quote on the website (quote.html) ---------- */
function findQuoteRow(sh, ref, token) {
  if (!/^PRJ-\d{6}-[A-Z2-9]{5}$/.test(ref) || !/^[0-9a-f]{32}$/.test(token)) return 0;
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const refs = sh.getRange(1, 1, last, 1).getValues();
  for (let i = 1; i < refs.length; i++) {
    if (String(refs[i][0]).trim() === ref) {
      const r = sh.getRange(i + 1, 1, 1, 25).getValues()[0];
      if (String(r[20]) !== token) return 0;
      if (cleanText(r[18], 40) !== cleanText(r[21], 40)) return 0; // price changed after the quote was sent: link is no longer valid
      return i + 1;
    }
  }
  return 0;
}

function handleQuoteView(e) {
  const out = ContentService.createTextOutput().setMimeType(ContentService.MimeType.JSON);
  const send = o => out.setContent(JSON.stringify(o));
  try {
    const ref = String(e.parameter.ref || '').trim().toUpperCase(), token = String(e.parameter.t || '').trim().toLowerCase();
    const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
    const row = findQuoteRow(sh, ref, token);
    if (!row) return send({ found: false });
    const r = sh.getRange(row, 1, 1, 29).getValues()[0];
    if (String(r[1]).trim() === 'Cancelled') return send({ found: false });
    return send({
      found: true, ref: ref, name: cleanText(r[11], 100).split(' ')[0], from: cleanText(r[8], 200), to: cleanText(r[9], 200),
      when: cleanText(r[13], 80), load: cleanText(r[15], 300), price: cleanText(r[18], 40), answer: cleanText(r[22], 20),
      invoice: /^Invoice/.test(String(r[26] || '')), company: String(r[27]) === 'Business' ? cleanText(r[28], 100) : ''
    });
  } catch (err) {
    return send({ found: false });
  }
}

function handleQuoteAnswer(d, out) {
  const send = o => out.setContent(JSON.stringify(o));
  try {
    const ref = String(d.ref || '').trim().toUpperCase(), token = String(d.t || '').trim().toLowerCase();
    const answer = d.answer === 'accept' ? 'Accepted' : d.answer === 'decline' ? 'Declined' : '';
    if (!answer) return send({ ok: false });
    const comment = cleanText(d.comment, 500);
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    let r;
    try {
      const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
      const row = findQuoteRow(sh, ref, token);
      if (!row) return send({ ok: false, message: 'This quote link is no longer valid. Please contact us.' });
      r = sh.getRange(row, 1, 1, 25).getValues()[0];
      if (String(r[22])) return send({ ok: true, answer: String(r[22]), already: true });
      sh.getRange(row, 23, 1, 3).setValues([[answer, new Date(), safeCell(comment)]]);
      sh.getRange(row, 3).setValue(new Date());
    } finally { lock.releaseLock(); }

    const name = cleanText(r[11], 100), email = String(r[4]).trim(), price = cleanText(r[18], 40);
    const from = cleanText(r[8], 200), to = cleanText(r[9], 200);
    try {
      MailApp.sendEmail({
        to: OWNER_EMAIL,
        subject: 'Quote ' + answer.toUpperCase() + ': ' + ref + ' (' + name + ')',
        body: name + ' has ' + answer.toLowerCase() + ' the price ' + price + '.\n\nReference: ' + ref + '\nCollect from: ' + from + '\nDeliver to: ' + to +
          '\nPhone: ' + cleanText(r[12], 40) + '\nEmail: ' + email + (comment ? '\n\nCustomer comment: ' + comment : '') +
          (answer === 'Accepted' ? '\n\nOpen the admin panel and tap "Confirm booking and email customer".' : ''),
        replyTo: validEmail(email) ? email : OWNER_EMAIL,
        name: COMPANY + ' website'
      });
    } catch (e) { logError('Owner notification for quote answer failed for ' + ref + ': ' + e); }
    notifyPhones((answer === 'Accepted' ? '✅ Price ACCEPTED ' : '❌ Price declined ') + ref + '\n' + name + ' · ' + price + '\n' + from + ' → ' + to +
      (comment ? '\nComment: ' + comment : '') + (answer === 'Accepted' ? '\nOpen the admin panel and confirm the booking.' : ''));
    if (validEmail(email) && answer !== 'Accepted') { // an acceptance gets no extra email: the booking confirmation follows
      try {
        const first = name.split(' ')[0] || 'there';
        const msg = answer === 'Accepted'
          ? 'Thank you, we have your acceptance of ' + price + ' for ' + ref + '. We will confirm your collection time shortly.'
          : 'Thank you for letting us know. We have noted that the price for ' + ref + ' does not suit you. If you would like to talk it over, reply to this email.';
        sendCustomerMail({
          to: email, subject: (answer === 'Accepted' ? 'We received your acceptance' : 'Thank you for your reply') + ' (' + ref + ')',
          htmlBody: '<div style="font-family:Arial,sans-serif;font-size:15px;color:#0E1726;max-width:560px"><p>Hello ' + esc(first) + ',</p><p>' + esc(msg) + '</p><p>Kind regards,<br>' + esc(COMPANY) + '</p></div>',
          body: msg, replyTo: OWNER_EMAIL, name: COMPANY
        });
      } catch (e) { logError('Customer answer confirmation failed for ' + ref + ': ' + e); }
    }
    return send({ ok: true, answer: answer });
  } catch (err) {
    return send({ ok: false });
  }
}




/* ---------- price suggestion (collection address -> delivery address) ---------- */
function milesBetween(a, b) {
  const R = 3958.8, rad = x => x * Math.PI / 180;
  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* Finds [lat, lon] for a UK address. A postcode in the text is the most accurate, otherwise OpenStreetMap search (Photon). */
function geocodeUK(text) {
  const pc = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i.exec(text);
  if (pc) {
    try {
      const r = UrlFetchApp.fetch('https://api.postcodes.io/postcodes/' + encodeURIComponent(pc[1] + pc[2]).toUpperCase(), { muteHttpExceptions: true });
      if (r.getResponseCode() === 200) {
        const j = JSON.parse(r.getContentText());
        if (j.result && j.result.latitude) return { p: [Number(j.result.latitude), Number(j.result.longitude)], london: String(j.result.region || '') === 'London' };
      }
    } catch (e) {}
  }
  try {
    const r = UrlFetchApp.fetch('https://photon.komoot.io/api/?limit=5&lang=en&lat=51.45&lon=-0.97&q=' + encodeURIComponent(text), { muteHttpExceptions: true });
    if (r.getResponseCode() === 200) {
      const f = (JSON.parse(r.getContentText()).features || []).filter(x => x.properties && x.properties.countrycode === 'GB')[0];
      if (f) {
        const p = [Number(f.geometry.coordinates[1]), Number(f.geometry.coordinates[0])], pr = f.properties || {};
        const named = /london/i.test(String(pr.county || '') + ' ' + String(pr.state || '') + ' ' + String(pr.city || ''));
        const known = !!(pr.county || pr.state || pr.city);
        return { p: p, london: known ? named : milesBetween(p, LONDON_CENTRE) <= LONDON_RADIUS_MILES };
      }
    }
  } catch (e) {}
  return null;
}

/* Route between two points.
   With a TomTom key saved (run setTomTomKey once): fastest van route using live / predicted traffic at the collection time.
   Without a key: OSRM (no traffic). If both fail: straight line plus 25%. */
function routeMiles(a, b, when) {
  const key = props().getProperty('tomtom_key');
  if (key) {
    try {
      const dep = departAtFrom(when);
      const url = 'https://api.tomtom.com/routing/1/calculateRoute/' + a[0] + ',' + a[1] + ':' + b[0] + ',' + b[1] +
        '/json?key=' + encodeURIComponent(key) + '&traffic=true&travelMode=van&routeType=fastest&routeRepresentation=polyline' + (dep ? '&departAt=' + encodeURIComponent(dep) : '');
      const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (r.getResponseCode() === 200) {
        const route = JSON.parse(r.getContentText()).routes[0], s = route.summary, pts = [];
        (route.legs || []).forEach(l => (l.points || []).forEach(p => pts.push([p.latitude, p.longitude])));
        return { miles: s.lengthInMeters / 1609.344, exact: true, traffic: true, mins: Math.round(s.travelTimeInSeconds / 60),
          delayMins: Math.round((s.trafficDelayInSeconds || 0) / 60), departAt: dep || 'now', path: thinPath(pts) };
      }
      logError('TomTom routing failed (' + r.getResponseCode() + '), using OSRM instead');
    } catch (e) { logError('TomTom routing failed: ' + e); }
  }
  const o = osrmRoute(a, b);
  if (o) return o;
  return { miles: milesBetween(a, b) * 1.25, exact: false, traffic: false }; // routing service not reachable: straight line plus 25%
}

/* Route without traffic from the free OSRM server: the same route the customer sees on the website */
function osrmRoute(a, b) {
  try {
    const r = UrlFetchApp.fetch('https://router.project-osrm.org/route/v1/driving/' + a[1] + ',' + a[0] + ';' + b[1] + ',' + b[0] + '?overview=simplified&geometries=geojson', { muteHttpExceptions: true });
    if (r.getResponseCode() === 200) {
      const j = JSON.parse(r.getContentText());
      if (j.code === 'Ok' && j.routes && j.routes[0]) {
        const c = (j.routes[0].geometry && j.routes[0].geometry.coordinates) || [];
        return { miles: j.routes[0].distance / 1609.344, exact: true, traffic: false, mins: Math.round(j.routes[0].duration / 60), path: thinPath(c.map(p => [p[1], p[0]])) };
      }
    }
  } catch (e) {}
  return null;
}

/* keep at most about 300 points of a route line for the admin map, rounded to 5 decimals */
function thinPath(pts) {
  if (!pts || !pts.length) return [];
  const step = Math.max(1, Math.ceil(pts.length / 300)), out = [];
  for (let i = 0; i < pts.length; i += step) out.push([Math.round(pts[i][0] * 1e5) / 1e5, Math.round(pts[i][1] * 1e5) / 1e5]);
  const last = pts[pts.length - 1];
  const end = [Math.round(last[0] * 1e5) / 1e5, Math.round(last[1] * 1e5) / 1e5], prev = out[out.length - 1];
  if (prev[0] !== end[0] || prev[1] !== end[1]) out.push(end);
  return out;
}

/* Collection time text ("Tue, 20 Oct 2026 at 07:30", "20 Oct 2026 10:00", "Today 15:00", "Tomorrow 09:00") -> ISO time for TomTom, or '' for "now" */
function departAtFrom(when) {
  const t = String(when || '').trim();
  if (!t || /soon|asap|not specified/i.test(t)) return '';
  const M = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const z = n => ('0' + n).slice(-2), tz = 'Europe/London';
  let y, mo, d;
  const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})/.exec(t);
  if (m && M[m[2].toLowerCase()]) { d = +m[1]; mo = M[m[2].toLowerCase()]; y = +m[3]; }
  else if (/today|tomorrow/i.test(t)) {
    const base = new Date(Date.now() + (/tomorrow/i.test(t) ? 86400000 : 0));
    y = +Utilities.formatDate(base, tz, 'yyyy'); mo = +Utilities.formatDate(base, tz, 'MM'); d = +Utilities.formatDate(base, tz, 'dd');
  } else return '';
  const hm = /(\d{1,2}):(\d{2})/.exec(t.replace(/\d{4}/, ''));
  const h = hm ? +hm[1] : 9, mi = hm ? +hm[2] : 0;
  const offset = Utilities.formatDate(new Date(), tz, 'XXX');
  const iso = y + '-' + z(mo) + '-' + z(d) + 'T' + z(h) + ':' + z(mi) + ':00' + (offset === 'Z' ? '+00:00' : offset);
  const when2 = new Date(iso);
  if (isNaN(when2.getTime()) || when2.getTime() < Date.now() + 60000) return ''; // in the past: use traffic now
  return iso;
}

/* RUN ONCE: paste your TomTom API key between the quotes, Save, choose setTomTomKey and Run. Then delete the key from the code again. */
function setTomTomKey() {
  const KEY = '';
  if (!KEY) throw new Error('Paste the TomTom key between the quotes first.');
  props().setProperty('tomtom_key', KEY.trim());
  Logger.log('TomTom key saved. Price suggestions now use the fastest route with traffic.');
}

function nearLocal(p) { return LOCAL_CENTRES.some(c => milesBetween(p, c) <= LOCAL_RADIUS_MILES); }

function priceText(n) { return '£' + (n % 1 === 0 ? String(n) : n.toFixed(2)); }

/* Returns { ok, price (number), priceText, miles, local, london, why } */
function suggestPrice(from, to, when, kind) {
  kind = kind === 'business' ? 'business' : 'private';
  try {
    const ga = geocodeUK(from), gb = geocodeUK(to);
    const a = ga && ga.p, b = gb && gb.p;
    if (!a || !b) return { ok: false, message: 'Could not find ' + (!a && !b ? 'either address' : !a ? 'the collection address' : 'the delivery address') + '. Check the postcode or enter the price yourself.' };
    const rt = routeMiles(a, b, when);
    const map = { from: a, to: b, path: rt.path || [], traffic: !!rt.traffic, mins: rt.mins || null, miles: Math.round(rt.miles) };
    // what the customer saw on the website (route without traffic), so both can be compared in the admin panel
    const cust = rt.traffic ? osrmRoute(a, b) : rt;
    if (cust && cust.exact) map.customer = { miles: Math.round(cust.miles * 10) / 10, mins: cust.mins || null, path: rt.traffic ? (cust.path || []) : [] };
    const london = !!(ga.london || gb.london), R = priceRates();
    const rate = london ? R.london : R[kind];
    const mi = Math.max(1, Math.round(rt.miles));
    const minC = kind === 'business' ? R.minBusiness : R.minPrivate;
    const raw = Math.round(mi * rate), price = Math.max(raw, minC);
    let why = (kind === 'business' ? 'Business' : 'Private') + ' rate: ' + mi + ' miles x ' + priceText(rate) + ' per mile' + (london ? ' (London area rate)' : '') + ' = ' + priceText(raw) + '.';
    if (price > raw) why += ' Minimum charge ' + priceText(minC) + ' applies.';
    if (!rt.exact) why += ' Distance is approximate (routing service unavailable).';
    if (rt.traffic) why += ' Fastest route with traffic' + (rt.departAt && rt.departAt !== 'now' ? ' at the collection time' : ' right now') + ': about ' + rt.mins + ' min' + (rt.delayMins > 0 ? ' (' + rt.delayMins + ' min traffic delay)' : '') + '.';
    else if (rt.mins) why += ' About ' + rt.mins + ' min without traffic.';
    return { ok: true, kind: kind, price: price, priceText: priceText(price), local: false, london: london, miles: mi, mins: rt.mins || null, traffic: !!rt.traffic, route: map, why: why };
  } catch (e) {
    logError('Price suggestion failed: ' + e);
    return { ok: false, message: 'Could not calculate a suggestion. Enter the price yourself.' };
  }
}

/* ---------- delivery details (company or private, contacts, notes) ----------
   The customer fills these in on quote.html after accepting the price, or from the link in the "booked" email. */
const DETAIL_HEADERS = ['Customer type', 'Company', 'Invoice email', 'Invoice address', 'Collection contact', 'Collection phone', 'Collection notes',
  'Delivery contact', 'Delivery phone', 'Delivery notes', 'Signature needed', 'Details received'];
function ensureDetailHeaders(sh) {
  if (!sh.getRange(1, 28).getValue()) sh.getRange(1, 28, 1, DETAIL_HEADERS.length).setValues([DETAIL_HEADERS]);
}

/* Reads the first n columns of a row (fewer if the sheet is narrower; missing cells are blank). */
function rowValues(sh, row, n) {
  const have = Math.min(n, sh.getMaxColumns());
  const v = sh.getRange(row, 1, 1, have).getValues()[0];
  while (v.length < n) v.push('');
  return v;
}

/* Reads the details of a sheet row (array of values). Returns null if the customer has not filled them in yet. */
function detailsOf(r) {
  if (!r[38]) return null;
  return {
    type: cleanText(r[27], 20), company: cleanText(r[28], 100), invEmail: cleanText(r[29], 120), invAddress: cleanText(r[30], 300),
    cName: cleanText(r[31], 100), cPhone: cleanText(r[32], 40), cNotes: cleanText(r[33], 300),
    dName: cleanText(r[34], 100), dPhone: cleanText(r[35], 40), dNotes: cleanText(r[36], 300),
    signature: String(r[37]) === 'Yes', at: new Date(r[38]).toISOString()
  };
}

/* Finds the job by reference and token only (the price may have changed since). Returns the sheet row or 0. */
function findDetailsRow(sh, ref, token) {
  if (!/^PRJ-\d{6}-[A-Z2-9]{5}$/.test(ref) || !/^[0-9a-f]{32}$/.test(token)) return 0;
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const refs = sh.getRange(1, 1, last, 1).getValues();
  for (let i = 1; i < refs.length; i++) {
    if (String(refs[i][0]).trim() === ref) {
      const tk = String(sh.getRange(i + 1, 21).getValue());
      if (tk !== token) return 0;
      if (String(sh.getRange(i + 1, 2).getValue()).trim() === 'Cancelled') return 0;
      return i + 1;
    }
  }
  return 0;
}

/* Link to the details form. Creates the job's private token if it has none yet (for example a booking made by phone). */
function detailsUrl(sh, row, ref) {
  let token = String(sh.getRange(row, 21).getValue());
  if (!/^[0-9a-f]{32}$/.test(token)) {
    token = Utilities.getUuid().replace(/-/g, '');
    if (!sh.getRange(1, 21).getValue()) sh.getRange(1, 21, 1, 5).setValues([['Quote token', 'Quoted price', 'Customer answer', 'Answered', 'Customer comment']]);
    sh.getRange(row, 21).setValue(token);
  }
  return SITE_URL + '/quote.html?details=1&ref=' + encodeURIComponent(ref) + '&t=' + encodeURIComponent(token);
}

function handleDetailsView(e) {
  const out = ContentService.createTextOutput().setMimeType(ContentService.MimeType.JSON);
  const send = o => out.setContent(JSON.stringify(o));
  try {
    const ref = String(e.parameter.ref || '').trim().toUpperCase(), token = String(e.parameter.t || '').trim().toLowerCase();
    const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
    const row = findDetailsRow(sh, ref, token);
    if (!row) return send({ found: false });
    const r = rowValues(sh, row, 39);
    return send({
      found: true, ref: ref, name: cleanText(r[11], 100).split(' ')[0], from: cleanText(r[8], 200), to: cleanText(r[9], 200),
      when: cleanText(r[13], 80), details: detailsOf(r),
      pre: { type: cleanText(r[27], 20), company: cleanText(r[28], 100) },
      me: { name: cleanText(r[11], 100).replace(/\s*\(.*\)\s*$/, ''), phone: cleanText(r[12], 40) }   // the customer's own name and phone, to fill in the collection contact
    });
  } catch (err) {
    return send({ found: false });
  }
}

/* the office types the delivery details in the admin panel (e.g. given by phone or email); nothing is required */
function adminDetailsSave(sh, d, who) {
  const row = findJobRow(sh, d.ref);
  if (!row) return { ok: false, message: 'Job not found.' };
  const type = d.type === 'Business' ? 'Business' : d.type === 'Private' ? 'Private' : '';
  const invEmail = cleanText(d.invEmail, 120);
  if (invEmail && !validEmail(invEmail)) return { ok: false, message: 'Check the invoice email address.' };
  const ph = v => { const s2 = String(v || '').trim(); if (!s2) return ''; const p2 = ukPhone(s2); return p2 === null ? null : p2; };
  const cPhone = ph(d.cPhone), dPhone = ph(d.dPhone);
  if (cPhone === null || dPhone === null) return { ok: false, message: 'Check the phone numbers (UK numbers), or leave them empty.' };
  ensureDetailHeaders(sh);
  const cur = rowValues(sh, row, 39);
  sh.getRange(row, 28, 1, 12).setValues([[type || cleanText(cur[27], 20), safeCell(cleanText(d.company, 100)), safeCell(invEmail), safeCell(cleanText(d.invAddress, 300)),
    safeCell(cleanText(d.cName, 100)), cPhone, safeCell(cleanText(d.cNotes, 300)), safeCell(cleanText(d.dName, 100)), dPhone, safeCell(cleanText(d.dNotes, 300)),
    d.signature ? 'Yes' : 'No', new Date()]]);
  sh.getRange(row, 3).setValue(new Date());
  try { logUpload(String(d.ref).trim(), 'Delivery details added in the admin panel', who, 0); } catch (e) {}
  return { ok: true };
}
function handleDetailsSave(d, out) {
  const send = o => out.setContent(JSON.stringify(o));
  try {
    const ref = String(d.ref || '').trim().toUpperCase(), token = String(d.t || '').trim().toLowerCase();
    const type = d.type === 'Business' ? 'Business' : d.type === 'Private' ? 'Private' : '';
    const company = cleanText(d.company, 100), invEmail = cleanText(d.invEmail, 120), invAddress = cleanText(d.invAddress, 300);
    const cName = cleanText(d.cName, 100), dName = cleanText(d.dName, 100);
    const cPhone = ukPhone(d.cPhone), dPhone = ukPhone(d.dPhone);
    const cNotes = cleanText(d.cNotes, 300), dNotes = cleanText(d.dNotes, 300), sig = d.signature ? 'Yes' : 'No';
    if (!type) return send({ ok: false, message: 'Please choose business or private.' });
    if (type === 'Business' && !company) return send({ ok: false, message: 'Please enter the company name.' });
    if (invEmail && !validEmail(invEmail)) return send({ ok: false, message: 'Check the invoice email address.' });
    if (!cName || !dName) return send({ ok: false, message: 'Please enter a contact name for the collection and for the delivery.' });
    if (!cPhone || !dPhone) return send({ ok: false, message: 'Please enter a UK phone number for the collection and for the delivery contact.' });
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    let r;
    try {
      const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
      const row = findDetailsRow(sh, ref, token);
      if (!row) return send({ ok: false, message: 'This link is no longer valid. Please contact us.' });
      ensureDetailHeaders(sh);
      sh.getRange(row, 28, 1, 12).setValues([[type, safeCell(company), safeCell(invEmail), safeCell(invAddress), safeCell(cName), cPhone, safeCell(cNotes),
        safeCell(dName), dPhone, safeCell(dNotes), sig, new Date()]]);
      sh.getRange(row, 3).setValue(new Date());
      r = sh.getRange(row, 1, 1, 27).getValues()[0];
    } finally { lock.releaseLock(); }
    const name = cleanText(r[11], 100);
    const text = 'Delivery details received for ' + ref + ' (' + name + ')\n' + (type === 'Business' ? 'Business: ' + company : 'Private customer') +
      '\nCollection: ' + cName + ', ' + cPhone + (cNotes ? ' (' + cNotes + ')' : '') +
      '\nDelivery: ' + dName + ', ' + dPhone + (dNotes ? ' (' + dNotes + ')' : '') + (sig === 'Yes' ? '\nSignature needed' : '');
    try {
      MailApp.sendEmail({ to: OWNER_EMAIL, subject: 'Delivery details: ' + ref + ' (' + name + ')', body: text, name: COMPANY + ' website' });
    } catch (e) { logError('Owner notification for delivery details failed for ' + ref + ': ' + e); }
    notifyPhones('📋 ' + text);
    return send({ ok: true });
  } catch (err) {
    return send({ ok: false, message: 'Sorry, that did not go through. Please try again or call us.' });
  }
}

/* ---------- phone notifications through Telegram ----------
   One-time setup (see the instructions): 1) setTelegramToken  2) findTelegramChats  3) testTelegram.
   The token and chat ids are kept in the script's hidden settings, not in the code. */
function notifyPhones(text) {
  try {
    const token = props().getProperty('tg_token'), chats = props().getProperty('tg_chats');
    if (!token || !chats) return;
    chats.split(',').forEach(id => {
      if (!id) return;
      const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'post', payload: { chat_id: id, text: String(text).slice(0, 3500) }, muteHttpExceptions: true
      });
      if (res.getResponseCode() !== 200) logError('Telegram notification failed (' + res.getResponseCode() + ') for chat ' + id);
    });
  } catch (e) { logError('Telegram notification failed: ' + e); }
}

/* STEP 1: paste the token from @BotFather between the quotes, Save, choose setTelegramToken and Run. Then delete the token from the code. */
function setTelegramToken() {
  const TOKEN = '';
  if (!TOKEN) throw new Error('Paste the token between the quotes first.');
  props().setProperty('tg_token', TOKEN.trim());
  Logger.log('Token saved. Now each person opens the bot in Telegram and presses Start, then run findTelegramChats.');
}

/* STEP 2: after everyone pressed Start (or sent any message) to the bot, choose findTelegramChats and Run. */
function findTelegramChats() {
  const token = props().getProperty('tg_token');
  if (!token) throw new Error('Run setTelegramToken first.');
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getUpdates', { muteHttpExceptions: true });
  const data = JSON.parse(res.getContentText());
  if (!data.ok) throw new Error('Telegram says: ' + res.getContentText());
  const found = {};
  (data.result || []).forEach(u => {
    const m = u.message || u.edited_message;
    if (m && m.chat && m.chat.type === 'private') found[m.chat.id] = [m.chat.first_name, m.chat.last_name].filter(Boolean).join(' ') || String(m.chat.id);
  });
  const ids = Object.keys(found);
  if (!ids.length) throw new Error('No one has written to the bot yet. Open the bot in Telegram, press Start, then run this again.');
  props().setProperty('tg_chats', ids.join(','));
  Logger.log('Notifications will go to: ' + ids.map(i => found[i]).join(', '));
  notifyPhones('✅ PRJ notifications are connected. You will get a message here for every new quote request.');
}

/* STEP 3 (any time): sends a test message to everyone who is connected. */
function testTelegram() {
  notifyPhones('🔔 Test from PRJ Logistics: notifications work.');
  Logger.log('Test sent. Check Telegram on your phone.');
}

/* TEST: choose testPaymentMail and click Run. Sends a sample payment email to YOU (OWNER_EMAIL). */
function testPaymentMail() {
  sendPaymentMail('PRJ-000000-TEST2', 'Test Customer', OWNER_EMAIL, 'RG1 1AA Reading', 'B1 1AA Birmingham', 'Today', '£120', 'https://example.com/pay');
  Logger.log('Sample payment email sent to ' + OWNER_EMAIL);
}

/* Run this to see how many emails the script may still send today */
function checkMailQuota() {
  Logger.log('Emails left to send today: ' + MailApp.getRemainingDailyQuota());
}

/* Test: choose testSuggest in the editor, press Run (approve the permission prompt), then read the result in "Execution log" */
function testSuggest() {
  Logger.log(JSON.stringify(suggestPrice('RG1 1AA', 'SW1A 1AA')));
  Logger.log(JSON.stringify(suggestPrice('RG1 1AA', 'B1 1AA')));
}


/* ---------- customer reviews: customers submit on the website, you approve them in the admin panel ---------- */
const REVIEWS_SHEET = 'Reviews';
function reviewsSheet() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(REVIEWS_SHEET);
  if (!sh) { sh = ss.insertSheet(REVIEWS_SHEET); sh.appendRow(['Received', 'Name', 'Rating', 'Review', 'Status', 'ID', 'Town']); }
  return sh;
}
function handleReviewSubmit(d, out) {
  const send = o => out.setContent(JSON.stringify(o));
  try {
    if (String(d.website || '').trim()) return send({ ok: true }); // spam bot: pretend OK
    const name = cleanText(d.name, 60), town = cleanText(d.town, 40), text = cleanText(d.text, 600), rating = Math.round(Number(d.rating));
    if (!name || !town || text.length < 10 || !(rating >= 1 && rating <= 5)) return send({ ok: false, message: 'Please add your name, town, a star rating and a few words (at least 10 characters).' });
    const cache = CacheService.getScriptCache(), day = 'rv_' + Utilities.formatDate(new Date(), 'Europe/London', 'yyyyMMdd');
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const n = Number(cache.get(day) || '0');
      if (n >= 20) return send({ ok: false, message: 'Too many reviews today. Please try again tomorrow.' });
      cache.put(day, String(n + 1), 86400);
      reviewsSheet().appendRow([new Date(), safeCell(name), rating, safeCell(text), 'Pending', Utilities.getUuid().slice(0, 8), safeCell(town)]);
    } finally { lock.releaseLock(); }
    notifyPhones('New review (' + rating + '/5) from ' + name + ' is waiting for your approval in the admin panel (Reviews tab).');
    return send({ ok: true });
  } catch (e) { logError('Review submit failed: ' + e); return send({ ok: false, message: 'Sorry, that did not go through. Please try again.' }); }
}
function shortName(n) { const p = String(n).trim().split(/\s+/); return p.length > 1 ? p[0] + ' ' + p[p.length - 1].charAt(0).toUpperCase() + '.' : p[0]; }
function handleReviewsList(d, out) {
  const send = o => out.setContent(JSON.stringify(o));
  try {
    const rows = reviewsSheet().getDataRange().getValues().slice(1).filter(r => r[4] === 'Approved').reverse().slice(0, 30);
    const list = rows.map(r => ({ name: shortName(r[1]), town: String(r[6] || ''), rating: Number(r[2]), text: String(r[3]),
      date: r[0] instanceof Date ? Utilities.formatDate(r[0], 'Europe/London', 'MMM yyyy') : '' }));
    const avg = list.length ? Math.round(list.reduce((s, r) => s + r.rating, 0) / list.length * 10) / 10 : 0;
    return send({ ok: true, reviews: list, avg: avg, count: list.length });
  } catch (e) { return send({ ok: true, reviews: [], avg: 0, count: 0 }); }
}
function allReviews() {
  return reviewsSheet().getDataRange().getValues().slice(1).map(r => ({
    id: String(r[5]), name: String(r[1]), town: String(r[6] || ''), rating: Number(r[2]), text: String(r[3]), status: String(r[4]),
    date: r[0] instanceof Date ? Utilities.formatDate(r[0], 'Europe/London', 'd MMM yyyy, HH:mm') : '' })).reverse();
}
function setReviewStatus(id, status) {
  if (!id || ['Approved', 'Hidden', 'Delete'].indexOf(status) < 0) return { ok: false, message: 'Not valid.' };
  const sh = reviewsSheet(), rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][5]) === id) {
      if (status === 'Delete') sh.deleteRow(i + 1); else sh.getRange(i + 1, 5).setValue(status);
      return { ok: true };
    }
  }
  return { ok: false, message: 'Review not found.' };
}


/* ---------- regular customers: client accounts (you create them in the admin panel) ----------
   Sheet "Clients": Email | Name | Company | Phone | Active | Created | Saved addresses (JSON)
   Passwords are stored hashed in the script's hidden settings, never in the sheet. */
const CLIENTS_SHEET = 'Clients';
function clientsSheet() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(CLIENTS_SHEET);
  if (!sh) { sh = ss.insertSheet(CLIENTS_SHEET); sh.appendRow(['Email', 'Name', 'Company', 'Phone', 'Active', 'Created', 'Saved addresses']); }
  return sh;
}
/* agreed per-mile rates for a regular client (columns H-J of Clients): blank = no agreed rate */
function rateNum(v) { const n = Number(String(v == null ? '' : v).replace(/[£,\s]/g, '')); return String(v == null ? '' : v).trim() !== '' && isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0; }
function ensureClientRateHeaders(sh) {
  if (!sh.getRange(1, 8).getValue()) sh.getRange(1, 8, 1, 3).setValues([['Rate per mile', '(not used)', 'Minimum price']]);
  if (!sh.getRange(1, 11).getValue()) sh.getRange(1, 11).setValue('Demo account');
}
function hasAgreedRate(c) { return !!(c && (c.rateSwb || c.rateLwb)); }
function agreedRate(c) { return (c && (c.rateSwb || c.rateLwb)) || 0; }   // one rate per mile for the client (older accounts may have it in the LWB column)
function parseAddrs(v) { try { const a = JSON.parse(String(v || '[]')); return Array.isArray(a) ? a.filter(x => x && x.text).slice(0, 20) : []; } catch (e) { return []; } }
function findClient(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!validEmail(e)) return null;
  const rows = clientsSheet().getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim().toLowerCase() === e) {
      return { row: i + 1, email: e, name: String(rows[i][1]), company: String(rows[i][2] || ''), phone: String(rows[i][3] || ''),
        active: String(rows[i][4]) !== 'No', addresses: parseAddrs(rows[i][6]),
        rateSwb: rateNum(rows[i][7]), rateLwb: rateNum(rows[i][8]), minPrice: rateNum(rows[i][9]), demo: String(rows[i][10]) === 'Yes' };
    }
  }
  return null;
}
function setClientPassword(email, password) {
  if (String(password).length < 10) throw new Error('Password must be at least 10 characters.');
  const salt = Utilities.getUuid();
  props().setProperty('cpw_' + email, salt + ':' + hashPassword(salt, String(password)));
  props().setProperty('cver_' + email, String(Number(props().getProperty('cver_' + email) || '1') + 1));
}
function verifyClientPassword(email, password) {
  const stored = props().getProperty('cpw_' + email);
  if (!stored || !String(password || '')) return false;
  const salt = stored.split(':')[0];
  return hashPassword(salt, String(password)) === stored.slice(salt.length + 1);
}
function makeClientToken(email) {
  const exp = Date.now() + SESSION_DAYS * 86400000, ver = props().getProperty('cver_' + email) || '1';
  const body = 'c|' + email + '|' + exp + '|' + ver;
  return body + '|' + sign(body);
}
function checkClientToken(key) {
  const p = String(key || '').split('|');
  if (p.length !== 5 || p[0] !== 'c') return null;
  const email = p[1], exp = Number(p[2]), ver = p[3];
  if (!(exp > Date.now()) || ver !== (props().getProperty('cver_' + email) || '1')) return null;
  if (sign(p[0] + '|' + email + '|' + p[2] + '|' + ver) !== p[4]) return null;
  const c = findClient(email);
  return c && c.active ? c : null;
}
function recentAddresses(email) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sh) return [];
  const rows = sh.getDataRange().getValues(), seen = {}, out = [];
  for (let i = rows.length - 1; i >= 1 && out.length < 10; i--) {
    if (String(rows[i][4]).trim().toLowerCase() !== email) continue;
    [rows[i][8], rows[i][9]].forEach(a => { const t = String(a || '').trim(); if (t && !seen[t.toLowerCase()] && out.length < 10) { seen[t.toLowerCase()] = 1; out.push(t); } });
  }
  return out;
}
function handleClient(d, out) {
  const send = o => out.setContent(JSON.stringify(o));
  try {
    const cache = CacheService.getScriptCache();
    if (d.action === 'client_login') {
      const email = String(d.email || '').trim().toLowerCase(), ck = 'lf_c_' + (validEmail(email) ? email : 'unknown');
      const fails = Number(cache.get(ck) || 0);
      if (fails >= 10) return send({ ok: false, message: 'Too many wrong attempts. Try again in 10 minutes.' });
      const c = findClient(email);
      if (c && c.active && verifyClientPassword(email, d.password)) { cache.remove(ck); return send({ ok: true, token: makeClientToken(email) }); }
      cache.put(ck, String(fails + 1), 600);
      return send({ ok: false, message: 'Wrong email or password.' });
    }
    if (d.action === 'client_demo_login') {   // QR code on the meeting table: opens the demo account without typing a password
      const dk = 'dl_' + Utilities.formatDate(new Date(), 'Europe/London', 'yyyyMMdd'), dn = Number(cache.get(dk) || 0);
      if (dn >= 300) return send({ ok: false, message: 'The demo is busy. Please try again later.' });
      cache.put(dk, String(dn + 1), 86400);
      const rows = clientsSheet().getDataRange().getValues();
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][10]) === 'Yes' && String(rows[i][4]) !== 'No' && validEmail(String(rows[i][0]).trim())) {
          return send({ ok: true, token: makeClientToken(String(rows[i][0]).trim().toLowerCase()) });
        }
      }
      return send({ ok: false, message: 'The demo is not available at the moment.' });
    }
    const c = checkClientToken(d.key);
    if (!c) return send({ ok: false, message: LOGIN_AGAIN });
    if (d.action === 'client_me') return send({ ok: true, name: c.name, company: c.company, phone: c.phone, email: c.email, saved: c.addresses, recent: recentAddresses(c.email),
      agreed: hasAgreedRate(c) ? { rate: agreedRate(c), min: c.minPrice || 0 } : null, demo: !!c.demo });
    if (d.action === 'client_price') {
      if (!hasAgreedRate(c)) return send({ ok: true, instant: false });
      const pk = 'cp_' + c.email + Utilities.formatDate(new Date(), 'Europe/London', 'yyyyMMdd'), pn = Number(cache.get(pk) || 0);
      if (pn >= 300) return send({ ok: true, instant: false, reason: 'limit' });
      cache.put(pk, String(pn + 1), 86400);
      return send(clientInstantPrice(c, cleanText(d.from, 200), cleanText(d.to, 200)));
    }
    if (d.action === 'client_address') {
      const text = cleanText(d.text, 200);
      if (!text) return send({ ok: false, message: 'Address missing.' });
      let list = c.addresses.filter(a => String(a.text).toLowerCase() !== text.toLowerCase());
      if (d.op === 'add') list.unshift({ text: text });
      list = list.slice(0, 20);
      clientsSheet().getRange(c.row, 7).setValue(JSON.stringify(list));
      return send({ ok: true, saved: list });
    }
    if (d.action === 'client_password') {
      const ck = 'lf_c_' + c.email;
      if (Number(cache.get(ck) || 0) >= 10) return send({ ok: false, message: 'Too many wrong attempts. Try again in 10 minutes.' });
      if (!verifyClientPassword(c.email, d.oldPassword)) { cache.put(ck, String(Number(cache.get(ck) || 0) + 1), 600); return send({ ok: false, message: 'Current password is wrong.' }); }
      if (String(d.newPassword || '').length < 10) return send({ ok: false, message: 'New password must be at least 10 characters.' });
      setClientPassword(c.email, d.newPassword);
      return send({ ok: true, token: makeClientToken(c.email) });
    }
    if (d.action === 'client_book') return clientBook(d, c, send);
    return send({ ok: false });
  } catch (err) {
    logError('Client request failed: ' + err);
    return send({ ok: false, message: 'Something went wrong. Please try again.' });
  }
}
/* Price at the client's agreed rate: road miles (route without traffic, so the price stays the same all day) x rate per mile, at least the minimum.
   London jobs (ULEZ / Congestion Charge) are not priced automatically: they go through the normal quote. */
function clientInstantPrice(c, from, to) {
  if (!hasAgreedRate(c)) return { ok: true, instant: false };
  if (!from || !to) return { ok: true, instant: false, reason: 'addresses' };
  const ck = 'cpr_' + Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, from.toLowerCase() + '|' + to.toLowerCase()).map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('').slice(0, 40);
  const cache = CacheService.getScriptCache();
  let r = null;
  try { r = JSON.parse(cache.get(ck) || 'null'); } catch (e) { r = null; }
  if (!r) {
    const ga = geocodeUK(from), gb = geocodeUK(to);
    if (!ga || !ga.p || !gb || !gb.p) return { ok: true, instant: false, reason: 'address', message: 'We could not find ' + (!(ga && ga.p) ? 'the collection address' : 'the delivery address') + ' on the map. Send the request and we will price it for you.' };
    if (ga.london || gb.london) return { ok: true, instant: false, reason: 'london', message: 'London jobs include ULEZ and Congestion Charge, so we price them for you. Send the request and we will reply quickly.' };
    const rt = osrmRoute(ga.p, gb.p) || routeMiles(ga.p, gb.p, '');
    r = { miles: Math.round(rt.miles * 10) / 10, exact: !!rt.exact };
    cache.put(ck, JSON.stringify(r), 21600);
  }
  const mi = Math.max(1, Math.round(r.miles)), rate = agreedRate(c);
  const price = Math.max(c.minPrice || 0, Math.round(mi * rate));
  return { ok: true, instant: true, miles: mi, approx: !r.exact, price: price, text: priceText(price), rate: rate, min: (c.minPrice || 0) > Math.round(mi * rate) };
}
function clientBook(d, c, send) {
  const from = cleanText(d.from, 200), to = cleanText(d.to, 200), when = cleanText(d.when, 80), van = cleanText(d.van, 60), load = cleanText(d.load, 300);
  if (!from || !to || !load) return send({ ok: false, message: 'Please fill in where from, where to, and what we are carrying.' });
  if (c.demo) return clientBookDemo(d, c, send, from, to, when, van, load);
  if (d.instant) return clientBookInstant(d, c, send, from, to, when, van, load);
  const cache = CacheService.getScriptCache(), dk = 'cb_' + c.email + Utilities.formatDate(new Date(), 'Europe/London', 'yyyyMMdd');
  const n = Number(cache.get(dk) || 0);
  if (n >= 30) return send({ ok: false, message: 'Too many requests today. Please call or email us.' });
  const ref = newRef(), phone = c.phone;
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    cache.put(dk, String(n + 1), 86400);
    const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
    const crow = [safeCell(ref), 'Requested', new Date(), '', safeCell(c.email), '', '', '', safeCell(from), safeCell(to), '',
      safeCell(c.name + (c.company ? ' (' + c.company + ')' : '')), safeCell(phone), safeCell(when), safeCell(van), safeCell(load), '', ''];
    while (crow.length < 27) crow.push('');
    crow.push(c.company ? 'Business' : 'Private', safeCell(c.company || ''));
    ensureDetailHeaders(sh);
    sh.appendRow(crow);
  } finally { lock.releaseLock(); }
  try { MailApp.sendEmail({ to: OWNER_EMAIL, subject: 'New request from regular client ' + c.name + ' (' + ref + ')', replyTo: c.email, name: COMPANY + ' website',
    body: 'Reference: ' + ref + '\nClient: ' + c.name + (c.company ? ' (' + c.company + ')' : '') + '\nEmail: ' + c.email + '\nPhone: ' + (phone || '-') +
      '\n\nCollect from: ' + from + '\nDeliver to: ' + to + '\nCollection: ' + when + '\nVehicle: ' + van + '\nLoad: ' + load + '\n\nIt is in your admin panel under Requests.' }); } catch (e) { logError('Owner email failed for ' + ref + ': ' + e); }
  try { sendQuoteAck(ref, c.name, c.email, from, to, when, load); } catch (e) { logError('Client confirmation email failed for ' + ref + ': ' + e); }
  notifyPhones('\uD83C\uDD95 Regular client request ' + ref + '\n' + c.name + (c.company ? ' (' + c.company + ')' : '') + '\n' + from + ' \u2192 ' + to + '\n' + (when ? when + '\n' : '') + load + '\nOpen the admin panel to send the quote.');
  return send({ ok: true, ref: ref });
}
/* Demo account (for showing the client panel to a potential customer): the booking looks real in the panel,
   but nothing is saved. The demo account's email gets the usual confirmation marked [DEMO],
   and the office phones get a clearly marked DEMO notification. */
function clientBookDemo(d, c, send, from, to, when, van, load) {
  const ref = 'DEMO-' + newRef().slice(4);
  let price = '';
  if (d.instant) {
    const q = clientInstantPrice(c, from, to);
    if (!q.instant) return send({ ok: false, message: q.message || 'We cannot price this trip automatically. Send it as a request and we will price it for you.' });
    price = q.text;
  }
  notifyPhones('\uD83E\uDDEA DEMO ' + (price ? 'booking at ' + price : 'request') + ' (test account, nothing booked)\n' + c.name + (c.company ? ' (' + c.company + ')' : '') + '\n' + from + ' \u2192 ' + to + '\n' + load);
  try {   // the same confirmation email a real client gets, marked DEMO, to the email of the demo account
    const first = c.name.split(' ')[0] || 'there';
    const msg = price
      ? 'Thank you, your booking ' + ref + ' is in at your agreed price of ' + price + '. We will confirm your collection time shortly.'
      : 'Thank you, we have your request ' + ref + '. We will email you a price shortly. Nothing is booked until you accept it.';
    sendCustomerMail({ to: c.email, subject: '[DEMO] ' + (price ? 'Booked at ' + price : 'We received your request') + ' (' + ref + ')',
      htmlBody: '<div style="font-family:Arial,sans-serif;font-size:15px;color:#0E1726;max-width:560px"><p style="color:#6B7684;font-size:13px">DEMO: this is how the email looks for a real booking. Nothing was booked.</p><p>Hello ' + esc(first) + ',</p><p>' + esc(msg) + '</p><p>Collect from: ' + esc(from) + '<br>Deliver to: ' + esc(to) + '<br>Collection: ' + esc(when || 'as soon as possible') + '<br>Load: ' + esc(load) + '</p><p>Kind regards,<br>' + esc(COMPANY) + '</p></div>',
      body: 'DEMO: nothing was booked.\n\n' + msg, replyTo: OWNER_EMAIL, name: COMPANY });
  } catch (e) { logError('Demo email failed: ' + e); }
  return send({ ok: true, ref: ref, booked: !!price, price: price, demo: true });
}
function clientBookInstant(d, c, send, from, to, when, van, load) {
  const q = clientInstantPrice(c, from, to);
  if (!q.instant) return send({ ok: false, message: q.message || 'We cannot price this trip automatically. Send it as a request and we will price it for you.' });
  const price = q.text;
  if (cleanText(d.expect, 40) !== price) return send({ ok: false, priceChanged: true, price: price, message: 'The price for this trip is ' + price + '. Please check and book again.' });
  const cache = CacheService.getScriptCache(), dk = 'cb_' + c.email + Utilities.formatDate(new Date(), 'Europe/London', 'yyyyMMdd');
  const n = Number(cache.get(dk) || 0);
  if (n >= 30) return send({ ok: false, message: 'Too many requests today. Please call or email us.' });
  const ref = newRef(), now = new Date(), vanText = van || 'Not sure, you choose';
  const how = q.miles + ' miles x ' + priceText(q.rate) + ' per mile' + (q.min ? ' (minimum ' + priceText(c.minPrice) + ')' : '');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    cache.put(dk, String(n + 1), 86400);
    const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
    const crow = [safeCell(ref), 'Requested', now, '', safeCell(c.email), '', '', '', safeCell(from), safeCell(to), '',
      safeCell(c.name + (c.company ? ' (' + c.company + ')' : '')), safeCell(c.phone), safeCell(when), vanText, safeCell(load), q.miles, '', price,
      now, Utilities.getUuid().replace(/-/g, ''), price, 'Accepted', now, safeCell('Booked online at the agreed rate: ' + how)];
    while (crow.length < 27) crow.push('');
    crow.push(c.company ? 'Business' : 'Private', safeCell(c.company || ''));
    ensureDetailHeaders(sh);
    sh.appendRow(crow);
  } finally { lock.releaseLock(); }
  const line = c.name + (c.company ? ' (' + c.company + ')' : '');
  try { MailApp.sendEmail({ to: OWNER_EMAIL, subject: 'BOOKED at agreed rate: ' + ref + ' ' + price + ' (' + line + ')', replyTo: c.email, name: COMPANY + ' website',
    body: 'Reference: ' + ref + '\nClient: ' + line + '\nEmail: ' + c.email + '\nPhone: ' + (c.phone || '-') + '\n\nPrice: ' + price + ' (' + how + ')\nCollect from: ' + from + '\nDeliver to: ' + to +
      '\nCollection: ' + when + '\nLoad: ' + load + '\n\nThe price is accepted. Open the admin panel and tap "Confirm booking and email customer".' }); } catch (e) { logError('Owner email failed for ' + ref + ': ' + e); }
  try {
    const first = c.name.split(' ')[0] || 'there';
    const msg = 'Thank you, your booking ' + ref + ' is in at your agreed price of ' + price + ' (' + how + '). We will confirm your collection time shortly.';
    sendCustomerMail({ to: c.email, subject: 'Booked at ' + price + ' (' + ref + ')',
      htmlBody: '<div style="font-family:Arial,sans-serif;font-size:15px;color:#0E1726;max-width:560px"><p>Hello ' + esc(first) + ',</p><p>' + esc(msg) + '</p><p>Collect from: ' + esc(from) + '<br>Deliver to: ' + esc(to) + '<br>Collection: ' + esc(when || 'as soon as possible') + '</p><p>Kind regards,<br>' + esc(COMPANY) + '</p></div>',
      body: msg, replyTo: OWNER_EMAIL, name: COMPANY });
  } catch (e) { logError('Client booking email failed for ' + ref + ': ' + e); }
  notifyPhones('\u26A1 BOOKED at agreed rate ' + ref + ' \u00b7 ' + price + '\n' + line + '\n' + from + ' \u2192 ' + to + '\n' + (when ? when + '\n' : '') + load + '\nOpen the admin panel and confirm the collection time.');
  return send({ ok: true, ref: ref, booked: true, price: price });
}
function allClients() {
  return clientsSheet().getDataRange().getValues().slice(1).filter(r => r[0]).map(r => ({
    email: String(r[0]), name: String(r[1]), company: String(r[2] || ''), phone: String(r[3] || ''), active: String(r[4]) !== 'No',
    rateSwb: rateNum(r[7]), rateLwb: rateNum(r[8]), rate: rateNum(r[7]) || rateNum(r[8]), minPrice: rateNum(r[9]), demo: String(r[10]) === 'Yes' }));
}
function saveClientByAdmin(d) {
  const email = cleanText(d.email, 120).toLowerCase(), name = cleanText(d.name, 100), company = cleanText(d.company, 100), phone = ukPhone(d.phone);
  if (!validEmail(email) || !name || phone === null) return { ok: false, message: 'Please give a valid email, a name and a UK phone number (or leave the phone empty).' };
  const pw = String(d.password || ''), active = d.active === false ? 'No' : 'Yes';
  const sh = clientsSheet(), ex = findClient(email);
  if (!ex && pw.length < 10) return { ok: false, message: 'New client: set a temporary password of at least 10 characters.' };
  if (pw && pw.length < 10) return { ok: false, message: 'The password must be at least 10 characters.' };
  if (d.rate !== undefined) { d.rateSwb = d.rate; d.rateLwb = ''; }   // one agreed rate per mile (stored in column H)
  const rv = k => String(d[k] == null ? '' : d[k]).trim();
  const rates = ['rateSwb', 'rateLwb', 'minPrice'].map(k => rv(k) === '' ? '' : rateNum(rv(k)));
  if ((rv('rateSwb') && !(rates[0] > 0 && rates[0] <= 20)) || (rv('rateLwb') && !(rates[1] > 0 && rates[1] <= 20))) return { ok: false, message: 'The rate per mile must be a number between 0.01 and 20, e.g. 1.60.' };
  if (rv('minPrice') && !(rates[2] > 0 && rates[2] <= 2000)) return { ok: false, message: 'The minimum price must be a number, e.g. 45.' };
  if (rv('minPrice') && !rates[0] && !rates[1]) return { ok: false, message: 'Add a rate per mile, or leave the minimum empty.' };
  ensureClientRateHeaders(sh);
  if (ex) sh.getRange(ex.row, 2, 1, 4).setValues([[safeCell(name), safeCell(company), safeCell(phone), active]]);
  else sh.appendRow([email, safeCell(name), safeCell(company), safeCell(phone), active, new Date(), '[]']);
  const crow = ex ? ex.row : sh.getLastRow();
  if (d.rateSwb !== undefined || d.rateLwb !== undefined || d.minPrice !== undefined) sh.getRange(crow, 8, 1, 3).setValues([rates]);
  if (d.demo !== undefined) sh.getRange(crow, 11).setValue(d.demo ? 'Yes' : '');
  if (pw) setClientPassword(email, pw);
  return { ok: true, created: !ex };
}

function deleteClientByAdmin(d) {
  const c = findClient(cleanText(d.email, 120));
  if (!c) return { ok: false, message: 'Client not found.' };
  clientsSheet().deleteRow(c.row);
  props().deleteProperty('cpw_' + c.email);
  props().deleteProperty('cver_' + c.email);
  return { ok: true };
}



/* ===================== office tools: notes, payment reminders, review requests, monthly invoices, push =====================
   Column AW = review request sent (date), column AX = last payment reminder (date).
   Sheet "Notes": one note per customer (key = email, or phone digits when there is no email).
   Sheet "Invoices": every monthly invoice (number, date, month, customer, email, references, total, sent to). */
const REVIEW_ASK_COL = 49;   // column AW
const PAY_REMIND_COL = 50;   // column AX
const NOTES_SHEET = 'Notes';
const INVOICES_SHEET = 'Invoices';
const REVIEW_PAGE = SITE_URL + '/#rvform';

function notesSheet() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(NOTES_SHEET);
  if (!sh) { sh = ss.insertSheet(NOTES_SHEET); sh.appendRow(['Customer', 'Note', 'Updated', 'By']); }
  return sh;
}
function invoicesSheet() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(INVOICES_SHEET);
  if (!sh) { sh = ss.insertSheet(INVOICES_SHEET); sh.appendRow(['Number', 'Created', 'Month', 'Customer', 'Email', 'References', 'Total', 'Sent to', 'Status', 'Status changed']); }
  if (!sh.getRange(1, 9).getValue()) sh.getRange(1, 9, 1, 2).setValues([['Status', 'Status changed']]);
  return sh;
}
/* the same customer key in the server and in the admin panel: email (lower case), or the phone digits */
function custKey(email, phone) {
  const e = String(email || '').trim().toLowerCase();
  if (validEmail(e)) return e;
  const p = String(phone || '').replace(/\D/g, '');
  return p ? 'tel:' + p.replace(/^44/, '0') : '';
}
function allNotes() {
  const out = {};
  notesSheet().getDataRange().getValues().slice(1).forEach(r => { if (r[0]) out[String(r[0])] = { note: String(r[1] || ''), updated: isoOf(r[2]), by: String(r[3] || '') }; });
  return out;
}
function saveNote(key, note, by) {
  key = cleanText(key, 130).toLowerCase();
  if (!key) return { ok: false, message: 'No customer.' };
  note = String(note || '').slice(0, 2000);
  const sh = notesSheet(), rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) if (String(rows[i][0]) === key) {
    if (!note.trim()) { sh.deleteRow(i + 1); return { ok: true }; }
    sh.getRange(i + 1, 2, 1, 3).setValues([[safeCell(note), new Date(), by]]);
    return { ok: true };
  }
  if (note.trim()) sh.appendRow([key, safeCell(note), new Date(), by]);
  return { ok: true };
}
function officeSettings() {
  const p = props();
  const b = bankDetails();
  const R = priceRates();
  let tpl = null; try { tpl = JSON.parse(p.getProperty('outreach_tpl') || 'null'); } catch (e) {}
  let tplLaw = null; try { tplLaw = JSON.parse(p.getProperty('outreach_tpl_law') || 'null'); } catch (e) {}
  let goals = {}; try { goals = JSON.parse(p.getProperty('goals') || '{}') || {}; } catch (e) {}
  return { goals: goals, stripe: !!stripeKey(), priceOnWeb: p.getProperty('price_on_web') !== 'off', outreachTpl: tpl, outreachTplLaw: tplLaw, rateBusiness: R.business, ratePrivate: R.private, minCharge: R.min, minPrivate: R.minPrivate, minBusiness: R.minBusiness, rateMile: R.business, rateLondon: R.london, googleReview: p.getProperty('google_review_url') || '', autoReview: p.getProperty('auto_review') === 'on', bank: p.getProperty('invoice_bank') || '',
    bankName: b.name, sortCode: b.sort, accNo: b.acc, bankNote: b.note };
}
/* bank details for invoices and reminders: {name, sort, acc, note} (empty strings when not set) */
function bankDetails() {
  try { const j = JSON.parse(props().getProperty('invoice_bank_json') || 'null'); if (j && j.name) return { name: String(j.name), sort: String(j.sort), acc: String(j.acc), note: String(j.note || '') }; } catch (e) {}
  return { name: '', sort: '', acc: '', note: '' };
}
function saveOfficeSettings(d) {
  const p = props();
  if (d.googleReview !== undefined) {
    const u = String(d.googleReview || '').trim();
    if (u && !/^https:\/\/[^\s<>"']{4,300}$/.test(u)) return { ok: false, message: 'The Google review link must start with https://' };
    if (u) p.setProperty('google_review_url', u); else p.deleteProperty('google_review_url');
  }
  if (d.autoReview !== undefined) p.setProperty('auto_review', d.autoReview ? 'on' : 'off');
  if (d.priceOnWeb !== undefined) p.setProperty('price_on_web', d.priceOnWeb ? 'on' : 'off');
  if (d.goal) {   // monthly goal shown in the corner of the admin panel: {month 'yyyy-MM', money, jobs}
    const g = d.goal, month = String(g.month || '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return { ok: false, message: 'Choose the month.' };
    const money = Math.round(rateNum(g.money) || 0), jobsN = Math.round(Number(String(g.jobs || '').replace(/[^\d.]/g, '')) || 0);
    if (!(money >= 0 && money <= 1000000) || !(jobsN >= 0 && jobsN <= 10000)) return { ok: false, message: 'Enter the goal as numbers, e.g. 5000 and 30.' };
    let goals = {}; try { goals = JSON.parse(p.getProperty('goals') || '{}') || {}; } catch (e) {}
    if (!money && !jobsN) delete goals[month]; else goals[month] = { money: money, jobs: jobsN };
    Object.keys(goals).sort().slice(0, -24).forEach(k => delete goals[k]);   // keep two years
    p.setProperty('goals', JSON.stringify(goals));
  }
  if (d.outreachTplLaw !== undefined) {   // second Outreach template: solicitors and accountants
    const t = d.outreachTplLaw || {};
    if (t.subject || t.body) p.setProperty('outreach_tpl_law', JSON.stringify({ subject: cleanText(t.subject, 150), body: String(t.body || '').replace(/\r/g, '').slice(0, 5000) }));
    else p.deleteProperty('outreach_tpl_law');
  }
  if (d.outreachTpl !== undefined) {
    const t = d.outreachTpl || {};
    if (t.subject || t.body) p.setProperty('outreach_tpl', JSON.stringify({ subject: cleanText(t.subject, 150), body: String(t.body || '').replace(/\r/g, '').slice(0, 5000) }));
    else p.deleteProperty('outreach_tpl');
  }
  if (d.minPrivate !== undefined || d.minBusiness !== undefined) {   // minimum charge for each type of customer (empty = none)
    const mv = v => String(v == null ? '' : v).trim() === '' ? 0 : rateNum(v), a = mv(d.minPrivate), b2 = mv(d.minBusiness);
    const bad = v => String(v == null ? '' : v).trim() !== '' && !(rateNum(v) > 0 && rateNum(v) <= 1000) && !/^\s*£?\s*0*(\.0+)?\s*$/.test(String(v));
    if (bad(d.minPrivate) || bad(d.minBusiness)) return { ok: false, message: 'The minimum charge must be a number, e.g. 45 (or leave it empty for none).' };
    if (d.minPrivate !== undefined) p.setProperty('min_private', String(a));
    if (d.minBusiness !== undefined) p.setProperty('min_business', String(b2));
  }
  if (d.rateBusiness !== undefined || d.ratePrivate !== undefined || d.rateLondon !== undefined || d.minCharge !== undefined || d.rateMile !== undefined) {
    const R = priceRates(), num = (v, def) => v === undefined ? def : rateNum(v);
    const b = num(d.rateBusiness !== undefined ? d.rateBusiness : d.rateMile, R.business), pr = num(d.ratePrivate, R.private), l = num(d.rateLondon, R.london);
    const mc = d.minCharge === undefined ? R.min : (String(d.minCharge).trim() === '' ? 0 : rateNum(d.minCharge));
    if (![b, pr, l].every(x => x >= 0.2 && x <= 20)) return { ok: false, message: 'Enter the rates per mile, e.g. 2.00, 1.84 and 2.40.' };
    if (!(mc >= 0 && mc <= 1000) || (d.minCharge !== undefined && !mc && !/^\s*£?\s*0*(\.0+)?\s*$/.test(String(d.minCharge)))) return { ok: false, message: 'The minimum charge must be a number, e.g. 45 (or leave it empty for none).' };
    p.setProperty('rate_business', String(b)); p.setProperty('rate_private', String(pr)); p.setProperty('rate_london', String(l)); p.setProperty('min_charge', String(mc));
    if (d.minCharge !== undefined) { p.setProperty('min_private', String(mc)); p.setProperty('min_business', String(mc)); }   // one minimum for both
    try { logUpload('-', 'Prices changed: private ' + priceText(pr) + ', business ' + priceText(b) + ', London ' + priceText(l) + ' per mile, minimum ' + (mc ? priceText(mc) : 'none'), 'admin', 0); } catch (e) {}
  }
  if (d.bank !== undefined) { const b = String(d.bank || '').trim().slice(0, 300); if (b) p.setProperty('invoice_bank', b); else p.deleteProperty('invoice_bank'); }
  if (d.bankName !== undefined || d.sortCode !== undefined || d.accNo !== undefined) {
    const name = cleanText(d.bankName, 80), sort = String(d.sortCode || '').replace(/\D/g, ''), acc = String(d.accNo || '').replace(/\D/g, ''), note = cleanText(d.bankNote, 120);
    if (!name || sort.length !== 6 || acc.length !== 8) return { ok: false, message: 'Please give the account name, a 6-digit sort code and an 8-digit account number.' };
    const nice = sort.slice(0, 2) + '-' + sort.slice(2, 4) + '-' + sort.slice(4);
    p.setProperty('invoice_bank_json', JSON.stringify({ name: name, sort: nice, acc: acc, note: note }));
    p.setProperty('invoice_bank', 'Account name ' + name + ', sort code ' + nice + ', account number ' + acc + (note ? ', ' + note : ''));
  }
  return { ok: true, settings: officeSettings() };
}
function findJobRow(sh, ref) {
  ref = String(ref || '').trim();
  const refs = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
  for (let i = 1; i < refs.length; i++) if (String(refs[i][0]).trim() === ref) return i + 1;
  return 0;
}

/* friendly payment reminder (card link, or bank transfer for invoice customers) */
function sendPayReminderMail(ref, name, email, price, link, invoice, deliveredText) {
  const first = String(name).split(' ')[0] || 'there', bank = props().getProperty('invoice_bank') || '';
  const okLink = /^https:\/\/[^\s<>"']{4,280}$/.test(link || '') ? link : '';
  const html =
    '<div style="font-family:Arial,sans-serif;font-size:15px;color:#0E1726;max-width:560px">' +
    '<h2 style="margin:0 0 8px">A quick reminder about payment</h2>' +
    '<p>Hello ' + esc(first) + ',</p>' +
    '<p>Thank you again for using ' + esc(COMPANY) + '. Our records show that payment for your delivery is still open. If you have already paid, thank you, and please ignore this email.</p>' +
    '<p style="font-size:20px;margin:14px 0"><b>Amount: ' + esc(price) + '</b></p>' +
    '<p><b>Reference:</b> ' + esc(ref) + (deliveredText ? '<br><b>Delivered:</b> ' + esc(deliveredText) : '') + '</p>' +
    (okLink ? '<p style="margin:22px 0"><a href="' + esc(okLink) + '" style="background:#77B72B;color:#0E1726;text-decoration:none;font-weight:bold;padding:14px 24px;border-radius:10px;display:inline-block">Pay ' + esc(price) + ' securely</a></p>' : '') +
    (!okLink && bank ? '<p><b>Bank transfer:</b> ' + esc(bank) + '<br>Please use <b>' + esc(ref) + '</b> as the payment reference.</p>' : '') +
    (!okLink && !bank ? '<p>Please reply to this email and we will send you the payment details.</p>' : '') +
    '<p>Questions? Reply to this email or call us on ' + esc(PHONE) + '.</p>' +
    '<p>Kind regards,<br>' + esc(COMPANY) + '</p></div>';
  sendCustomerMail({
    to: email, subject: 'Payment reminder (' + ref + ')', htmlBody: html,
    body: 'A quick reminder: payment of ' + price + ' for delivery ' + ref + ' is still open.' + (okLink ? ' Pay securely: ' + okLink : (bank ? ' Bank transfer: ' + bank + ', reference ' + ref : '')) + ' If you have already paid, please ignore this email. ' + COMPANY,
    replyTo: OWNER_EMAIL, name: COMPANY
  });
}

/* after delivery: ask how it went (site review form, and Google if a link is set) */
function sendReviewAskMail(ref, name, email) {
  const first = String(name).split(' ')[0] || 'there', g = props().getProperty('google_review_url') || '';
  const btn = (href, text, bg) => '<a href="' + esc(href) + '" style="background:' + bg + ';color:#0E1726;text-decoration:none;font-weight:bold;padding:13px 22px;border-radius:10px;display:inline-block;margin:0 8px 8px 0">' + text + '</a>';
  const html =
    '<div style="font-family:Arial,sans-serif;font-size:15px;color:#0E1726;max-width:560px">' +
    '<h2 style="margin:0 0 8px">How did we do?</h2>' +
    '<p>Hello ' + esc(first) + ',</p>' +
    '<p>Thank you for choosing ' + esc(COMPANY) + ' for your delivery (' + esc(ref) + '). We are a small local team, so a few words from you really help other people find us.</p>' +
    '<p>It takes less than a minute:</p>' +
    '<p style="margin:18px 0">' + (g ? btn(g, '★ Review us on Google', '#77B72B') : '') + btn(REVIEW_PAGE, g ? 'Review on our website' : '★ Leave a quick review', g ? '#E8EDF3' : '#77B72B') + '</p>' +
    '<p>If anything was not right, please just reply to this email. We would like to hear about it and put it right.</p>' +
    '<p>Thank you,<br>Pawel and Patryk<br>' + esc(COMPANY) + '</p></div>';
  sendCustomerMail({
    to: email, subject: 'How did we do? (' + ref + ')', htmlBody: html,
    body: 'Thank you for choosing ' + COMPANY + ' (' + ref + '). Could you leave us a quick review? ' + (g ? g + ' or ' : '') + REVIEW_PAGE + ' . If anything was not right, just reply to this email.',
    replyTo: OWNER_EMAIL, name: COMPANY
  });
}

/* runs every hour on the server: review requests a few hours after delivery (only when switched on in the admin panel) */
function autoReviewRequests() {
  const out = { sent: 0 };
  if (props().getProperty('auto_review') !== 'on') return out;
  const hour = Number(Utilities.formatDate(new Date(), 'Europe/London', 'HH'));
  if (hour < 9 || hour > 19) return out;   // no emails at night
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sh || sh.getLastRow() < 2) return out;
  const rows = sh.getDataRange().getValues(), now = Date.now();
  for (let i = 1; i < rows.length && out.sent < 20; i++) {
    const r = rows[i];
    if (String(r[1]).trim() !== 'Delivered' || r[REVIEW_ASK_COL - 1] || !validEmail(String(r[4]).trim())) continue;
    const at = dateOf(r[DONE_D_COL - 1]) || dateOf(r[2]);
    if (!at) continue;
    const age = now - at.getTime();
    if (age < 3 * 3600000 || age > 72 * 3600000) continue;
    sendReviewAskMail(String(r[0]).trim(), cleanText(r[11], 100), String(r[4]).trim());
    sh.getRange(i + 1, REVIEW_ASK_COL).setValue(new Date());
    out.sent++;
  }
  if (out.sent) { try { logUpload('-', 'Review requests sent automatically: ' + out.sent, 'automatic', 0); } catch (e) {} }
  return out;
}

/* ---------- monthly invoice for business customers: one PDF with every delivered job of the month ---------- */
function invoiceJobs(rows, month, key) {
  const list = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[1]).trim() !== 'Delivered') continue;
    if (String(jobDay(r[13], r[2]) || '').slice(0, 7) !== month) continue;
    if (invoiceKey(r) !== key) continue;
    list.push(r);
  }
  return list;
}
function invoiceKey(r) {
  const c = String(r[28] || '').trim().toLowerCase();
  if (c) return 'co:' + c;
  return custKey(r[29] || r[4], r[12]);
}
function priceNum(v) { const m = String(v || '').replace(/,/g, '').match(/\d+(\.\d+)?/); return m ? parseFloat(m[0]) : 0; }
function monthLabel(month) { const p = String(month).split('-'); return ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][Number(p[1]) - 1] + ' ' + p[0]; }

/* pages = [ [pdf operators...], ... ]; imgs = [{name, bytes, info}] shared by all pages */
function pdfDocument(pages, imgs, W, H) {
  const parts = [], offsets = [];
  let len = 0;
  const enc = str => { const a = new Array(str.length); for (let i = 0; i < str.length; i++) a[i] = str.charCodeAt(i) & 255; return a; };
  const push = a => { parts.push(a); len += a.length; };
  const n = pages.length, firstPage = 5, firstContent = firstPage + n, firstImg = firstContent + n;
  const xo = '/XObject << ' + imgs.map((im, i) => '/' + im.name + ' ' + (firstImg + i) + ' 0 R').join(' ') + ' >>';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [' + pages.map((p, i) => (firstPage + i) + ' 0 R').join(' ') + '] /Count ' + n + ' >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'
  ];
  pages.forEach((p, i) => objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + W + ' ' + H + '] /Contents ' + (firstContent + i) + ' 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> ' + xo + ' >> >>'));
  pages.forEach(p => { const c = p.join('\n'); objs.push({ dict: '<< /Length ' + c.length + ' >>', data: enc(c) }); });
  imgs.forEach(im => objs.push({ dict: '<< /Type /XObject /Subtype /Image /Width ' + im.info.w + ' /Height ' + im.info.h + ' /ColorSpace /' +
    (im.info.comps === 1 ? 'DeviceGray' : im.info.comps === 4 ? 'DeviceCMYK' : 'DeviceRGB') + ' /BitsPerComponent 8 /Filter /DCTDecode /Length ' + im.bytes.length + ' >>', data: im.bytes }));
  push(enc('%PDF-1.4\n%âãÏÓ\n'));
  objs.forEach((ob, i) => {
    offsets.push(len);
    if (typeof ob === 'string') push(enc((i + 1) + ' 0 obj\n' + ob + '\nendobj\n'));
    else { push(enc((i + 1) + ' 0 obj\n' + ob.dict + '\nstream\n')); push(ob.data); push(enc('\nendstream\nendobj\n')); }
  });
  const xref = len;
  let x = 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
  offsets.forEach(off => { x += ('0000000000' + off).slice(-10) + ' 00000 n \n'; });
  x += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  push(enc(x));
  const out = new Array(len);
  let k = 0;
  parts.forEach(a => { for (let i = 0; i < a.length; i++) out[k++] = a[i] > 127 ? a[i] - 256 : a[i]; });
  return out;
}

/* o = {number, date, due, month, customer, company, address, email, lines: [{date, ref, route, price}], total, bank} */
function buildInvoicePdf(o) {
  const W = 595, H = 842, M = 40;
  const INK = '0.055 0.090 0.149', GREY = '0.40 0.45 0.52', WHITE = '1 1 1', GREEN = '0.467 0.718 0.169', NAVY = '0.016 0.047 0.094';
  const imgs = [], b = pdfBytesOf(Utilities.base64Decode(POD_LOGO_JPG)), li = jpegInfo(b);
  if (li && !o.noLogo) imgs.push({ name: 'Im1', bytes: b, info: li });
  const pages = [];
  let ops = null, y = 0;
  const T = (x, yy, size, bold, color, str) => ops.push('BT /' + (bold ? 'F2' : 'F1') + ' ' + size + ' Tf ' + color + ' rg ' + x.toFixed(1) + ' ' + (H - yy).toFixed(1) + ' Td (' + pdfStr(str) + ') Tj ET');
  const TR = (xr, yy, size, bold, color, str) => T(xr - pdfAscii(str).length * size * (bold ? 0.56 : 0.5), yy, size, bold, color, str);
  const R = (x, yy, w, h, color) => ops.push(color + ' rg ' + x.toFixed(1) + ' ' + (H - yy - h).toFixed(1) + ' ' + w.toFixed(1) + ' ' + h.toFixed(1) + ' re f');
  const footer = () => {
    R(0, H - 44, W, 44, '0.96 0.97 0.95');
    const fl = o.footer || [COMPANY_LEGAL, OWNER_EMAIL + ' - ' + PHONE + ' - prjlogistics.co.uk'];
    T(M, H - 26, 7.5, false, GREY, fl[0] || ''); T(M, H - 14, 7.5, false, GREY, fl[1] || '');
  };
  const newPage = first => {
    ops = []; pages.push(ops);
    const HB = first ? (o.tight ? 64 : 92) : 50;
    R(0, 0, W, HB, NAVY); R(0, HB, W, 4, GREEN);
    if (imgs.length) { const hh = first ? 68 : 34; ops.push('q ' + (hh * li.w / li.h).toFixed(1) + ' 0 0 ' + hh + ' 26 ' + (H - (first ? 12 : 8) - hh).toFixed(1) + ' cm /Im1 Do Q'); }
    else if (o.headName) { T(M, first ? (o.tight ? 38 : 52) : 32, first ? (o.tight ? 17 : 20) : 13, true, WHITE, o.headName); if (first && o.headSub) T(M, o.tight ? 53 : 70, 10, false, '0.79 0.83 0.88', o.headSub); }
    T(W - M - 150, first ? (o.tight ? 34 : 44) : 30, first ? (o.tight ? 19 : 22) : 14, true, WHITE, 'INVOICE');
    if (first) T(W - M - 150, o.tight ? 52 : 66, 11, false, '0.79 0.83 0.88', o.number);
    footer();
    y = first ? (o.tight ? 92 : 126) : 82;
  };
  newPage(true);
  // who and when
  let ty = y;
  if (o.from && o.from.length) {   // invoices from the Diary: the driver's own details
    T(M, ty, 8, true, GREY, 'FROM'); ty += o.tight ? 13 : 16;
    if (o.tight) {   // name, then the address on one line, then contact details on one line
      const fa = o.from.slice(1);
      [[o.from[0], 10.5, true]].concat(pdfWrap(fa.join(', '), 270, 9, false).slice(0, 4).map(l => [l, 9, false])).forEach(v => { T(M, ty, v[1], v[2], INK, v[0]); ty += 11.5; });
      ty += 8;
    } else {
    o.from.forEach((v, k) => pdfWrap(v, 250, k ? 10 : 11, !k).forEach(l => { T(M, ty, k ? 10 : 11, !k, INK, l); ty += 13; }));
    ty += 12;
    }
  }
  T(M, ty, 8, true, GREY, 'BILL TO');
  const to = [o.company, o.customer, o.address, o.email].filter(v => String(v || '').trim());
  ty += o.tight ? 13 : 16;
  if (o.tight) to.forEach((v, k) => pdfWrap(v, 270, k ? 9 : 10.5, !k).forEach(l => { T(M, ty, k ? 9 : 10.5, !k, INK, l); ty += 11.5; }));
  else to.forEach(v => pdfWrap(v, 250, 11, false).forEach(l => { T(M, ty, 11, false, INK, l); ty += 14; }));
  const meta = [['Invoice number', o.number], ['Invoice date', o.date], ['Payment due', o.due], o.single ? ['Delivery date', o.lines[0].date || '-'] : ['Period', o.period || monthLabel(o.month)]];
  if (o.weekEnding) meta.splice(1, 0, ['Week ending', o.weekEnding]);
  if (o.terms) meta.splice(meta.length - 1, 0, ['Payment terms', o.terms]);
  const MS = o.tight ? 15 : 18;
  meta.forEach((m, i) => { T(330, y + i * MS, 8, true, GREY, m[0].toUpperCase()); TR(W - M, y + i * MS, 10, false, INK, m[1]); });
  y = Math.max(ty, y + meta.length * MS) + (o.tight ? 12 : 18);
  // table
  const head = () => { R(M, y - 12, W - 2 * M, 20, NAVY); T(M + 8, y + 2, 9, true, WHITE, 'Date'); if (o.noRef) T(M + 90, y + 2, 9, true, WHITE, 'Job / route'); else { T(M + 78, y + 2, 9, true, WHITE, 'Reference'); T(M + 190, y + 2, 9, true, WHITE, 'Route'); } TR(W - M - 8, y + 2, 9, true, WHITE, 'Amount'); y += 24; };
  head();
  o.lines.forEach((ln, i) => {
    const FS = o.compact ? 8 : 9, LH = o.compact ? 9.4 : 12, PAD = o.compact ? 4 : 8;
    const route = o.noRef ? [].concat(...String(ln.route).split('\n').map((x, j) => pdfWrap(x, o.compact ? 345 : 330, j ? FS - (o.compact ? 0.5 : 0) : FS, false))).slice(0, 14) : pdfWrap(ln.route, 230, 9, false).slice(0, 3);
    const h = Math.max(1, route.length) * LH + PAD;
    if (y + h > H - (o.compact ? (i === o.lines.length - 1 ? 175 : 70) : 150)) { newPage(false); head(); }
    if (i % 2) R(M, y - LH + 1, W - 2 * M, h, '0.96 0.97 0.95');
    T(M + 8, y, FS, false, INK, ln.date); if (!o.noRef) T(M + 78, y, 9, false, INK, ln.ref);
    route.forEach((l, j) => T(M + (o.noRef ? 90 : 190), y + j * LH, j && o.noRef ? FS - (o.compact ? 0.5 : 0) : FS, false, j && o.noRef ? GREY : INK, l));
    TR(W - M - 8, y, 9, false, INK, ln.price);
    y += h;
  });
  if (y > H - (o.compact ? 175 : 190)) newPage(false);
  y += o.tight ? 2 : 6; R(M, y - 8, W - 2 * M, 0.8, '0.86 0.89 0.84'); y += 14;
  if (o.vat) { T(330, y, 10, false, INK, 'Subtotal (net)'); TR(W - M - 8, y, 10, false, INK, o.vat.net); y += 16;
    T(330, y, 10, false, INK, 'VAT @ ' + o.vat.rate + '%'); TR(W - M - 8, y, 10, false, INK, o.vat.vat); y += 18; }
  T(330, y, 11, true, INK, o.vat ? 'Total due (incl. VAT)' : 'Total due'); TR(W - M - 8, y, 13, true, INK, o.total); y += 18;
  const vn = o.vat ? (o.vat.no ? 'VAT registration number: ' + o.vat.no : '') : (o.vatNote != null ? o.vatNote : 'Not VAT registered - no VAT charged.');
  if (vn) T(330, y, 8.5, false, GREY, vn); y += o.tight ? 22 : 28;
  // payment box: bank details printed clearly, with the invoice number as the reference
  const bd = o.bankDetails || {}, rowsB = bd.name ? [['Account name', bd.name], ['Sort code', bd.sort], ['Account number', bd.acc], ['Payment reference', o.number]] : (o.bank ? [['Bank transfer', o.bank], ['Payment reference', o.number]] : []);
  const boxH0 = (o.tight || o.compact) && rowsB.length === 4 ? 74 : 30 + Math.max(1, rowsB.length) * 16 + 18;
  if (y + boxH0 + 10 > H - 48) newPage(false);
  const boxH = (o.tight || o.compact) && rowsB.length === 4 ? 30 + 30 + 14 : 30 + Math.max(1, rowsB.length) * 16 + 18;
  R(M, y - 12, W - 2 * M, boxH, '0.95 0.97 0.92'); R(M, y - 12, 4, boxH, GREEN);
  T(M + 14, y + 2, 9, true, INK, 'PAY BY BANK TRANSFER');
  let by = y + 20;
  if (rowsB.length && (o.tight || o.compact)) {   // two columns: name and reference on the left, sort code and account number on the right
    [[rowsB[0], rowsB[3]], [rowsB[1], rowsB[2]]].forEach((col, c) => col.forEach((rw, i) => { if (!rw) return; T(M + 14 + c * 250, by + i * 15, 8.5, false, GREY, rw[0]); T(M + 14 + c * 250 + 92, by + i * 15, 10, true, INK, pdfWrap(rw[1], 150, 10, true)[0] || ''); }));
    by += 30;
  } else if (rowsB.length) rowsB.forEach(rw => { T(M + 14, by, 9, false, GREY, rw[0]); pdfWrap(rw[1], 330, 10.5, true).slice(0, 2).forEach((l, i) => T(M + 150, by + i * 13, 10.5, true, INK, l)); by += 16; });
  else { T(M + 14, by, 10, false, INK, 'Please contact us for payment details: ' + (o.contact || OWNER_EMAIL)); by += 16; }
  T(M + 14, by + 2, 9, false, GREY, 'Please pay by ' + o.due + (bd.note ? ' - ' + bd.note : '') + '. Questions: ' + (o.contact || OWNER_EMAIL + ' or ' + PHONE) + '.');
  y += boxH + 6;
  pdfWrap(o.thanks || 'Thank you for your business.' + (o.single ? '' : ' ' + o.lines.length + ' delivery job' + (o.lines.length === 1 ? '' : 's') + (o.period ? ', ' + o.period : ' in ' + monthLabel(o.month)) + '.'), W - 2 * M, 9, false).forEach(l => { T(M, y, 9, false, GREY, l); y += 12; });
  return pdfDocument(pages, imgs, W, H);
}

/* ---------- monthly goal (admin panel corner): what we earned and booked this month ----------
   Earned = delivered jobs with a collection date in the month. Booked = confirmed jobs of the month not delivered yet. */
function goalStats(rows, month) {
  const o = { month: month, earned: 0, delivered: 0, booked: 0, bookedJobs: 0, workDaysLeft: 0 };
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i], st = String(r[1]).trim();
    if (['Delivered', 'Booked', 'Collected'].indexOf(st) < 0) continue;
    if (String(jobDay(r[13], r[2]) || '').slice(0, 7) !== month) continue;
    const v = priceNum(r[18] || r[21]);
    if (st === 'Delivered') { o.earned += v; o.delivered++; } else { o.booked += v; o.bookedJobs++; }
  }
  const today = Utilities.formatDate(new Date(), 'Europe/London', 'yyyy-MM-dd');
  o.diaryMoney = 0; o.diaryRuns = 0;
  try {   // runs from the Diary (Tradeteam etc.) count too: done when the day has come, booked when it is still ahead
    diaryList(month).forEach(x => { const v = Number(x.amount) || 0;
      if (x.date <= today) { o.earned += v; o.delivered++; o.diaryMoney += v; o.diaryRuns++; } else { o.booked += v; o.bookedJobs++; } });
  } catch (e) {}
  o.earned = Math.round(o.earned * 100) / 100; o.booked = Math.round(o.booked * 100) / 100; o.diaryMoney = Math.round(o.diaryMoney * 100) / 100;
  if (today.slice(0, 7) === month) {   // Monday-Friday left in the month, today included
    const y = +month.slice(0, 4), m = +month.slice(5, 7), last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    for (let dd = +today.slice(8, 10); dd <= last; dd++) { const w = new Date(Date.UTC(y, m - 1, dd)).getUTCDay(); if (w && w < 6) o.workDaysLeft++; }
  }
  return o;
}

/* ---------- invoices: every job is on at most one live invoice ----------
   Sheet "Invoices": Number | Created | Month | Customer key | Email | References | Total | Sent to | Status ('' = open, 'Paid', 'Void') | Status changed
   A void invoice frees its jobs, so they can go on a new invoice. Its number is never used again. */
function invoiceRows() {
  return invoicesSheet().getDataRange().getValues().slice(1).filter(x => String(x[0] || '').trim()).map((x, i) => ({
    row: i + 2, number: String(x[0]).trim(), created: isoOf(x[1]), month: String(x[2] || ''), key: String(x[3] || ''), email: String(x[4] || ''),
    refs: String(x[5] || '').split(/,\s*/).map(v => v.trim()).filter(Boolean), total: String(x[6] || ''), sentTo: String(x[7] || ''),
    status: String(x[8] || '').trim(), changed: isoOf(x[9])
  }));
}
/* ref -> the live (not void) invoice it is on */
function invoiceMap() {
  const m = {};
  invoiceRows().forEach(v => { if (v.status === 'Void') return; v.refs.forEach(rf => { m[rf] = { number: v.number, sentTo: v.sentTo, at: v.created, jobs: v.refs.length, total: v.total, status: v.status }; }); });
  return m;
}
function invoiceBusiness(r) { return String(r[27]).trim() === 'Business' || !!String(r[28] || '').trim() || /^Invoice/.test(String(r[26])); }
function shortRoute(r) { return (areaOf(r[8]) || cleanText(r[8], 60)) + ' -> ' + (areaOf(r[9]) || cleanText(r[9], 60)); }

/* Invoices tab: business customers with their delivered jobs not on an invoice yet, plus their invoices */
function invoiceCandidates() {
  const rows = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME).getDataRange().getValues(), by = {};
  const map = invoiceMap(), invs = invoiceRows(), everInvoiced = {};
  invs.forEach(v => v.refs.forEach(rf => { everInvoiced[rf] = 1; }));
  const cust = (k, r) => by[k] = by[k] || { key: k, company: cleanText(r[28], 100), name: cleanText(r[11], 100), email: cleanText(r[29], 120) || cleanText(r[4], 120), jobs: [], invoices: [] };
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const ref = String(r[0]).trim(), st = String(r[1]).trim();
    if (!invoiceBusiness(r) && !everInvoiced[ref]) continue;
    const k = invoiceKey(r);
    if (!k) continue;
    if (st !== 'Delivered' || map[ref]) continue;
    const day = jobDay(r[13], r[2]) || '';
    cust(k, r).jobs.push({ ref: ref, day: day, route: shortRoute(r), price: priceNum(r[18] || r[21]), paid: String(r[26]).trim() === 'Paid' });
  }
  invs.forEach(v => {
    if (!v.key) return;
    if (!by[v.key]) {
      if (v.status) return;   // paid or void, and nothing new to invoice: no card needed
      const r = rows.find((x, i) => i > 0 && v.refs.indexOf(String(x[0]).trim()) >= 0);
      if (!r) return;
      cust(v.key, r);
    }
    by[v.key].invoices.push({ number: v.number, created: v.created, total: v.total, sentTo: v.sentTo, jobs: v.refs.length, refs: v.refs, status: v.status, changed: v.changed });
  });
  return Object.keys(by).map(k => {
    const c = by[k];
    c.jobs.sort((a, b) => String(a.day).localeCompare(String(b.day)));
    c.invoices.sort((a, b) => String(b.created).localeCompare(String(a.created)));
    c.invoices = c.invoices.slice(0, 8);
    c.total = Math.round(c.jobs.reduce((t, j) => t + j.price, 0) * 100) / 100;
    c.open = c.invoices.filter(v => !v.status).length;
    return c;
  }).sort((a, b) => (b.jobs.length - a.jobs.length) || (b.open - a.open) || String(a.company || a.name).localeCompare(String(b.company || b.name)));
}

/* "28 Oct - 3 Nov 2026", "28 Oct 2026", "28 Dec 2025 - 3 Jan 2026" */
function periodLabel(days) {
  const ds = days.filter(Boolean).sort();
  if (!ds.length) return '';
  const f = (x, y) => Utilities.formatDate(new Date(x + 'T12:00:00Z'), 'Europe/London', y ? 'd MMM yyyy' : 'd MMM');
  const a = ds[0], b = ds[ds.length - 1];
  if (a === b) return f(a, true);
  return f(a, a.slice(0, 4) !== b.slice(0, 4)) + ' - ' + f(b, true);
}

/* d.refs: jobs to put on a new invoice | d.ref: one job (job card) | d.number: an invoice already made (preview or send it again)
   | d.month + d.ikey: every delivered job of the month not on an invoice yet (old monthly button) */
function makeInvoice(d, by) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME), rows = sh.getDataRange().getValues();
  const p = props(), map = invoiceMap(), invs = invoiceRows();
  let number = String(d.number || '').trim(), refs = [], single = false;
  let existing = number ? (invs.filter(v => v.number === number && v.status !== 'Void')[0] || invs.find(v => v.number === number)) : null;
  if (existing && existing.status === 'Void') return { ok: false, message: 'Invoice ' + number + ' was cancelled (void).' };
  if (existing) {
    refs = existing.refs.slice();   // the same invoice again: always the same jobs
  } else {
    number = '';
    if (Array.isArray(d.refs)) refs = d.refs.map(v => String(v || '').trim().toUpperCase()).filter(Boolean).slice(0, 200);
    else if (d.ref) {
      const rf = String(d.ref).trim().toUpperCase();
      if (map[rf]) { number = map[rf].number; existing = invs.find(v => v.number === number && v.status !== 'Void'); refs = existing.refs.slice(); }   // already on an invoice: open that one
      else refs = [rf];
    } else {
      const month = String(d.month || ''), key = cleanText(d.ikey, 140);
      if (!/^\d{4}-\d{2}$/.test(month)) return { ok: false, message: 'Choose the jobs to invoice.' };
      refs = invoiceJobs(rows, month, key).map(r => String(r[0]).trim()).filter(rf => !map[rf]);
      if (!refs.length) return { ok: false, message: 'No delivered jobs left to invoice for this customer in ' + monthLabel(month) + '.' };
    }
  }
  refs = refs.filter((v, i) => refs.indexOf(v) === i);
  if (!refs.length) return { ok: false, message: 'Choose at least one job.' };
  const isNew = !number;
  const jobs = [];
  for (let k = 0; k < refs.length; k++) {
    const r = rows.find((x, i) => i > 0 && String(x[0]).trim().toUpperCase() === refs[k]);
    if (!r) return { ok: false, message: 'Job ' + refs[k] + ' not found.' };
    if (isNew) {
      if (map[refs[k]]) return { ok: false, message: refs[k] + ' is already on invoice ' + map[refs[k]].number + '. Void that invoice first if it was wrong.' };
      const st = String(r[1]).trim();
      if (refs.length > 1 ? st !== 'Delivered' : ['Booked', 'Collected', 'Delivered'].indexOf(st) < 0) return { ok: false, message: refs.length > 1 ? refs[k] + ' is not delivered yet.' : 'Confirm the booking first.' };
      if (!priceNum(r[18] || r[21])) return { ok: false, message: refs.length > 1 ? 'Add the price to ' + refs[k] + ' first.' : 'Add the price first.' };
    }
    jobs.push(r);
  }
  const key = invoiceKey(jobs[0]);
  if (isNew && jobs.some(r => invoiceKey(r) !== key)) return { ok: false, message: 'One invoice can only have jobs of one customer.' };
  jobs.sort((a, b) => String(jobDay(a[13], a[2])).localeCompare(String(jobDay(b[13], b[2]))));
  single = jobs.length === 1;
  const days = jobs.map(r => jobDay(r[13], r[2]));
  const month = String(days.filter(Boolean)[0] || Utilities.formatDate(new Date(), 'Europe/London', 'yyyy-MM-dd')).slice(0, 7);
  const f = jobs[0];
  if (!bankDetails().name && !p.getProperty('invoice_bank') && !d.noBank) return { ok: false, needsBank: true, message: 'Add your bank details first, so the customer knows where to pay.' };
  if (isNew) { const nx = Number(p.getProperty('inv_next') || '1'); number = 'PRJ-INV-' + new Date().getFullYear() + '-' + ('000' + nx).slice(-4); if (d.send || d.save) p.setProperty('inv_next', String(nx + 1)); }
  const now = new Date(), due = new Date(now.getTime() + 7 * 86400000);
  const total = jobs.reduce((t, r) => t + priceNum(r[18] || r[21]), 0);
  const fmtD = x => Utilities.formatDate(x, 'Europe/London', 'd MMM yyyy');
  const period = periodLabel(days);
  const o = {
    number: number, date: fmtD(now), due: fmtD(due), month: month, period: period,
    customer: cleanText(f[11], 100), company: cleanText(f[28], 100), address: cleanText(f[30], 300),
    email: cleanText(f[29], 120) || cleanText(f[4], 120),
    lines: jobs.map(r => { const dy = jobDay(r[13], r[2]); return { date: dy ? fmtD(new Date(dy + 'T12:00:00')) : '', ref: String(r[0]).trim(), route: cleanText(r[8], 200) + ' -> ' + cleanText(r[9], 200), price: priceText(priceNum(r[18] || r[21])) }; }),
    total: priceText(Math.round(total * 100) / 100), bank: p.getProperty('invoice_bank') || '', bankDetails: bankDetails(), single: single
  };
  const bytes = buildInvoicePdf(o);
  const name = number + '.pdf';
  let sentTo = '';
  if (d.send) {
    const to = cleanText(d.to, 120) || o.email;
    if (!validEmail(to)) return { ok: false, message: 'This customer has no invoice email. Type the address to send it to.' };
    const first = String(o.customer || '').trim().split(/\s+/)[0] || 'there';
    const dueDay = Utilities.formatDate(due, 'Europe/London', 'EEEE d MMMM');
    const td = 'padding:5px 14px 5px 0;color:#5E6B7C;vertical-align:top;white-space:nowrap', tv = 'padding:5px 0;vertical-align:top';
    const jobLine = r => { const dy = jobDay(r[13], r[2]); return (dy ? Utilities.formatDate(new Date(dy + 'T12:00:00Z'), 'Europe/London', 'd MMM') + ' · ' : '') + shortRoute(r).replace(' -> ', ' → '); };
    const jobsHtml = single
      ? '<tr><td style="' + td + '">Delivery</td><td style="' + tv + '">' + esc(jobLine(jobs[0])) + '<br><span style="font-size:12px;color:#8A94A3">' + esc(o.lines[0].ref) + '</span></td></tr>'
      : '<tr><td style="' + td + '">Deliveries</td><td style="' + tv + '">' + jobs.map((r, k) => esc(jobLine(r)) + ' &nbsp;<b>' + esc(o.lines[k].price) + '</b><br><span style="font-size:12px;color:#8A94A3">' + esc(o.lines[k].ref) + '</span>').join('<div style="height:6px"></div>') + '</td></tr>';
    const html = '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#0E1726;max-width:560px">' +
      '<p style="margin:0 0 12px">Hi ' + esc(first) + ',</p>' +
      '<p style="margin:0 0 12px">Thank you for choosing PRJ Logistics' + (single ? ' - it was a pleasure to deliver for you.' : ' again - here is one invoice for your recent deliveries.') + ' Your invoice is attached as a PDF.</p>' +
      '<div style="background:#F4F8EE;border-left:4px solid #77B72B;border-radius:10px;padding:12px 16px;margin:16px 0">' +
      '<table style="border-collapse:collapse;font-size:15px;width:100%">' +
      '<tr><td style="' + td + '">Invoice</td><td style="' + tv + '">' + esc(number) + '</td></tr>' + jobsHtml +
      '<tr><td style="' + td + ';padding-top:10px">Amount due</td><td style="' + tv + ';padding-top:8px;font-size:22px;font-weight:bold">' + esc(o.total) + '</td></tr>' +
      '<tr><td style="' + td + '">Due by</td><td style="' + tv + '">' + esc(dueDay) + '</td></tr>' +
      '</table></div>' +
      '<p style="margin:0 0 12px">Our bank details are on the invoice. Please use <b>' + esc(number) + '</b> as the payment reference, so we can match your payment.</p>' +
      '<p style="margin:0 0 12px">Any questions, just reply to this email or call us on <a href="tel:' + PHONE.replace(/\s/g, '') + '" style="color:#5C7F1E">' + esc(PHONE) + '</a>. We look forward to helping you again.</p>' +
      '<p style="margin:0">Best wishes,<br>Patryk &amp; Pawel<br>' + esc(COMPANY) + '</p></div>';
    const what = single ? 'your delivery ' + o.lines[0].ref + (o.lines[0].date ? ' on ' + o.lines[0].date : '') : o.lines.length + ' deliveries (' + period + ')';
    sendCustomerMail({ to: to, subject: 'Your invoice ' + number + ' from ' + COMPANY, htmlBody: html,
      body: 'Hi ' + first + ',\n\nThank you for choosing PRJ Logistics. Your invoice ' + number + ' for ' + what + ' is attached.\n\nAmount due: ' + o.total + '\nDue by: ' + dueDay +
        '\n\nOur bank details are on the invoice. Please use ' + number + ' as the payment reference.\n\nAny questions, just reply to this email or call us on ' + PHONE + '.\n\nBest wishes,\nPatryk & Pawel\n' + COMPANY,
      replyTo: OWNER_EMAIL, name: COMPANY, attachments: [Utilities.newBlob(bytes, 'application/pdf', name)] });
    sentTo = to;
  }
  if (d.send || d.save) {
    const sh2 = invoicesSheet();
    const vals = [number, existing ? (dateOf(existing.created) || now) : now, month, key, o.email, o.lines.map(l => l.ref).join(', '), o.total, sentTo || (existing ? existing.sentTo : '')];
    if (existing) sh2.getRange(existing.row, 1, 1, 8).setValues([vals]); else sh2.appendRow(vals.concat(['', '']));
  }
  if (d.link) {   // a web link to the PDF: opens on every phone (a PDF made inside the page does not open in the iPhone app)
    try {
      const f = getPodFolder().createFile(Utilities.newBlob(bytes, 'application/pdf', 'Invoice-' + name));
      try { f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
      return { ok: true, number: number, name: name, url: f.getUrl(), total: o.total, sentTo: sentTo, jobs: o.lines.length, period: period };
    } catch (e) { logError('Invoice PDF link failed: ' + e); }
  }
  return { ok: true, number: number, name: name, pdf: Utilities.base64Encode(bytes), total: o.total, sentTo: sentTo, jobs: o.lines.length, period: period };
}

/* a job marked paid (Unpaid tab, card payment): its invoice becomes Paid when every job on it is paid, and Not paid again if one is not */
function syncInvoicePaid(sh, ref) {
  ref = String(ref || '').trim().toUpperCase();
  const v = invoiceRows().find(x => x.status !== 'Void' && x.refs.indexOf(ref) >= 0);
  if (!v) return;
  const rows = sh.getDataRange().getValues(), pay = {};
  for (let i = 1; i < rows.length; i++) pay[String(rows[i][0]).trim().toUpperCase()] = String(rows[i][26]).trim();
  const allPaid = v.refs.every(rf => pay[rf] === 'Paid');
  const to = allPaid ? 'Paid' : '';
  if (to !== v.status) invoicesSheet().getRange(v.row, 9, 1, 2).setValues([[to, new Date()]]);
}

/* Invoices tab: mark an invoice paid (all its jobs become Paid), void it (its jobs can be invoiced again), or open it again */
function invoiceStatus(sh, d, by) {
  const number = String(d.number || '').trim(), to = String(d.status || '');
  if (['Paid', 'Void', ''].indexOf(to) < 0) return { ok: false, message: 'Unknown status.' };
  const v = invoiceRows().find(x => x.number === number);
  if (!v) return { ok: false, message: 'Invoice not found.' };
  if (v.status === 'Void') return { ok: false, message: 'This invoice is void. Make a new invoice for these jobs instead.' };
  if (to === '' && v.status !== 'Paid') return { ok: true };
  if (to === v.status) return { ok: true };
  if (to === 'Void' && v.status === 'Paid') return { ok: false, message: 'This invoice is marked paid. Undo "paid" first if it really has to be cancelled.' };
  const now = new Date();
  invoicesSheet().getRange(v.row, 9, 1, 2).setValues([[to, now]]);
  if (to === 'Paid' || (to === '' && v.status === 'Paid')) {
    v.refs.forEach(rf => {
      const row = findJobRow(sh, rf);
      if (!row) return;
      sh.getRange(row, 27).setValue(to === 'Paid' ? 'Paid' : 'Invoice (7 days)');
    });
  }
  return { ok: true, number: number, status: to, jobs: v.refs.length };
}

/* ---------- web push to the office phones (works on the Cloudflare server; on Google it does nothing) ---------- */
function pushPublicKey() {
  return '';   // Google Apps Script cannot send web push; the Cloudflare server replaces this function
}
/* "Send a test" from the bell in the admin panel: one notification to every phone that turned them on */
function pushTest(by) {
  return { ok: false, message: 'Phone notifications work only on the new server.' };   // replaced on the Cloudflare server
}
function savePushSub(sub, by) {
  if (!sub || !/^https:\/\/[^\s]{10,800}$/.test(String(sub.endpoint || '')) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return { ok: false, message: 'Notifications are not supported on this browser.' };
  let list = [];
  try { list = JSON.parse(props().getProperty('push_subs') || '[]'); } catch (e) {}
  list = list.filter(s => s.endpoint !== sub.endpoint);
  list.push({ endpoint: String(sub.endpoint), keys: { p256dh: String(sub.keys.p256dh).slice(0, 200), auth: String(sub.keys.auth).slice(0, 60) }, by: by, at: new Date().toISOString() });
  props().setProperty('push_subs', JSON.stringify(list.slice(-10)));
  return { ok: true, devices: Math.min(list.length, 10) };
}



/* ===================== diary: day-by-day work log for each driver (e.g. Tradeteam runs) =====================
   Sheet "Diary": ID | Date (yyyy-MM-dd) | Driver | Client | Job | Amount | Notes | Added | Updated | By */
function diarySheet() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName('Diary');
  if (!sh) { sh = ss.insertSheet('Diary'); sh.appendRow(['ID', 'Date', 'Driver', 'Client', 'Job', 'Amount', 'Notes', 'Added', 'Updated', 'By', 'Stops', 'Weights kg', 'Miles', 'Order']); }
  if (!sh.getRange(1, 11).getValue()) sh.getRange(1, 11).setValue('Stops');
  if (!sh.getRange(1, 12).getValue()) sh.getRange(1, 12).setValue('Weights kg');
  if (!sh.getRange(1, 13).getValue()) sh.getRange(1, 13).setValue('Miles');
  if (!sh.getRange(1, 14).getValue()) sh.getRange(1, 14).setValue('Order');
  return sh;
}
function diaryRow(r) {
  const d = r[1] instanceof Date ? Utilities.formatDate(r[1], 'Europe/London', 'yyyy-MM-dd') : String(r[1] || '');
  const o = { id: String(r[0]), date: d, driver: String(r[2] || ''), client: String(r[3] || ''), job: String(r[4] || ''), amount: priceNum(r[5]), notes: String(r[6] || ''), addedAt: isoOf(r[7]), updatedAt: isoOf(r[8]), by: String(r[9] || ''),
    stops: (function () { try { const l = JSON.parse(String(r[10] || '[]')); return Array.isArray(l) ? l.map(String) : []; } catch (e) { return []; } })(),
    weights: (function () { try { const l = JSON.parse(String(r[11] || '[]')); return Array.isArray(l) ? l.map(x => Number(x) || 0) : []; } catch (e) { return []; } })() };
  o.kg = Math.round(o.weights.reduce((t, x) => t + x, 0) * 10) / 10;
  o.order = Number(r[13]) || 0;
  o.miles = (function () { try { const m = JSON.parse(String(r[12] || 'null')); return m && typeof m === 'object' ? m : null; } catch (e) { return null; } })();
  return o;
}
function diaryList(month) {
  const m = /^\d{4}-\d{2}$/.test(String(month || '')) ? String(month) : '';
  return diarySheet().getDataRange().getValues().slice(1).filter(r => r[0]).map(diaryRow)
    .filter(x => !m || x.date.slice(0, 7) === m)
    .sort(diaryOrder);
}
/* runs of a day: in the order they were dragged to, otherwise by driver and when they were added */
function diaryOrder(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const oa = a.order || 9999, ob = b.order || 9999;
  if (oa !== ob) return oa - ob;
  return (a.driver + a.addedAt).localeCompare(b.driver + b.addedAt);
}
/* drag and drop in the Diary: the runs of one day in their new order; a run dropped on another day moves to that day */
function diaryReorder(d) {
  const date = String(d.date || ''), ids = (Array.isArray(d.ids) ? d.ids : []).map(String).slice(0, 60);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !ids.length) return { ok: false, message: 'Nothing to move.' };
  const sh = diarySheet(), rows = sh.getDataRange().getValues(), map = dinvMap();
  const at = {}; for (let i = 1; i < rows.length; i++) at[String(rows[i][0])] = i;
  for (const id of ids) {
    const i = at[id]; if (i == null) return { ok: false, message: 'A run was deleted. Refresh the Diary.' };
    const was = rows[i][1] instanceof Date ? Utilities.formatDate(rows[i][1], 'Europe/London', 'yyyy-MM-dd') : String(rows[i][1]).slice(0, 10);
    if (was !== date && map[id]) return { ok: false, message: 'This run is on invoice ' + map[id] + ', so it cannot move to another day. Correct the invoice first.' };
  }
  ids.forEach((id, k) => { const i = at[id];
    const was = rows[i][1] instanceof Date ? Utilities.formatDate(rows[i][1], 'Europe/London', 'yyyy-MM-dd') : String(rows[i][1]).slice(0, 10);
    if (was !== date) sh.getRange(i + 1, 2).setValue(date);
    sh.getRange(i + 1, 14).setValue(k + 1); });
  return { ok: true, items: ids.map(id => diaryRow(sh.getRange(at[id] + 1, 1, 1, 14).getValues()[0])) };
}
function diarySave(d, by) {
  const it = d.item || {};
  const date = String(it.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, message: 'Choose the date.' };
  const drivers = Object.keys(USERS).map(u => String(USERS[u].name));
  const driver = cleanText(it.driver, 40);
  if (drivers.indexOf(driver) < 0) return { ok: false, message: 'Choose the driver.' };
  const rawStops = (Array.isArray(it.stops) ? it.stops : []).map(x => cleanText(x, 200)), rawW = Array.isArray(it.weights) ? it.weights : [];
  const keep = rawStops.map((x, k) => k).filter(k => rawStops[k]).slice(0, 30);
  const stops = keep.map(k => rawStops[k]);
  const job = cleanText(it.job, 300) || stops.join(' → ').slice(0, 300);
  const kg = x => { const n = Math.round(parseFloat(String(x == null ? '' : x).replace(/[^\d.]/g, '')) * 10) / 10; return n > 0 && n < 100000 ? n : 0; };
  const wIn = rawW.map(kg);
  const weights = stops.length ? keep.map(k => wIn[k] || 0) : (wIn.some(Boolean) ? [wIn.reduce((t, x) => t + x, 0)] : []);
  if (!job) return { ok: false, message: 'Write the job or add a stop, e.g. Dominos Stamford Hill N16.' };
  const amount = String(it.amount == null ? '' : it.amount).trim() === '' ? '' : priceNum(it.amount);
  const vals = [safeCell(date), safeCell(driver), safeCell(cleanText(it.client, 80)), safeCell(job), amount, safeCell(cleanText(it.notes, 400))];
  const sh = diarySheet(), rows = sh.getDataRange().getValues(), now = new Date();
  const places = diaryPlaces(stops, job);
  if (it.id) {
    for (let i = 1; i < rows.length; i++) if (String(rows[i][0]) === String(it.id)) {
      let miles = String(rows[i][12] || '');
      try { const old = JSON.parse(miles || 'null'); if (!old || old.total == null || JSON.stringify(old.places || []) !== JSON.stringify(places)) miles = ''; } catch (e) { miles = ''; }
      if (!miles) miles = diaryMilesFor(places);
      const r = [rows[i][0]].concat(vals, [rows[i][7] || now, now, by, JSON.stringify(stops), weights.some(Boolean) ? JSON.stringify(weights) : '', miles]);
      sh.getRange(i + 1, 1, 1, 13).setValues([r]);
      return { ok: true, item: diaryRow(r) };
    }
    return { ok: false, message: 'Not found. Refresh the list.' };
  }
  const r = [Utilities.getUuid().replace(/-/g, '').slice(0, 10)].concat(vals, [now, now, by, JSON.stringify(stops), weights.some(Boolean) ? JSON.stringify(weights) : '', diaryMilesFor(places)]);
  sh.appendRow(r);
  return { ok: true, item: diaryRow(r) };
}
/* ---------- miles of a Diary run: from the Tradeteam depot through every stop in order, and back ----------
   Multi User Tradeteam C/o, Gillette Way, Reading RG2 0BS. A run with several drops (e.g. a shared first drop and
   then a second one) is counted from the depot through all its postcodes. */
const DIARY_DEPOT = { name: 'Tradeteam, Gillette Way, Reading RG2 0BS', postcode: 'RG2 0BS', p: [51.4283, -0.9628] };
function diaryPlaces(stops, job) {
  /* no stops: the job counts as a place only if it has a postcode (a training day or day rate has no miles) */
  const l = stops.length ? stops : (job && /\b[A-Z]{1,2}\d{1,2}[A-Z]?\b/i.test(job) ? [job] : []);
  return l.map(x => String(x).trim()).filter(Boolean).slice(0, 30);
}
function fullPostcode(t) { const m = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i.exec(String(t || '')); return m ? (m[1] + ' ' + m[2]).toUpperCase() : ''; }
function diaryMilesFor(places) {
  if (!places.length) return '';
  let depot = DIARY_DEPOT.p;
  const pr = props(); let cached = null; try { cached = JSON.parse(pr.getProperty('depot_ll') || 'null'); } catch (e) {}
  if (cached && cached.length === 2) depot = cached;
  else { try { const g = geocodeUK(DIARY_DEPOT.postcode); if (g && g.p) { depot = g.p; pr.setProperty('depot_ll', JSON.stringify(g.p)); } } catch (e) {} }
  const pts = [], approx = [];
  for (let k = 0; k < places.length; k++) {
    let g = null; try { g = geocodeUK(places[k]); } catch (e) {}
    if (!g || !g.p) return JSON.stringify({ places: places, missing: k + 1 });
    if (!fullPostcode(places[k])) approx.push(k + 1);
    pts.push(g.p);
  }
  const legs = []; let est = false, prev = depot;
  for (let k = 0; k < pts.length; k++) {
    const m = osrmRoute(prev, pts[k]) || { miles: milesBetween(prev, pts[k]) * 1.25, exact: false };
    if (!m.exact) est = true; legs.push(Math.round(m.miles * 10) / 10); prev = pts[k];
  }
  const b = osrmRoute(prev, depot) || { miles: milesBetween(prev, depot) * 1.25, exact: false };
  if (!b.exact) est = true;
  const out = Math.round(legs.reduce((t, x) => t + x, 0) * 10) / 10, back = Math.round(b.miles * 10) / 10;
  return JSON.stringify({ places: places, legs: legs, out: out, back: back, total: Math.round((out + back) * 10) / 10, approx: approx, est: est });
}
/* works out miles for runs saved before miles existed (or whose postcode was not found), a few at a time */
function diaryFillMiles(ids) {
  const sh = diarySheet(), rows = sh.getDataRange().getValues(), want = (Array.isArray(ids) ? ids : []).map(String);
  let done = 0; const items = [];
  for (let i = 1; i < rows.length && done < 4; i++) {   // a few per request: each run needs several map lookups
    if (want.length && want.indexOf(String(rows[i][0])) < 0) continue;
    const force = want.length > 0;
    let cur = null; try { cur = JSON.parse(String(rows[i][12] || 'null')); } catch (e) {}
    if (cur && cur.total != null && !force) continue;
    let stops = []; try { stops = JSON.parse(String(rows[i][10] || '[]')) || []; } catch (e) {}
    const places = diaryPlaces(stops, String(rows[i][4] || ''));
    if (!places.length) continue;
    const m = diaryMilesFor(places);
    sh.getRange(i + 1, 13).setValue(m); rows[i][12] = m; done++; items.push(diaryRow(rows[i]));
  }
  return { ok: true, done: done, items: items };
}
function diaryDelete(id) {
  const onInv = dinvMap()[String(id)];
  if (onInv) return { ok: false, message: 'This run is on invoice ' + onInv + '. Void that invoice first.' };
  const sh = diarySheet(), rows = sh.getDataRange().getValues();
  for (let i = rows.length - 1; i >= 1; i--) if (String(rows[i][0]) === String(id)) { sh.deleteRow(i + 1); return { ok: true }; }
  return { ok: false, message: 'Not found.' };
}

/* ===================== invoices from the Diary: each driver invoices the client for his own runs =====================
   Each person keeps his own invoice details (name, address, bank, numbering) in the settings key "issuer_<Name>".
   Clients' billing details are remembered in "diary_clients". Invoices are kept in the sheet "DiaryInvoices":
   Number | Created | Driver | Client | Period | Entry IDs | Total | Status ('' / Paid / Void) | Status changed | Due */
function issuerOf(name) {
  let o = {}; try { o = JSON.parse(props().getProperty('issuer_' + name) || '{}') || {}; } catch (e) {}
  const full = (typeof FULL_NAMES !== 'undefined' && FULL_NAMES[name]) || name;
  const initials = String(full).split(/\s+/).map(w => w[0] || '').join('').toUpperCase().slice(0, 3) || 'INV';
  return { name: o.name || full, trading: o.trading || '', address: o.address || '', email: o.email || '', phone: o.phone || '', utr: o.utr || '',
    bankName: o.bankName || '', sort: o.sort || '', acc: o.acc || '', prefix: o.prefix || initials, days: Number(o.days) > 0 ? Number(o.days) : 7,
    vatNo: o.vatNo || '', vatOn: !!(o.vatOn && o.vatNo), vatNote: o.vatOn && o.vatNo ? '' : (o.vatNote != null ? o.vatNote : 'Not VAT registered - no VAT charged.'), next: Number(props().getProperty('dinv_next_' + name) || '1') };
}
function issuerSave(d, who) {
  const it = d.issuer || {};
  const sort = String(it.sort || '').replace(/\D/g, ''), acc = String(it.acc || '').replace(/\D/g, '');
  if (!cleanText(it.name, 80)) return { ok: false, message: 'Add your full name.' };
  if ((sort || acc) && (sort.length !== 6 || acc.length !== 8)) return { ok: false, message: 'Bank details: a 6-digit sort code and an 8-digit account number.' };
  if (it.email && !validEmail(it.email)) return { ok: false, message: 'Check the email address.' };
  const vd = String(it.vatNo || '').toUpperCase().replace(/^GB/, '').replace(/\D/g, '');
  if (vd && vd.length !== 9 && vd.length !== 12) return { ok: false, message: 'VAT number: GB and 9 digits, e.g. GB123456789.' };
  if (it.vatOn && !vd) return { ok: false, message: 'Add your VAT number to switch VAT on.' };
  const o = { vatNo: vd ? 'GB' + vd : '', vatOn: !!it.vatOn, name: cleanText(it.name, 80), trading: cleanText(it.trading, 80), address: String(it.address || '').replace(/\r/g, '').slice(0, 300), email: cleanText(it.email, 120),
    phone: cleanText(it.phone, 40), utr: cleanText(it.utr, 20), bankName: cleanText(it.bankName, 80), sort: sort ? sort.replace(/(\d\d)(\d\d)(\d\d)/, '$1-$2-$3') : '', acc: acc,
    prefix: cleanText(it.prefix, 6).toUpperCase().replace(/[^A-Z0-9]/g, '') || '', days: Math.max(0, Math.min(90, Math.round(Number(it.days) || 7))), vatNote: it.vatNote === undefined ? 'Not VAT registered - no VAT charged.' : cleanText(it.vatNote, 120) };
  props().setProperty('issuer_' + who, JSON.stringify(o));
  return { ok: true, issuer: issuerOf(who) };
}
/* billing details we already know (can be changed in the panel). GMT Group pays the Tradeteam runs: 30 days, invoices numbered by week ending */
const GMT_BILLING = { name: 'GMT Group Limited', address: 'The Stables\nAsh Park Business Centre\nAsh Lane\nLittle London\nTadley\nHampshire\nRG26 5FL', email: 'accounts2@gmt-transport.uk', days: 30, numbering: 'we' };
const DEFAULT_DIARY_CLIENTS = { 'gmt group limited': GMT_BILLING, 'gmt': GMT_BILLING, 'tradeteam': GMT_BILLING, 'tt': GMT_BILLING, 'fedex': GMT_BILLING };   // FedEx runs are paid by GMT too
function billTo(c) { const k = diaryClients()[String(c || '').toLowerCase()]; return k && k.name ? k.name : ''; }
function billKey(c) { return String(billTo(c) || c || '').trim().toLowerCase(); }
function diaryClients() {
  let saved = {}; try { saved = JSON.parse(props().getProperty('diary_clients') || '{}') || {}; } catch (e) {}
  return Object.assign({}, DEFAULT_DIARY_CLIENTS, saved);
}
function diaryClientSave(c) {
  const name = cleanText(c && c.name, 80);
  if (!name) return;
  let saved = {}; try { saved = JSON.parse(props().getProperty('diary_clients') || '{}') || {}; } catch (e) {}
  const key = String(c.key || name).toLowerCase();
  saved[key] = { name: cleanText(c.billName, 80) || name, address: String(c.address || '').replace(/\r/g, '').slice(0, 400), email: cleanText(c.email, 120),
    days: Math.max(0, Math.min(120, Math.round(Number(c.days) || 0))) || '', numbering: c.numbering === 'we' ? 'we' : 'seq' };
  props().setProperty('diary_clients', JSON.stringify(saved));
}
function dinvSheet() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName('DiaryInvoices');
  if (!sh) { sh = ss.insertSheet('DiaryInvoices'); sh.appendRow(['Number', 'Created', 'Driver', 'Client', 'Period', 'Entry IDs', 'Total', 'Status', 'Status changed', 'Due', 'Sent to', 'Week ending', 'VAT', 'Source', 'File']); }
  return sh;
}
function dinvRows() {
  return dinvSheet().getDataRange().getValues().slice(1).filter(r => String(r[0] || '').trim()).map((r, i) => ({ row: i + 2, number: String(r[0]), created: isoOf(r[1]), driver: String(r[2] || ''),
    client: String(r[3] || ''), period: String(r[4] || ''), ids: String(r[5] || '').split(',').map(x => x.trim()).filter(Boolean), total: Number(r[6]) || 0, status: String(r[7] || ''), changed: isoOf(r[8]), due: String(r[9] || ''), sentTo: String(r[10] || ''), weekEnding: r[11] instanceof Date ? Utilities.formatDate(r[11], 'Europe/London', 'yyyy-MM-dd') : String(r[11] || ''), vat: r[12] === '' || r[12] == null ? null : Number(r[12]) || 0, source: String(r[13] || ''), file: String(r[14] || '') }));
}
function dinvMap() { const m = {}; dinvRows().forEach(v => { if (v.status !== 'Void') v.ids.forEach(id => { m[id] = v.number; }); }); return m; }

/* the PDF: the driver's own invoice (no PRJ branding) */
function buildDiaryInvoicePdf(o) {   // the PRJ Logistics invoice design, with the driver's own details
  const is = o.issuer;
  const from = [is.trading || is.name].concat(is.trading ? [is.name] : []).concat(String(is.address || '').split(/\n/).map(x => x.trim()).filter(Boolean).slice(0, 4))
    .concat([is.email, is.phone, is.vatOn ? 'VAT No: ' + is.vatNo : '', is.utr ? 'UTR: ' + is.utr : ''].filter(Boolean));
  return buildInvoicePdf({
    number: o.number, date: o.date, due: o.due, period: o.period, single: false,
    company: o.client.name, customer: '', address: String(o.client.address || '').replace(/\n+/g, ', '), email: o.client.email,
    weekEnding: o.weekEnding, terms: o.terms, vat: o.vat,
    from: from, noRef: true, noLogo: true, compact: true, headName: is.trading || is.name, headSub: is.trading ? is.name : '', vatNote: is.vatNote, contact: [is.email, is.phone].filter(Boolean).join(' or ') || is.name,
    footer: [[is.trading || is.name, is.vatOn ? 'VAT No ' + is.vatNo : '', is.utr ? 'UTR ' + is.utr : ''].filter(Boolean).join(' - '), [is.email, is.phone].filter(Boolean).join(' - ')],
    lines: o.lines.map(ln => ({ date: ln.date, ref: '', route: [ln.job].concat((ln.stops || []).map((x, k) => '  ' + (k + 1) + '. ' + x)).concat(ln.notes ? ['  ' + ln.notes] : []).join('\n'), price: ln.amount })),
    total: o.total, bankDetails: is.acc ? { name: is.bankName || is.name, sort: is.sort, acc: is.acc } : {}, bank: '',
    thanks: 'Thank you for your business. ' + o.lines.length + ' run' + (o.lines.length === 1 ? '' : 's') + ', ' + o.period + '.'
  });
}

function weekEndingOf(dates) {   // the Sunday of the week (Monday-Sunday) of the latest run
  const last = dates.slice().sort().pop(); if (!last) return '';
  const x = new Date(last + 'T12:00:00Z'); const add = (7 - x.getUTCDay()) % 7; x.setUTCDate(x.getUTCDate() + add);
  return x.toISOString().slice(0, 10);
}
function diaryInvoiceMake(d, who) {
  const all = diaryList(''), map = dinvMap(), invs = dinvRows();
  let number = String(d.number || '').trim(), ids, driver, client;
  let existing = number ? invs.find(v => v.number === number && (!d.driver || v.driver === d.driver) && v.status !== 'Void') || invs.find(v => v.number === number && (!d.driver || v.driver === d.driver)) : null;
  if (existing) {
    if (existing.status === 'Void') return { ok: false, message: 'This invoice was cancelled (void).' };
    if (existing.source === 'ext') return existing.file ? { ok: true, number: existing.number, name: existing.number.replace(/\//g, '-') + ' ' + existing.driver + '.pdf', total: priceText(existing.total), url: existing.file, saved: false, external: true } : { ok: false, message: 'This invoice was made in another program and has no PDF here.' };
    ids = existing.ids; driver = existing.driver; client = String(existing.client).split(' + ')[0];
  } else {
    number = '';
    driver = cleanText(d.driver, 40); client = cleanText(d.client, 80);
    ids = (Array.isArray(d.ids) ? d.ids : []).map(x => cleanText(x, 20)).filter(Boolean);
    if (!ids.length) return { ok: false, message: 'Tick the runs to invoice.' };
  }
  const lines = ids.map(id => all.find(x => x.id === id)).filter(Boolean).sort(diaryOrder);
  if (lines.length !== ids.length) return { ok: false, message: 'Some runs were deleted. Refresh the list.' };
  if (!existing) {
    for (const x of lines) {
      if (x.driver !== driver) return { ok: false, message: 'One invoice can only have runs of one driver.' };
      if (billKey(x.client) !== billKey(client)) return { ok: false, message: 'One invoice can only have runs paid by one company. ' + x.client + ' is billed to ' + (billTo(x.client) || x.client) + '.' };
      if (map[x.id]) return { ok: false, message: diaryDayText(x.date) + ' ' + x.job + ' is already on invoice ' + map[x.id] + '.' };
    }
    if (!client) return { ok: false, message: 'These runs have no client. Edit them and add the client first.' };
  }
  const runClients = lines.map(x => x.client).filter((c, k, a) => c && a.indexOf(c) === k), multi = runClients.length > 1;
  if (!existing && driver !== who && !d.forOther) return { ok: false, needsConfirm: true, message: 'You are making an invoice for ' + driver + ' with ' + driver + "'s invoice details. Continue?" };
  const is = issuerOf(driver);
  if (!existing && !is.acc && !d.noBank) return { ok: false, needsIssuer: true, message: driver + "'s invoice details (name, address, bank) are not set up yet." };
  const known = diaryClients()[String(client).toLowerCase()] || {};
  const cd = d.clientDetails || {};
  const cl = { name: cleanText(cd.name, 80) || known.name || client, address: cd.address != null ? String(cd.address) : (known.address || ''), email: cd.email != null ? cleanText(cd.email, 120) : (known.email || ''),
    days: Number(cd.days) > 0 ? Number(cd.days) : (Number(known.days) > 0 ? Number(known.days) : is.days), numbering: cd.numbering || known.numbering || 'seq' };
  if (d.clientDetails && (d.save || d.send)) diaryClientSave({ key: client, name: client, billName: cl.name, address: cl.address, email: cl.email, days: cl.days, numbering: cl.numbering });
  const p = props(), now = new Date();
  const days = lines.map(x => x.date).sort();
  const weIn = /^\d{4}-\d{2}-\d{2}$/.test(String(d.weekEnding || '')) ? String(d.weekEnding) : '';   // the week ending chosen on the form, else the Sunday after the last run
  const we = existing ? existing.weekEnding : (cl.numbering === 'we' ? (weIn || weekEndingOf(days)) : '');
  if (!number) {
    if (cl.numbering === 'we') {
      number = 'WE' + we.slice(8, 10) + '/' + we.slice(5, 7) + '/' + we.slice(2, 4);
      const clash = invs.find(v => v.number === number && v.driver === driver && v.status !== 'Void');
      if (clash) return { ok: false, message: driver + ' already has invoice ' + number + ' for this week. Void it first if it was wrong.' };
    } else {
      const ru = cleanText(d.reuse, 40);   // correcting a cancelled invoice: keep its running number
      if (ru && !/^WE/.test(ru) && invs.some(v => v.number === ru && v.driver === driver && v.status === 'Void') && !invs.some(v => v.number === ru && v.driver === driver && v.status !== 'Void')) number = ru;
      else { const nx = is.next; number = is.prefix + '-' + now.getFullYear() + '-' + ('00' + nx).slice(-3); if (d.save) p.setProperty('dinv_next_' + driver, String(nx + 1)); }
    }
  }
  const fmtD = x => Utilities.formatDate(x, 'Europe/London', 'd MMM yyyy');
  const tag = x => multi && x.client ? x.client + ' - ' : '';
  const dueD = existing && existing.due ? existing.due : fmtD(new Date(now.getTime() + cl.days * 86400000));
  const net = Math.round(lines.reduce((t, x) => t + (x.amount || 0), 0) * 100) / 100;
  const vatAmt = existing ? existing.vat : (is.vatOn ? Math.round(net * 0.2 * 100) / 100 : null);
  const total = Math.round((net + (vatAmt || 0)) * 100) / 100;
  const o = { vat: vatAmt != null ? { net: priceText(net), vat: priceText(vatAmt), rate: 20, no: is.vatNo } : null, number: number, date: existing ? fmtD(new Date(existing.created)) : fmtD(now), due: dueD, period: periodLabel(days), issuer: is,
    weekEnding: we ? we.slice(8, 10) + '/' + we.slice(5, 7) + '/' + we.slice(2, 4) : '', terms: cl.days + ' days',
    client: { name: cl.name, address: cl.address, email: cl.email },
    lines: lines.map(x => ({ date: fmtD(new Date(x.date + 'T12:00:00Z')), job: tag(x) + (x.job && !(x.stops.length && x.job === x.stops.join(' → ')) ? x.job : (x.stops.length + (x.stops.length === 1 ? ' stop' : ' stops'))), stops: x.stops, notes: x.notes, amount: x.amount ? priceText(x.amount) : '-' })),
    total: priceText(total) };
  const bytes = buildDiaryInvoicePdf(o), name = number.replace(/\//g, '-') + ' ' + (is.name || driver) + '.pdf';
  let row = existing ? existing.row : 0;
  if ((d.save || d.send) && !existing) { const sh2 = dinvSheet(); sh2.appendRow([number, now, driver, runClients.join(' + ') || client, o.period, ids.join(','), total, '', '', dueD, '', we, vatAmt != null ? vatAmt : '']); row = sh2.getLastRow(); }
  let sentTo = '';
  if (d.send) {
    const to = cleanText(d.to, 120) || cl.email;
    if (!validEmail(to)) return { ok: false, message: 'Add the client email to send the invoice.' };
    const html = '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#0E1726;max-width:560px">' +
      '<p>Hello,</p><p>Please find attached my invoice <b>' + esc(number) + '</b>' + (o.weekEnding ? ' (week ending ' + esc(o.weekEnding) + ')' : '') + ' for ' + lines.length + ' run' + (lines.length === 1 ? '' : 's') + ', ' + esc(o.period) + '.</p>' +
      '<p style="font-size:18px;margin:12px 0"><b>Total: ' + esc(o.total) + (o.vat ? ' (incl. VAT ' + esc(o.vat.vat) + ')' : '') + '</b><br><span style="font-size:14px;color:#5E6B7C">Payment due by ' + esc(dueD) + ' (' + esc(o.terms) + ')</span></p>' +
      '<p>Bank details are on the invoice. Please use ' + esc(number) + ' as the payment reference.</p>' +
      '<p>Kind regards,<br>' + esc(is.name) + (is.phone ? '<br>' + esc(is.phone) : '') + (is.email ? '<br>' + esc(is.email) : '') + '</p></div>';
    sendCustomerMail({ to: to, subject: 'Invoice ' + number + ' - ' + is.name, htmlBody: html, name: is.name, replyTo: is.email || OWNER_EMAIL, bcc: is.email && is.email.toLowerCase() !== to.toLowerCase() ? is.email : '',
      body: 'Hello,\n\nPlease find attached my invoice ' + number + (o.weekEnding ? ' (week ending ' + o.weekEnding + ')' : '') + ', total ' + o.total + (o.vat ? ' incl. VAT' : '') + ', due by ' + dueD + '.\n\nKind regards,\n' + is.name,
      attachments: [Utilities.newBlob(bytes, 'application/pdf', name)] });
    sentTo = to;
    if (row) dinvSheet().getRange(row, 11).setValue(to);
  }
  let url = '';
  if (d.link) { try { const f = getPodFolder().createFile(Utilities.newBlob(bytes, 'application/pdf', name)); url = f.getUrl(); } catch (e) {} }   // saved as e.g. "WE15-11-26 Patryk Forgiel.pdf"
  const res = { ok: true, number: number, name: name, total: o.total, vat: o.vat ? o.vat.vat : '', net: priceText(net), saved: !!(d.save || d.send), sentTo: sentTo };
  if (url) res.url = url; else res.pdf = Utilities.base64Encode(bytes);
  return res;
}
function diaryDayText(d) { try { return Utilities.formatDate(new Date(d + 'T12:00:00Z'), 'Europe/London', 'EEE d MMM'); } catch (e) { return d; } }
/* removes a cancelled (void) invoice from the list for good; live and paid invoices cannot be deleted */
function diaryInvoiceDelete(d) {
  const created = String(d.created || '');
  const v = dinvRows().find(x => x.number === String(d.number || '') && (!d.driver || x.driver === d.driver) && x.status === 'Void' && (!created || String(x.created) === created));
  if (!v) return { ok: false, message: 'Only a cancelled (void) invoice can be deleted.' };
  dinvSheet().deleteRow(v.row);
  return { ok: true };
}
/* an invoice made in another program (QuickBooks, a client's self-billing portal): recorded here so its runs count as invoiced and its money can be matched */
function diaryInvoiceAdd(d, who) {
  const drivers = Object.keys(USERS).map(u => String(USERS[u].name));
  const driver = cleanText(d.driver, 40) || who;
  if (drivers.indexOf(driver) < 0) return { ok: false, message: 'Choose the driver.' };
  const number = cleanText(d.number, 40), client = cleanText(d.client, 80);
  if (!number) return { ok: false, message: 'Write the invoice number.' };
  if (!client) return { ok: false, message: 'Write the client.' };
  const invs = dinvRows();
  if (invs.some(v => v.number === number && v.driver === driver && v.status !== 'Void')) return { ok: false, message: driver + ' already has invoice ' + number + '.' };
  const total = priceNum(d.total);
  if (!(total > 0)) return { ok: false, message: 'Write the invoice total (including VAT).' };
  const vat = String(d.vat == null ? '' : d.vat).trim() === '' ? '' : priceNum(d.vat);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(d.date || '')) ? String(d.date) : Utilities.formatDate(new Date(), 'Europe/London', 'yyyy-MM-dd');
  const due = /^\d{4}-\d{2}-\d{2}$/.test(String(d.due || '')) ? Utilities.formatDate(new Date(d.due + 'T12:00:00Z'), 'Europe/London', 'd MMM yyyy') : '';
  const all = diaryList(''), map = dinvMap();
  const ids = (Array.isArray(d.ids) ? d.ids : []).map(x => cleanText(x, 20)).filter(Boolean);
  const lines = ids.map(id => all.find(x => x.id === id)).filter(Boolean);
  if (lines.length !== ids.length) return { ok: false, message: 'Some runs were deleted. Refresh the list.' };
  for (const x of lines) {
    if (x.driver !== driver) return { ok: false, message: 'One invoice can only have runs of one driver.' };
    if (map[x.id]) return { ok: false, message: diaryDayText(x.date) + ' ' + x.job + ' is already on invoice ' + map[x.id] + '.' };
  }
  let url = '';
  if (d.file && d.file.b64) {
    const b64 = String(d.file.b64);
    if (b64.length > 7000000) return { ok: false, message: 'The PDF is too big (max about 5 MB).' };
    try { const name = (number.replace(/\//g, '-') + ' ' + driver + '.pdf').replace(/[^\w .-]/g, '_'); url = getPodFolder().createFile(Utilities.newBlob(Utilities.base64Decode(b64), 'application/pdf', name)).getUrl(); } catch (e) { return { ok: false, message: 'Could not save the PDF.' }; }
  }
  const days = lines.map(x => x.date).sort(), period = days.length ? periodLabel(days) : 'Other program';
  dinvSheet().appendRow([safeCell(number), new Date(date + 'T12:00:00Z'), driver, safeCell(client), period, ids.join(','), total, '', '', due, '', '', vat, 'ext', url]);
  return { ok: true, number: number, total: priceText(total), file: url };
}
function diaryInvoiceStatus(d) {
  const v = dinvRows().find(x => x.number === String(d.number || '') && (!d.driver || x.driver === d.driver) && x.status !== 'Void') || dinvRows().find(x => x.number === String(d.number || '') && (!d.driver || x.driver === d.driver));
  if (!v) return { ok: false, message: 'Invoice not found.' };
  const to = String(d.status || '');
  if (['', 'Paid', 'Void'].indexOf(to) < 0) return { ok: false, message: 'Unknown status.' };
  if (v.status === 'Void') return { ok: false, message: 'This invoice is void.' };
  dinvSheet().getRange(v.row, 8, 1, 2).setValues([[to, new Date()]]);
  return { ok: true };
}

/* ===================== spending: fuel, ULEZ, charges, parking, repairs... (admin panel "Spending" tab) =====================
   Sheet "Spending": ID | Date | Who | Category | Amount | Paid | Notes | Vehicle | Added | Updated | By */
const SPEND_CATS = ['Fuel', 'ULEZ', 'Congestion Charge', 'Dart Charge', 'Parking', 'Tolls', 'Repairs & service', 'Tyres', 'Van wash', 'Equipment', 'Phone', 'Insurance', 'Other'];
function spendSheet() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName('Spending');
  if (!sh) { sh = ss.insertSheet('Spending'); sh.appendRow(['ID', 'Date', 'Who', 'Category', 'Amount', 'Paid', 'Notes', 'Vehicle', 'Added', 'Updated', 'By']); }
  return sh;
}
function spendRow(r) {
  const d = r[1] instanceof Date ? Utilities.formatDate(r[1], 'Europe/London', 'yyyy-MM-dd') : String(r[1] || '');
  return { id: String(r[0]), date: d, who: String(r[2] || ''), category: String(r[3] || ''), amount: priceNum(r[4]), paid: String(r[5]) === 'yes', notes: String(r[6] || ''), vehicle: String(r[7] || ''), addedAt: isoOf(r[8]), updatedAt: isoOf(r[9]), by: String(r[10] || '') };
}
function spendList() {
  return spendSheet().getDataRange().getValues().slice(1).filter(r => r[0]).map(spendRow)
    .sort((a, b) => (a.date + a.addedAt).localeCompare(b.date + b.addedAt));
}
function spendSave(d, by) {
  const it = d.item || {};
  const date = String(it.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, message: 'Choose the date.' };
  const people = Object.keys(USERS).map(u => String(USERS[u].name));
  const who = cleanText(it.who, 40);
  if (people.indexOf(who) < 0) return { ok: false, message: 'Choose who paid.' };
  const category = cleanText(it.category, 40);
  if (!category) return { ok: false, message: 'Choose what it was for.' };
  const amount = priceNum(it.amount);
  if (!(amount > 0) || amount > 100000) return { ok: false, message: 'Enter the amount, e.g. 65.40' };
  const vals = [safeCell(date), safeCell(who), safeCell(category), amount, it.paid ? 'yes' : 'no', safeCell(cleanText(it.notes, 300)), safeCell(cleanText(it.vehicle, 20).toUpperCase())];
  const sh = spendSheet(), rows = sh.getDataRange().getValues(), now = new Date();
  if (it.id) {
    for (let i = 1; i < rows.length; i++) if (String(rows[i][0]) === String(it.id)) {
      const r = [rows[i][0]].concat(vals, [rows[i][8] || now, now, by]);
      sh.getRange(i + 1, 1, 1, 11).setValues([r]);
      return { ok: true, item: spendRow(r) };
    }
    return { ok: false, message: 'Not found. Refresh the list.' };
  }
  const r = [Utilities.getUuid().replace(/-/g, '').slice(0, 10)].concat(vals, [now, now, by]);
  sh.appendRow(r);
  return { ok: true, item: spendRow(r) };
}
function spendPaid(id, paid, by) {
  const sh = spendSheet(), rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) if (String(rows[i][0]) === String(id)) {
    sh.getRange(i + 1, 6).setValue(paid ? 'yes' : 'no'); sh.getRange(i + 1, 10, 1, 2).setValues([[new Date(), by]]);
    const r = rows[i].slice(); r[5] = paid ? 'yes' : 'no'; return { ok: true, item: spendRow(r) };
  }
  return { ok: false, message: 'Not found.' };
}
function spendDelete(id) {
  const sh = spendSheet(), rows = sh.getDataRange().getValues();
  for (let i = rows.length - 1; i >= 1; i--) if (String(rows[i][0]) === String(id)) { sh.deleteRow(i + 1); return { ok: true }; }
  return { ok: false, message: 'Not found.' };
}

/* ===================== outreach list: local businesses we email (admin panel, "Outreach" tab) =====================
   Sheet "Outreach": ID | Company | Email | Phone | Area | Type | Ltd | Status | Emailed | Follow-up | Replied | Note | Added | Updated | By
   Status: todo, emailed, followup, replied, customer, no, stop ("stop" = asked us not to contact them again: keep the row so nobody emails them again). */
const OUTREACH_SHEET = 'Outreach';
const OUTREACH_STATUS = ['todo', 'emailed', 'followup', 'replied', 'customer', 'no', 'stop'];
function outreachSheet() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(OUTREACH_SHEET);
  if (!sh) { sh = ss.insertSheet(OUTREACH_SHEET); sh.appendRow(['ID', 'Company', 'Email', 'Phone', 'Area', 'Type', 'Ltd', 'Status', 'Emailed', 'Follow-up', 'Replied', 'Note', 'Added', 'Updated', 'By']); }
  return sh;
}
function outreachRow(r) {
  return { id: String(r[0]), name: String(r[1] || ''), email: String(r[2] || ''), phone: String(r[3] || ''), area: String(r[4] || ''), sector: String(r[5] || ''),
    ltd: String(r[6]) === 'yes', status: String(r[7] || 'todo'), emailedAt: isoOf(r[8]), followupAt: isoOf(r[9]), repliedAt: isoOf(r[10]), note: String(r[11] || ''),
    addedAt: isoOf(r[12]), updatedAt: isoOf(r[13]), by: String(r[14] || ''), emails: (function () { try { return JSON.parse(String(r[15] || '[]')) || []; } catch (e) { return []; } })() };
}
function allOutreach() { return outreachSheet().getDataRange().getValues().slice(1).filter(r => r[0]).map(outreachRow); }
function outNorm(s) { return String(s || '').toLowerCase().replace(/\b(ltd|limited|llp|plc|uk|the)\b/g, '').replace(/[^a-z0-9]/g, ''); }
function outDomain(e) { const m = /@([^@\s]+)$/.exec(String(e || '').toLowerCase()); return m && !/^(gmail|googlemail|hotmail|outlook|yahoo|icloud|btinternet|live|aol|sky)\./.test(m[1]) ? m[1] : ''; }
function outreachDup(list, name, email, skipId) {
  const n = outNorm(name), em = String(email || '').trim().toLowerCase(), dm = outDomain(email);
  return list.find(x => x.id !== skipId && ((n && outNorm(x.name) === n) || (em && x.email.toLowerCase() === em) || (dm && outDomain(x.email) === dm))) || null;
}
function outreachSave(d, by) {
  const it = d.item || {};
  const name = cleanText(it.name, 120), email = cleanText(it.email, 160);
  if (!name && !it.id) return { ok: false, message: 'Add the company name.' };
  if (email && !validEmail(email)) return { ok: false, message: 'Check the email address.' };
  const sh = outreachSheet(), rows = sh.getDataRange().getValues(), list = rows.slice(1).filter(r => r[0]).map(outreachRow);
  const now = new Date();
  if (it.id) {
    if (it.name !== undefined || it.email !== undefined) {   // editing: the new name or email must not belong to another company on the list
      const cur = list.find(x => x.id === String(it.id)) || {};
      const dup = outreachDup(list, it.name !== undefined ? name : cur.name, it.email !== undefined ? email : cur.email, String(it.id));
      if (dup) return { ok: false, duplicate: true, message: dup.name + ' is already on the list with this name or email.' };
    }
    for (let i = 1; i < rows.length; i++) if (String(rows[i][0]) === String(it.id)) {
      const r = rows[i].slice(); while (r.length < 15) r.push('');
      if (it.name !== undefined && name) r[1] = safeCell(name);
      if (it.email !== undefined) r[2] = safeCell(email);
      if (it.phone !== undefined) r[3] = safeCell(cleanText(it.phone, 40));
      if (it.area !== undefined) r[4] = safeCell(cleanText(it.area, 80));
      if (it.sector !== undefined) r[5] = safeCell(cleanText(it.sector, 60));
      if (it.ltd !== undefined) r[6] = it.ltd ? 'yes' : '';
      if (it.status !== undefined) {
        const st = String(it.status);
        if (OUTREACH_STATUS.indexOf(st) < 0) return { ok: false, message: 'Unknown status.' };
        r[7] = st;
        if (st === 'emailed' && !r[8]) r[8] = now;
        if (st === 'followup' && !r[9]) r[9] = now;
        if (st === 'replied' && !r[10]) r[10] = now;
      }
      if (it.note !== undefined) r[11] = safeCell(String(it.note || '').slice(0, 400));
      r[13] = now; r[14] = by;
      sh.getRange(i + 1, 1, 1, 15).setValues([r.slice(0, 15)]);
      return { ok: true, item: outreachRow(r) };
    }
    return { ok: false, message: 'Not found. Refresh the list.' };
  }
  const dup = outreachDup(list, name, email, '');
  if (dup) return { ok: false, duplicate: true, message: dup.name + ' is already on the list.' };
  const id = Utilities.getUuid().replace(/-/g, '').slice(0, 10);
  const r = [id, safeCell(name), safeCell(email), safeCell(cleanText(it.phone, 40)), safeCell(cleanText(it.area, 80)), safeCell(cleanText(it.sector, 60)),
    it.ltd ? 'yes' : '', 'todo', '', '', '', '', now, now, by];
  sh.appendRow(r);
  return { ok: true, item: outreachRow(r) };
}
function outreachBulk(d, by) {
  const lines = Array.isArray(d.lines) ? d.lines.slice(0, 300) : [];
  const sh = outreachSheet(), list = sh.getDataRange().getValues().slice(1).filter(r => r[0]).map(outreachRow);
  let added = 0, skipped = 0;
  lines.forEach(l => {
    const name = cleanText(l && l.name, 120), email = cleanText(l && l.email, 160);
    if (!name || (email && !validEmail(email)) || outreachDup(list, name, email, '')) { skipped++; return; }
    const now = new Date(), id = Utilities.getUuid().replace(/-/g, '').slice(0, 10);
    const r = [id, safeCell(name), safeCell(email), safeCell(cleanText(l.phone, 40)), safeCell(cleanText(l.area, 40) || 'Other'), safeCell(cleanText(l.sector, 60)),
      /\b(ltd|limited|llp|plc)\b/i.test(name) ? 'yes' : '', 'todo', '', '', '', '', now, now, by];
    sh.appendRow(r); list.push(outreachRow(r)); added++;
  });
  return { ok: true, added: added, skipped: skipped };
}
/* Email to a company on the Outreach list, sent by our system from contact@ (with our logo and company details at the bottom).
   UK rules (PECR): a limited company can be emailed about our services, with an easy way to say no; a sole trader or partnership
   only with their consent, so the panel asks you to confirm when the company is not ticked as Ltd. "stop" = never email again. */
const FULL_NAMES = { Patryk: 'Patryk Forgiel', Pawel: 'Pawel Jasinski' };   // used to sign emails to companies
function outreachEmail(d, who) {
  const signers = Object.keys(USERS).map(u => String(USERS[u].name));
  if (d.signAs && signers.indexOf(String(d.signAs)) >= 0) who = String(d.signAs);   // sign as Patryk or Pawel
  const fullName = FULL_NAMES[who] || who;
  const id = cleanText(d.id, 20), subject = cleanText(d.subject, 150), body = String(d.body || '').replace(/\r/g, '').trim().slice(0, 5000);
  if (!subject || body.length < 20) return { ok: false, message: 'Write the subject and the message.' };
  const sh = outreachSheet(), rows = sh.getDataRange().getValues();
  let i = 1;
  for (; i < rows.length; i++) if (String(rows[i][0]) === id) break;
  if (i >= rows.length) return { ok: false, message: 'Not found. Refresh the list.' };
  const it = outreachRow(rows[i]);
  if (!validEmail(it.email)) return { ok: false, message: 'This company has no email address.' };
  if (it.status === 'stop' || it.status === 'no') return { ok: false, message: it.name + ' asked not to be contacted.' };
  if (!it.ltd && !d.notLtdOk) return { ok: false, needsConfirm: true, message: it.name + ' is not ticked as a Ltd company. Sole traders and partnerships can only be emailed if they agreed to it (e.g. you met them at networking). Send anyway?' };
  const cache = CacheService.getScriptCache(), dk = 'oe_' + Utilities.formatDate(new Date(), 'Europe/London', 'yyyyMMdd'), n = Number(cache.get(dk) || 0);
  if (n >= 40) return { ok: false, message: 'That is 40 emails today. Send the rest tomorrow, so our emails do not end up in spam.' };
  cache.put(dk, String(n + 1), 86400);
  const town = String(it.area || '').split(',')[0].trim();
  const fill = t => String(t).replace(/\{company\}/gi, it.name).replace(/\{me\}/gi, fullName || '').replace(/\{town\}/gi, town && town !== 'Other' ? town : 'your area');
  const txt = fill(body), subj = fill(subject);
  // plain text -> tidy email: paragraphs, "Heading:" lines in bold, "- item" lines as a bullet list, links clickable
  const link = t => t.replace(/(https?:\/\/[^\s<]+|(?:www\.)?prjlogistics\.co\.uk[^\s<]*?)(?=[.,;)]?(\s|$))/g, u => '<a href="' + (/^https?:/.test(u) ? u : 'https://' + u.replace(/^(?!www\.)/, 'www.')) + '" style="color:#3F6E10">' + u + '</a>');
  const htmlText = txt.split(/\n\s*\n/).map(block => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    let out = '', items = [];
    const flush = () => { if (items.length) { out += '<ul style="margin:4px 0 0;padding-left:20px">' + items.map(x => '<li style="margin:3px 0">' + link(esc(x)) + '</li>').join('') + '</ul>'; items = []; } };
    lines.forEach(l => {
      const m = /^[-•*]\s+(.*)$/.exec(l);
      if (m) items.push(m[1]);
      else { flush(); out += (out ? '<br>' : '') + (/:$/.test(l) && l.length < 60 ? '<b>' + esc(l) + '</b>' : link(esc(l))); }
    });
    flush();
    return '<p style="margin:0 0 14px">' + out + '</p>';
  }).join('');
  const sign = (fullName ? '<b>' + esc(fullName) + '</b><br>Director<br>' : '') + esc(COMPANY) + '<br>' + esc(PHONE) + ' · +44 7598 888192 (WhatsApp)<br><a href="' + SITE_URL + '" style="color:#3F6E10">prjlogistics.co.uk</a>';
  const html = '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#0E1726;max-width:560px">' + htmlText +
    '<p style="margin-top:18px">' + sign + '</p>' +
    '<p style="font-size:12px;color:#8A95A3;margin-top:18px">You are receiving this because ' + esc(it.name) + ' is a local business we would like to work with. If you would rather not hear from us, just reply "stop" and we will not email you again.</p></div>';
  try {
    sendCustomerMail({ to: it.email, subject: subj, htmlBody: html, replyTo: OWNER_EMAIL, name: COMPANY,   // no copy to contact@: the sent emails are kept with the company (admin panel, "See email")
      body: txt + '\n\n' + (fullName ? fullName + '\nDirector\n' : '') + COMPANY + '\n' + PHONE + '\n' + SITE_URL + '\n\nIf you would rather not hear from us, just reply "stop" and we will not email you again.' });
  } catch (e) { logError('Outreach email failed for ' + it.name + ': ' + e); return { ok: false, message: 'The email could not be sent. Please try again later.' }; }
  const r = rows[i].slice(), now = new Date(); while (r.length < 15) r.push('');
  if (it.status === 'todo') { r[7] = 'emailed'; r[8] = now; }
  else if (it.status === 'emailed') { r[7] = 'followup'; r[9] = now; }
  r[11] = safeCell((Utilities.formatDate(now, 'Europe/London', 'd MMM') + ' email: ' + subj + (it.note ? ' | ' + it.note : '')).slice(0, 400));
  r[13] = now; r[14] = who;
  let hist = []; try { hist = JSON.parse(String(rows[i][15] || '[]')) || []; } catch (e) {}
  hist.push({ at: now.toISOString(), to: it.email, subject: subj, body: txt, by: fullName || who });
  if (!sh.getRange(1, 16).getValue()) sh.getRange(1, 16).setValue('Emails sent');
  const saved = r.slice(0, 15).concat([JSON.stringify(hist.slice(-5))]);
  sh.getRange(i + 1, 1, 1, 16).setValues([saved]);
  try { logUpload('-', 'Outreach email to ' + it.name + ': ' + subj, who, 0); } catch (e) {}
  return { ok: true, item: outreachRow(saved) };
}
/* the same email to several companies ticked on the Outreach list ({company} becomes each company's name).
   Skips companies that are not ticked as Ltd, asked not to be contacted, are already customers or replied. Stops at the daily limit. */
function outreachEmailMany(d, who) {
  const ids = Array.isArray(d.ids) ? d.ids.map(x => cleanText(x, 20)).filter(Boolean).slice(0, 20) : [];
  if (!ids.length) return { ok: false, message: 'Tick the companies first.' };
  const subject = cleanText(d.subject, 150), body = String(d.body || '').replace(/\r/g, '').trim();
  if (!subject || body.length < 20) return { ok: false, message: 'Write the subject and the message.' };
  const all = allOutreach(), results = [];
  let limit = false;
  ids.forEach(id => {
    const it = all.find(x => x.id === id);
    if (!it) { results.push({ id: id, name: '?', ok: false, reason: 'not found' }); return; }
    if (limit) { results.push({ id: id, name: it.name, ok: false, reason: 'daily limit (40) reached - send tomorrow' }); return; }
    if (it.status === 'customer' || it.status === 'replied') { results.push({ id: id, name: it.name, ok: false, reason: it.status === 'customer' ? 'already a customer' : 'already replied - write to them yourself' }); return; }
    const r = outreachEmail({ id: id, subject: subject, body: body, signAs: d.signAs }, who);
    if (r.ok) { results.push({ id: id, name: it.name, ok: true, item: r.item }); return; }
    if (/40 emails today/.test(r.message || '')) { limit = true; results.push({ id: id, name: it.name, ok: false, reason: 'daily limit (40) reached - send tomorrow' }); return; }
    results.push({ id: id, name: it.name, ok: false, reason: r.needsConfirm ? 'not ticked as Ltd' : !validEmail(it.email) ? 'no email address' : (it.status === 'stop' || it.status === 'no') ? 'asked not to be contacted' : (r.message || 'not sent') });
  });
  return { ok: true, sent: results.filter(x => x.ok).length, results: results };
}
function outreachDelete(id) {
  const sh = outreachSheet(), rows = sh.getDataRange().getValues();
  for (let i = rows.length - 1; i >= 1; i--) if (String(rows[i][0]) === String(id)) { sh.deleteRow(i + 1); return { ok: true }; }
  return { ok: false, message: 'Not found.' };
}

/* ---------- networking lead form (meet.html): people we meet add their own details to the Outreach list ---------- */
function handleLeadSubmit(d, out) {
  const send = o => out.setContent(JSON.stringify(o));
  try {
    if (String(d.website || '').trim()) return send({ ok: true }); // spam bot: pretend OK
    const person = cleanText(d.name, 80), company = cleanText(d.company, 120), email = cleanText(d.email, 160), phone = cleanText(d.phone, 40);
    const sends = cleanText(d.sends, 300), event = cleanText(d.event, 60) || 'Networking';
    if (!person) return send({ ok: false, message: 'Please add your name.' });
    if (!validEmail(email)) return send({ ok: false, message: 'Please check your email address.' });
    if (!d.consent) return send({ ok: false, message: 'Please tick the box so we can contact you.' });
    const cache = CacheService.getScriptCache(), day = 'ld_' + Utilities.formatDate(new Date(), 'Europe/London', 'yyyyMMdd');
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const n = Number(cache.get(day) || '0');
      if (n >= 60) return send({ ok: false, message: 'Sorry, we cannot take more details today. Please email contact@prjlogistics.co.uk.' });
      cache.put(day, String(n + 1), 86400);
      const now = new Date(), stamp = Utilities.formatDate(now, 'Europe/London', 'd MMM yyyy');
      const note = ('Met at: ' + event + ' (' + stamp + '). Contact: ' + person + (sends ? '. Sends: ' + sends : '') + '. Agreed to be contacted via the form.').slice(0, 400);
      const sh = outreachSheet(), rows = sh.getDataRange().getValues(), list = rows.slice(1).filter(r => r[0]).map(outreachRow);
      const name = company || person;
      const dup = outreachDup(list, name, email, '');
      if (dup) {
        for (let i = 1; i < rows.length; i++) if (String(rows[i][0]) === dup.id) {
          const r = rows[i].slice(); while (r.length < 15) r.push('');
          if (!r[2]) r[2] = safeCell(email);
          if (!r[3] && phone) r[3] = safeCell(phone);
          r[11] = safeCell((note + (r[11] ? ' | ' + String(r[11]) : '')).slice(0, 400));
          if (['no', 'stop'].indexOf(String(r[7])) < 0) r[7] = 'todo';
          r[13] = now; r[14] = 'Lead form';
          sh.getRange(i + 1, 1, 1, 15).setValues([r.slice(0, 15)]);
          break;
        }
      } else {
        const id = Utilities.getUuid().replace(/-/g, '').slice(0, 10);
        sh.appendRow([id, safeCell(name), safeCell(email), safeCell(phone), 'Other', 'Networking',
          /\b(ltd|limited|llp|plc)\b/i.test(company) ? 'yes' : '', 'todo', '', '', '', safeCell(note), now, now, 'Lead form']);
      }
    } finally { lock.releaseLock(); }
    notifyPhones('New networking contact: ' + person + (company ? ' (' + company + ')' : '') + '. See the Outreach tab in the admin panel.');
    return send({ ok: true });
  } catch (e) { logError('Lead form failed: ' + e); return send({ ok: false, message: 'Sorry, that did not go through. Please try again.' }); }
}


/* ---------- branded footer for every customer email: logo + slogan ----------
   The logo is stored inside the script (small PNG) and sent as an inline picture, so it shows even when the
   customer's mail app blocks remote images. */
const EMAIL_SLOGAN = 'Local. Reliable. Professional.';
// legally required company details (Companies Act trading disclosures) - shown in small print in every email
const COMPANY_LEGAL = COMPANY + ' · Registered in England and Wales, company number 14005786 · Registered office: 38 Ormonde Road, Wokingham, England, RG41 2RB';
// The whole dark band (background, logo, slogan) is ONE picture: phones in dark mode recolour backgrounds and text, but never pictures.
const EMAIL_LOGO_B64 = 'iVBORw0KGgoAAAANSUhEUgAABGAAAAE7CAMAAACloQcIAAABgFBMVEUDCxd2tir7+/wJEhuZp7oAAABplyZ7sRV2qhNteYoRGSUyO0gkKzaNmasVIxt5hZZslB7HyMs8RVLW19no6OpupyhOV2UbIy4sMzlka3WCthpDS1ZaZHFHaSRNeCRWhiWnqq60trk2ViAsRx6ItylwdHqFipFNU1oiOR2RlJnd3uBojh5ohi+StEYdMhw9YSFdkSeAjaCDqS+7vcE1Rim+wcNjboCQwSpEWije4OGaw0dxi0RkeEhheTi61IjK1rkECSBUZUF5kU6JqkSYpoOcumKKwR6quY65zJa8y6HX4Mvh7scAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC9mY7nAAAAgHRSTlP//////wD/////////////////////////////////////////////////////////////////////////////////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJq6YHoAACAtSURBVHja7Z0JY9q4uoYJZgh4CQEbGwpJIAkQcjudtmnn3DnLPXdf////uZJXyRZgKKSkfZ4zJzVePkmAXj592hq/GGgAAOyJUUsQFwA4lcg0kBcAOJXENJAXADiVxDTQFwA4lcI0kBcAOJXENNAXADiVwjTQFwA4lcI00BcAOJXCNNAXADiVwiAwAHBageG9AIBTKEwDfQGAUykMAgMApxQY3gcAOI3CIDAAcEKB4V0AgBMpDAIDAAgMACAwAACFwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMCPgHWGlgDgaPXSjq5OgO3uxhbslAbbGY1GO01Ftm0dLDPuKNKtjWy+FwDHEZi//mv76Azb/97fzXw2a/XGE9eS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';
function brandFooterHtml() {
  // The dark band is a single picture, so it looks the same in light and dark mode on every phone.
  // Contact details and company details are normal text under it, so they stay clickable and readable.
  const link = 'color:#5C7F1E;text-decoration:underline';
  return '<div style="margin-top:28px;max-width:560px;font-family:Arial,sans-serif">' +
    '<img src="cid:prjlogo" width="560" alt="' + esc(COMPANY) + ' - ' + esc(EMAIL_SLOGAN) + '" style="display:block;border:0;outline:none;width:100%;max-width:560px;height:auto">' +
    '<div style="font-size:12px;line-height:1.6;margin-top:8px">' +
    '<a href="tel:' + PHONE.replace(/\s/g, '') + '" style="' + link + '">' + esc(PHONE) + '</a> &middot; ' +
    '<a href="mailto:' + OWNER_EMAIL + '" style="' + link + '">' + OWNER_EMAIL + '</a> &middot; ' +
    '<a href="https://www.prjlogistics.co.uk" style="' + link + '">prjlogistics.co.uk</a></div>' +
    '<div style="color:#8A94A3;font-size:11px;line-height:1.5;margin-top:4px">' + esc(COMPANY_LEGAL) + '</div>' +
    '</div>';
}
function withBrandFooter(o) {
  if (!o || !o.htmlBody) return o;
  const c = Object.assign({}, o);
  c.htmlBody = String(o.htmlBody) + brandFooterHtml();
  c.inlineImages = Object.assign({}, o.inlineImages || {}, { prjlogo: Utilities.newBlob(Utilities.base64Decode(EMAIL_LOGO_B64), 'image/png', 'prj-logistics.png') });
  c.body = String(o.body || '') + '\n\n' + COMPANY + ' - ' + EMAIL_SLOGAN + '\n' + COMPANY_LEGAL;
  return c;
}


/* ---------- busy times: confirmed jobs block collection times on the website ----------
   A confirmed job (Booked or Collected) keeps one van busy from its collection time for:
   drive collection -> delivery + drive back to Reading + BUSY_BUFFER_MIN for loading and unloading.
   The minutes are saved in column AN ("Busy (min)"). A time is shown as fully booked when CAPACITY vans are busy. */
const CAPACITY = 2;            // vans that can work at the same time
const BUSY_BUFFER_MIN = 30;    // loading + unloading
const BUSY_DEFAULT_MIN = 180;  // used when the route cannot be worked out
const BUSY_COL = 40;           // column AN

/* collection time of a job as a Date, or null when it has no clock time (e.g. "As soon as possible") */
function whenStart(whenText, created) {
  const day = jobDay(whenText, created);
  if (!day) return null;
  const hm = /(\d{1,2}):(\d{2})/.exec(String(whenText || '').replace(/\d{4}-\d{2}-\d{2}/, ''));
  if (!hm) return null;
  const z = n => ('0' + n).slice(-2);
  let off = Utilities.formatDate(new Date(day + 'T12:00:00Z'), 'Europe/London', 'XXX');
  if (off === 'Z') off = '+00:00';
  const d = new Date(day + 'T' + z(+hm[1]) + ':' + hm[2] + ':00' + off);
  return isNaN(d.getTime()) ? null : d;
}
let LAST_ROUTE_MILES = 0;   // road miles of the last job worked out by busyMinutesFor (saved in column Q "Miles")
function busyMinutesFor(r) {
  LAST_ROUTE_MILES = 0;
  try {
    const ga = geocodeUK(r[8]), gb = geocodeUK(r[9]);
    if (!ga || !gb) return BUSY_DEFAULT_MIN;
    const there = routeMiles(ga.p, gb.p, r[13]), back = routeMiles(gb.p, LOCAL_CENTRES[0], '');
    LAST_ROUTE_MILES = there.miles || 0;
    if (!there.mins || !back.mins) return BUSY_DEFAULT_MIN;
    return Math.round(there.mins + back.mins + BUSY_BUFFER_MIN);
  } catch (e) { return BUSY_DEFAULT_MIN; }
}
function ensureBusy(sh, row, r, force) {
  if (!force && Number(r[BUSY_COL - 1]) > 0) return Number(r[BUSY_COL - 1]);
  if (!sh.getRange(1, BUSY_COL).getValue()) sh.getRange(1, BUSY_COL).setValue('Busy (min)');
  const m = busyMinutesFor(r);
  sh.getRange(row, BUSY_COL).setValue(m);
  if (!(Number(r[16]) > 0) && LAST_ROUTE_MILES > 0) sh.getRange(row, 17).setValue(Math.round(LAST_ROUTE_MILES));   // miles, for local / long
  return m;
}
function busyCacheKeys() {
  const keys = [];
  for (let i = -1; i < 60; i++) keys.push('busy_' + Utilities.formatDate(new Date(Date.now() + i * 86400000), 'Europe/London', 'yyyy-MM-dd'));
  return keys;
}
/* ---------- two drivers: time off, clashes, a notification to the driver who gets the job ----------
   Time off is saved in the settings as a list: {id, driver, date 'yyyy-MM-dd', from 'HH:mm' or '', to 'HH:mm' or '', note}.
   No times = the whole day. While a driver is off, one van fewer is free, so the website shows fewer collection times. */
function timeOffList() {
  let l = [];
  try { l = JSON.parse(props().getProperty('time_off') || '[]'); } catch (e) {}
  const today = Utilities.formatDate(new Date(), 'Europe/London', 'yyyy-MM-dd');
  return (Array.isArray(l) ? l : []).filter(x => x && x.date >= today).sort((a, b) => (a.date + (a.from || '')).localeCompare(b.date + (b.from || '')));
}
function timeOffSave(d, by) {
  const drivers = Object.keys(USERS).map(u => String(USERS[u].name));
  const driver = cleanText(d.driver, 60), date = String(d.date || ''), from = String(d.from || ''), to = String(d.to || '');
  if (drivers.indexOf(driver) < 0) return { ok: false, message: 'Choose who is off.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, message: 'Choose the date.' };
  if ((from || to) && !(/^\d{2}:\d{2}$/.test(from) && /^\d{2}:\d{2}$/.test(to) && from < to)) return { ok: false, message: 'Check the times (from must be before to), or leave both empty for the whole day.' };
  const days = Math.min(31, Math.max(1, Number(d.days) || 1)), l = timeOffList(), z = n => ('0' + n).slice(-2), keys = [];
  for (let k = 0; k < days; k++) {
    const dt = new Date(date + 'T12:00:00Z'); dt.setUTCDate(dt.getUTCDate() + k);
    const ds = dt.getUTCFullYear() + '-' + z(dt.getUTCMonth() + 1) + '-' + z(dt.getUTCDate());
    keys.push('busy_' + ds);
    l.push({ id: Utilities.getUuid().replace(/-/g, '').slice(0, 8), driver: driver, date: ds, from: from, to: to, note: cleanText(d.note, 80), by: by || '' });
  }
  props().setProperty('time_off', JSON.stringify(l.slice(-200)));
  try { CacheService.getScriptCache().removeAll(busyCacheKeys().concat(keys)); } catch (e) {}
  return { ok: true, timeOff: timeOffList() };
}
function timeOffDelete(id) {
  const all = timeOffList(), gone = all.find(x => x.id === String(id));
  props().setProperty('time_off', JSON.stringify(all.filter(x => x.id !== String(id))));
  try { CacheService.getScriptCache().removeAll(busyCacheKeys().concat(gone ? ['busy_' + gone.date] : [])); } catch (e) {}
  return { ok: true, timeOff: timeOffList() };
}
/* a time-off entry as [start, end] in ms */
function timeOffSpan(x) {
  let off = Utilities.formatDate(new Date(x.date + 'T12:00:00Z'), 'Europe/London', 'XXX'); if (off === 'Z') off = '+00:00';
  const a = new Date(x.date + 'T' + (x.from || '00:00') + ':00' + off).getTime(), b = x.to ? new Date(x.date + 'T' + x.to + ':00' + off).getTime() : a + 86400000;
  return [a, b];
}
function timeOffText(x) { return x.from ? x.from + '–' + x.to : 'all day'; }
/* Is this driver free for this job? Returns '' when free, or a short reason (another job at that time, or time off). */
function driverClash(sh, row, driver, whenText) {
  if (!driver) return '';
  const rows = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), Math.min(BUSY_COL, sh.getMaxColumns())).getValues();
  const me = rows[row - 1] || [];
  const s = whenStart(whenText, me[2]);
  const nice = t => Utilities.formatDate(new Date(t), 'Europe/London', 'HH:mm');
  if (!s) {   // no clock time: only time off for the whole day can be checked
    const day = jobDay(whenText, me[2]), off = day ? timeOffList().find(x => x.driver === driver && x.date === day && !x.from) : null;
    return off ? driver + ' is off that day' + (off.note ? ' (' + off.note + ')' : '') + '.' : '';
  }
  let mins = Number(me[BUSY_COL - 1]);
  if (!(mins > 0)) { const r = me.slice(); while (r.length < BUSY_COL) r.push(''); r[13] = whenText; mins = busyMinutesFor(r); }
  const a = s.getTime(), b = a + mins * 60000;
  let computed = 0;
  for (const x of timeOffList()) {
    if (x.driver !== driver) continue;
    const sp = timeOffSpan(x);
    if (sp[0] < b && a < sp[1]) return driver + ' is off on ' + Utilities.formatDate(new Date(sp[0]), 'Europe/London', 'EEE d MMM') + ' (' + timeOffText(x) + (x.note ? ', ' + x.note : '') + ').';
  }
  for (let i = 1; i < rows.length; i++) {
    if (i === row - 1) continue;
    const r = rows[i], st = String(r[1]).trim();
    if ((st !== 'Booked' && st !== 'Collected') || cleanText(r[10], 60) !== driver) continue;
    const s2 = whenStart(r[13], r[2]);
    if (!s2) continue;
    let m2 = Number(r[BUSY_COL - 1]);
    if (!(m2 > 0)) { if (computed < 3) { const rr = r.slice(); while (rr.length < BUSY_COL) rr.push(''); m2 = ensureBusy(sh, i + 1, rr, true); computed++; } else m2 = BUSY_DEFAULT_MIN; }
    const a2 = s2.getTime(), b2 = a2 + m2 * 60000;
    if (a2 < b && a < b2) return driver + ' already has ' + String(r[0]).trim() + ' from ' + nice(a2) + ' until about ' + nice(b2) + ' (' + cleanText(r[8], 60) + ' → ' + cleanText(r[9], 60) + '). This job needs him ' + nice(a) + '–' + nice(b) + '.';
  }
  return '';
}
/* ---------- local and long jobs: one driver does the local work, the other the long trips ----------
   A job is "long" when the route from collection to delivery is more than LOCAL_MAX_MILES.
   Day roles (Plan tab): for each day, each driver can be set to Local, Long or Any. */
const LOCAL_MAX_MILES = 30;
function dayRolesAll() {
  let o = {};
  try { o = JSON.parse(props().getProperty('day_roles') || '{}') || {}; } catch (e) {}
  const today = Utilities.formatDate(new Date(), 'Europe/London', 'yyyy-MM-dd'), out = {};
  Object.keys(o).forEach(d => { if (d >= today) out[d] = o[d]; });
  return out;
}
function dayRoleSave(d) {
  const drivers = Object.keys(USERS).map(u => String(USERS[u].name)), date = String(d.date || ''), driver = cleanText(d.driver, 60), role = String(d.role || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || drivers.indexOf(driver) < 0 || ['', 'local', 'long'].indexOf(role) < 0) return { ok: false, message: 'Choose the day, the driver and the role.' };
  const all = dayRolesAll(), day = all[date] || {};
  if (role) day[driver] = role; else delete day[driver];
  if (Object.keys(day).length) all[date] = day; else delete all[date];
  props().setProperty('day_roles', JSON.stringify(all));
  return { ok: true, dayRoles: all };
}
/* road miles of a job (column Q); worked out and saved when missing */
function jobMilesFor(sh, row, r) {
  const have = Number(r[16]);
  if (have > 0) return have;
  try {
    const ga = geocodeUK(r[8]), gb = geocodeUK(r[9]);
    if (!ga || !gb) return 0;
    const rt = osrmRoute(ga.p, gb.p) || routeMiles(ga.p, gb.p, '');
    const mi = Math.round(rt.miles || 0);
    if (mi > 0) sh.getRange(row, 17).setValue(mi);
    return mi;
  } catch (e) { return 0; }
}
/* warnings about local / long work for this driver and this job ('' = fine) */
function roleWarnings(sh, row, driver, whenText) {
  const r = rowValues(sh, row, BUSY_COL), day = jobDay(whenText, r[2]);
  if (!driver || !day) return '';
  const mi = jobMilesFor(sh, row, r);
  if (!mi) return '';
  const long = mi > LOCAL_MAX_MILES, out = [], role = (dayRolesAll()[day] || {})[driver];
  const dayName = Utilities.formatDate(new Date(day + 'T12:00:00Z'), 'Europe/London', 'EEE d MMM');
  if (role === 'local' && long) out.push(driver + ' does the local jobs on ' + dayName + ', and this is a long trip (' + mi + ' miles).');
  if (role === 'long' && !long) out.push(driver + ' does the long trips on ' + dayName + ', and this is a local job (' + mi + ' miles).');
  if (long) {   // both vans away on long trips at the same time = nobody left for local work
    const s = whenStart(whenText, r[2]);
    if (s) {
      const mins = Number(r[BUSY_COL - 1]) > 0 ? Number(r[BUSY_COL - 1]) : BUSY_DEFAULT_MIN, a = s.getTime(), b = a + mins * 60000;
      const rows = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), Math.min(BUSY_COL, sh.getMaxColumns())).getValues();
      const nice = t => Utilities.formatDate(new Date(t), 'Europe/London', 'HH:mm');
      for (let i = 1; i < rows.length; i++) {
        if (i === row - 1) continue;
        const x = rows[i], st = String(x[1]).trim(), dr = cleanText(x[10], 60);
        if ((st !== 'Booked' && st !== 'Collected') || !dr || dr === driver || !(Number(x[16]) > LOCAL_MAX_MILES)) continue;
        const s2 = whenStart(x[13], x[2]);
        if (!s2) continue;
        const a2 = s2.getTime(), b2 = a2 + (Number(x[BUSY_COL - 1]) > 0 ? Number(x[BUSY_COL - 1]) : BUSY_DEFAULT_MIN) * 60000;
        if (a2 < b && a < b2) { out.push('Both vans would be away on long trips at the same time: ' + dr + ' has ' + String(x[0]).trim() + ' (' + Number(x[16]) + ' miles, ' + nice(a2) + '–' + nice(b2) + '). Nobody would be left for local jobs.'); break; }
      }
    }
  }
  return out.join(' ');
}

/* ---------- card payments with Stripe ----------
   The secret key is kept in Cloudflare (Settings > Variables > STRIPE_SECRET_KEY, type Secret); never in this code.
   "Pay" in the booking email opens quote.html?pay=1, which asks pay_start for a Stripe Checkout page for the exact price.
   Stripe then calls /stripe-webhook (signed with STRIPE_WEBHOOK_SECRET) and the job is marked Paid automatically. */
function stripeKey() {
  return String(props().getProperty('stripe_key') || '');   // replaced on the Cloudflare server (reads the secret)
}
function stripeVerifiedEvent() {
  return null;   // replaced on the Cloudflare server: the Stripe event, only after its signature was checked
}
function stripePayStart(d) {
  const ref = String(d.ref || '').trim().toUpperCase(), token = String(d.t || '').trim().toLowerCase();
  const key = stripeKey();
  if (!key) return { ok: false, message: 'Card payment is not available online yet. Please call us on ' + PHONE + '.' };
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME), row = findDetailsRow(sh, ref, token);
  if (!row) return { ok: false, message: 'This payment link is no longer valid. Please contact us.' };
  const r = rowValues(sh, row, 29), st = String(r[1]).trim(), payState = String(r[26] || '');
  if (payState === 'Paid') return { ok: true, paid: true, ref: ref };
  if (/^(Invoice|Refunded)/.test(payState)) return { ok: false, message: 'This booking does not need a card payment. Questions? Call us on ' + PHONE + '.' };
  if (['Booked', 'Collected', 'Delivered'].indexOf(st) < 0) return { ok: false, message: 'We have not confirmed this booking yet. You will get the payment link in the confirmation email.' };
  const amount = Math.round(Number(String(r[18]).replace(/[^0-9.]/g, '')) * 100);
  if (!(amount >= 100)) return { ok: false, message: 'The price is not set yet. Please contact us.' };
  const short = a => cleanText(a, 200).split(',').slice(-2).join(',').trim();
  const res = UrlFetchApp.fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'post', headers: { Authorization: 'Bearer ' + key }, muteHttpExceptions: true,
    payload: {
      mode: 'payment', 'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'gbp',
      'line_items[0][price_data][unit_amount]': String(amount),
      'line_items[0][price_data][product_data][name]': 'Delivery ' + ref + ' (' + short(r[8]) + ' to ' + short(r[9]) + ')',
      client_reference_id: ref, 'metadata[ref]': ref, 'payment_intent_data[metadata][ref]': ref,
      customer_email: validEmail(String(r[4]).trim()) ? String(r[4]).trim() : '',
      success_url: SITE_URL + '/track.html?ref=' + encodeURIComponent(ref) + '&paid=1',
      cancel_url: SITE_URL + '/quote.html?pay=1&ref=' + encodeURIComponent(ref) + '&t=' + encodeURIComponent(token) + '&back=1'
    }
  });
  let j = {};
  try { j = JSON.parse(res.getContentText()); } catch (e) {}
  if (res.getResponseCode() !== 200 || !/^https:\/\/checkout\.stripe\.com\//.test(String(j.url || ''))) {
    logError('Stripe checkout failed for ' + ref + ' (' + res.getResponseCode() + '): ' + String(res.getContentText()).slice(0, 200));
    return { ok: false, message: 'Sorry, the card payment page could not be opened. Please try again in a minute or call us on ' + PHONE + '.' };
  }
  return { ok: true, url: j.url, price: priceText(amount / 100), ref: ref };
}
/* Stripe says a payment went through: mark the job Paid and tell the office */
function stripeEventHandle() {
  const ev = stripeVerifiedEvent();
  if (!ev) return { ok: false };
  if (ev.type !== 'checkout.session.completed' && ev.type !== 'checkout.session.async_payment_succeeded') return { ok: true, ignored: true };
  const o = (ev.data && ev.data.object) || {};
  if (o.payment_status !== 'paid') return { ok: true, ignored: true };
  const ref = String((o.metadata && o.metadata.ref) || o.client_reference_id || '').trim().toUpperCase();
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME), row = findJobRow(sh, ref);
  if (!row) { logError('Stripe payment for an unknown job: ' + ref); return { ok: true }; }
  const r = rowValues(sh, row, 27);
  if (String(r[26]) === 'Paid') return { ok: true, already: true };
  ensurePayHeaders(sh);
  sh.getRange(row, 27).setValue('Paid');
  try { syncInvoicePaid(sh, String(r[0]).trim()); } catch (e) {}
  sh.getRange(row, 3).setValue(new Date());
  const paid = priceText(Number(o.amount_total || 0) / 100), expected = cleanText(r[18], 40);
  try { logUpload(ref, 'Paid by card (Stripe) ' + paid + (o.payment_intent ? ' ' + o.payment_intent : ''), 'Stripe', 0); } catch (e) {}
  notifyPhones('\uD83D\uDCB7 ' + ref + ' paid by card: ' + paid + '\n' + cleanText(r[11], 100) + (expected && expected !== paid ? '\nNote: the job price is ' + expected : ''));
  return { ok: true, paid: true };
}

/* a phone notification only for the driver who got the job (on the new server; does nothing on Google) */
function pushTo(driver, title, body) {
  return 0;   // replaced on the Cloudflare server
}

/* website asks: which collection times on this date are fully booked? -> { ok, blocked: [['08:00','11:15'], ...] } */
function handleBusy(d, out) {
  const send = o => out.setContent(JSON.stringify(o));
  try {
    const date = String(d.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return send({ ok: false });
    const cache = CacheService.getScriptCache(), ck = 'busy_' + date, hit = cache.get(ck);
    if (hit) return out.setContent(hit);
    const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
    const rows = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), Math.min(BUSY_COL, sh.getMaxColumns())).getValues();
    const z = n => ('0' + n).slice(-2), tz = 'Europe/London';
    let off = Utilities.formatDate(new Date(date + 'T12:00:00Z'), tz, 'XXX'); if (off === 'Z') off = '+00:00';
    const dayStart = new Date(date + 'T00:00:00' + off).getTime(), dayEnd = dayStart + 86400000;
    const ev = []; let computed = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i], st = String(r[1]).trim();
      if (st !== 'Booked' && st !== 'Collected') continue;
      const s = whenStart(r[13], r[2]);
      if (!s || s.getTime() >= dayEnd || s.getTime() < dayStart - 86400000) continue;
      let mins = Number(r[BUSY_COL - 1]);
      if (!(mins > 0)) { if (computed < 5) { while (r.length < BUSY_COL) r.push(''); mins = ensureBusy(sh, i + 1, r, true); computed++; } else mins = BUSY_DEFAULT_MIN; }
      const a = s.getTime(), b = a + mins * 60000;
      if (b <= dayStart) continue;
      ev.push([Math.max(a, dayStart), 1], [Math.min(b, dayEnd), -1]);
    }
    timeOffList().forEach(x => {   // a driver who is off = one van fewer
      const sp = timeOffSpan(x);
      if (sp[1] <= dayStart || sp[0] >= dayEnd) return;
      ev.push([Math.max(sp[0], dayStart), 1], [Math.min(sp[1], dayEnd), -1]);
    });
    ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const blocked = []; let n = 0, from = null;
    ev.forEach(e => {
      n += e[1];
      if (n >= CAPACITY && from === null) from = e[0];
      if (n < CAPACITY && from !== null) { if (e[0] > from) blocked.push([from, e[0]]); from = null; }
    });
    const hm = t => Utilities.formatDate(new Date(t), tz, 'HH:mm');
    const res = JSON.stringify({ ok: true, date: date, blocked: blocked.map(b => [hm(b[0]), b[1] >= dayEnd ? '24:00' : hm(b[1])]) });
    cache.put(ck, res, 300);
    return out.setContent(res);
  } catch (e) { logError('Busy times failed: ' + e); return send({ ok: true, blocked: [] }); }
}


/* ---------- "On my way": the driver taps it in the driver app when setting off to the collection ----------
   Saves the time in column AO ("On the way"), assigns the job to that driver if nobody has it yet,
   emails the customer (ONWAY_EMAIL) and sends a phone notification. Used as proof for the cancellation terms. */
const ONWAY_COL = 41;        // column AO
const ONWAY_EMAIL = true;    // set to false if customers should not get the "driver is on the way" email
function onWayText(v) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? '' : Utilities.formatDate(d, 'Europe/London', 'd MMM, HH:mm');
}
function handleOnWay(d, out) {
  const send = o => out.setContent(JSON.stringify(o));
  try {
    const auth = checkKey(d);
    if (!auth.ok) return send({ ok: false, message: auth.message });
    const ref = String(d.ref || '').trim().toUpperCase();
    const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    let r, row = 0;
    try {
      const refs = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
      for (let i = 1; i < refs.length; i++) if (String(refs[i][0]).trim().toUpperCase() === ref) { row = i + 1; break; }
      if (!row) return send({ ok: false, message: 'Job not found.' });
      r = rowValues(sh, row, ONWAY_COL);
      const st = String(r[1]).trim(), drv = cleanText(r[10], 60);
      if (st !== 'Booked') return send({ ok: false, message: st === 'Collected' ? 'This job is already collected.' : 'Only confirmed (Booked) jobs can be started.' });
      if (drv && drv !== auth.name) return send({ ok: false, message: 'This job belongs to ' + drv + '.' });
      if (r[ONWAY_COL - 1]) return send({ ok: true, onway: onWayText(r[ONWAY_COL - 1]), already: true });
      if (!sh.getRange(1, ONWAY_COL).getValue()) sh.getRange(1, ONWAY_COL).setValue('On the way');
      const now = new Date();
      sh.getRange(row, ONWAY_COL).setValue(now);
      sh.getRange(row, 3).setValue(now);
      if (!drv) sh.getRange(row, 11).setValue(auth.name);
      r[ONWAY_COL - 1] = now;
    } finally { lock.releaseLock(); }
    try { logUpload(ref, 'On the way', auth.name, 0); } catch (e) {}
    notifyPhones('🚐 ' + auth.name + ' is on the way to collect ' + ref + '\n' + cleanText(r[8], 200));
    const email = cleanText(r[4], 120);
    const business = String(r[27]) === 'Business' || /^Invoice/.test(String(r[26] || ''));   // business customers only hear at collection and delivery
    if (ONWAY_EMAIL && !business && validEmail(email)) {
      try { sendOnWayMail(ref, cleanText(r[11], 100), email, cleanText(r[8], 200), auth.name); } catch (e) { logError('On-the-way email failed for ' + ref + ': ' + e); }
    }
    return send({ ok: true, onway: onWayText(r[ONWAY_COL - 1]) });
  } catch (err) {
    logError('On my way failed: ' + err);
    return send({ ok: false, message: 'Could not save. Try again.' });
  }
}
function sendOnWayMail(ref, name, email, from, driver) {
  const first = String(name).split(' ')[0] || 'there';
  const link = SITE_URL + '/track.html?ref=' + encodeURIComponent(ref);
  const html =
    '<div style="font-family:Arial,sans-serif;font-size:15px;color:#0E1726;max-width:560px">' +
    '<h2 style="margin:0 0 8px">Your driver is on the way</h2>' +
    '<p>Hello ' + esc(first) + ',</p>' +
    '<p>' + esc(driver) + ' from ' + esc(COMPANY) + ' is now on the way to collect your load for booking <b>' + esc(ref) + '</b>.</p>' +
    '<p><b>Collect from:</b> ' + esc(from) + '</p>' +
    '<p>Please make sure the load is ready and someone is there to hand it over.</p>' +
    '<p><a href="' + esc(link) + '">Track your delivery</a></p>' +
    '<p>Questions? Reply to this email or call us on ' + esc(PHONE) + '.</p>' +
    '<p>Kind regards,<br>' + esc(COMPANY) + '</p></div>';
  sendCustomerMail({ to: email, subject: 'Your driver is on the way (' + ref + ')', htmlBody: html,
    body: driver + ' from ' + COMPANY + ' is on the way to collect your load (' + ref + ') from ' + from + '. Track: ' + link, replyTo: OWNER_EMAIL, name: COMPANY });
}


/* ---------- "Arrived": the driver taps it on arrival ----------
   Booked job: arrived at the collection address (column AP). Collected job: arrived at the delivery address (column AQ).
   Proof of arrival time for the cancellation terms and for waiting time. The office gets a phone notification; no customer email. */
const ARRIVED_C_COL = 42;    // column AP
const ARRIVED_D_COL = 43;    // column AQ
const DONE_C_COL = 44;       // column AR: when the job was marked Collected (ends the waiting time at the collection)
const DONE_D_COL = 45;       // column AS: when the job was marked Delivered (ends the waiting time at the delivery)
function isoOf(v) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}
/* stamps the moment a job became Collected / Delivered (only the first time) */
function markDone(sh, row, st, at) {
  // "at" = when the driver pressed Send on the phone (photos may be uploaded later when there was no signal)
  let when = new Date();
  const t = at ? new Date(at) : null;
  if (t && !isNaN(t.getTime()) && t.getTime() <= when.getTime() + 5 * 60000 && t.getTime() > when.getTime() - 24 * 3600000) when = t;
  const col = st === 'Collected' ? DONE_C_COL : st === 'Delivered' ? DONE_D_COL : 0;
  if (!col) return;
  try {
    if (!sh.getRange(1, DONE_C_COL).getValue()) sh.getRange(1, DONE_C_COL, 1, 2).setValues([['Collected at', 'Delivered at']]);
    if (!sh.getRange(row, col).getValue()) sh.getRange(row, col).setValue(when);
  } catch (e) { logError('Done time: ' + e); }
}
function handleArrived(d, out) {
  const send = o => out.setContent(JSON.stringify(o));
  try {
    const auth = checkKey(d);
    if (!auth.ok) return send({ ok: false, message: auth.message });
    const ref = String(d.ref || '').trim().toUpperCase();
    const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    let r, row = 0, col = 0, where = '';
    try {
      const refs = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
      for (let i = 1; i < refs.length; i++) if (String(refs[i][0]).trim().toUpperCase() === ref) { row = i + 1; break; }
      if (!row) return send({ ok: false, message: 'Job not found.' });
      r = rowValues(sh, row, ARRIVED_D_COL);
      const st = String(r[1]).trim(), drv = cleanText(r[10], 60);
      if (st === 'Booked') { col = ARRIVED_C_COL; where = 'collection'; }
      else if (st === 'Collected') { col = ARRIVED_D_COL; where = 'delivery'; }
      else return send({ ok: false, message: 'This job is not in progress.' });
      if (drv && drv !== auth.name) return send({ ok: false, message: 'This job belongs to ' + drv + '.' });
      if (r[col - 1]) return send({ ok: true, where: where, arrived: onWayText(r[col - 1]), at: isoOf(r[col - 1]), already: true });
      if (!sh.getRange(1, ARRIVED_C_COL).getValue()) sh.getRange(1, ARRIVED_C_COL, 1, 2).setValues([['Arrived (collection)', 'Arrived (delivery)']]);
      const now = new Date();
      sh.getRange(row, col).setValue(now);
      sh.getRange(row, 3).setValue(now);
      if (!drv) sh.getRange(row, 11).setValue(auth.name);
      if (where === 'collection' && !r[ONWAY_COL - 1]) sh.getRange(row, ONWAY_COL).setValue(now); // arrived without tapping "On my way"
      r[col - 1] = now;
    } finally { lock.releaseLock(); }
    try { logUpload(ref, 'Arrived at ' + where, auth.name, 0); } catch (e) {}
    notifyPhones('📍 ' + auth.name + ' arrived at the ' + where + ' address for ' + ref + '\n' + cleanText(where === 'collection' ? r[8] : r[9], 200));
    return send({ ok: true, where: where, arrived: onWayText(r[col - 1]), at: isoOf(r[col - 1]) });
  } catch (err) {
    logError('Arrived failed: ' + err);
    return send({ ok: false, message: 'Could not save. Try again.' });
  }
}
