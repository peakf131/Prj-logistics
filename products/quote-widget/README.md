# PRJ Instant Quote

An instant price and booking form that UK courier companies paste into their own website.
One Cloudflare worker serves every company; each company has its own price list.

## Files

- `src/` – source: `shared.js` (price formula), `server.js` (worker), `widget.js` (the form), `admin.html`, `landing.html` (sales page)
- `dist/worker.js` – paste into the Cloudflare worker `prj-quote`
- `dist/instant-quote.html` + `dist/instant-quote-widget.js` – sales page with a live demo, upload to IONOS
- `dist/preview.html` – the sales page with an offline demo (no server needed)
- `build.py` – rebuilds `dist/` from `src/`; `test.mjs` – server tests (`node test.mjs`)

## How a company adds it to their website

```html
<div data-prj-quote></div>
<script src="https://prj-quote.patryk-forgiel.workers.dev/widget.js" data-tenant="their-id" async></script>
```

## Set up (Cloudflare dashboard)

1. Workers & Pages → Create → Worker, name it `prj-quote`. Edit code, paste `dist/worker.js`, Deploy.
2. Storage & Databases → KV → Create namespace `prj-quote`. In the worker: Settings → Bindings → Add → KV namespace, variable name `QUOTE`.
3. Worker → Settings → Variables and Secrets:
   - `ADMIN_KEY` (secret): a long password you choose, at least 12 characters.
   - `RESEND_API_KEY` (secret): the same Resend key the prj-api worker uses.
   - `MAIL_FROM` (text): `quotes@prjlogistics.co.uk` (the domain must be verified in Resend).
   - `ORS_API_KEY` (secret, optional): openrouteservice key for routing.
4. Open `https://prj-quote.patryk-forgiel.workers.dev/admin`, sign in with the admin key, add companies.

## Before many companies use it

Address search (Photon), routes (OSRM demo server) and map tiles (OpenStreetMap) are free public services with fair-use rules.
They are fine for testing and the first customers. Before about 10 paying companies, switch routing to a paid or keyed service
(set `ORS_API_KEY`) and use a map tile provider with a commercial plan.
