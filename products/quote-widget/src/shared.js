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
