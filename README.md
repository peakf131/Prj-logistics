# PRJ Logistics

Website, panels and server code for PRJ Logistics Ltd (same-day courier, Reading).

## Folders

- `site/` – everything that goes to IONOS (`public_html`). `htaccess.txt` is uploaded as `.htaccess`.
  - `index.html`, `quote.html`, `track.html`, … – public website
  - `admin.html` – admin panel (diary, invoices, spending)
  - `driver.html`, `client.html` – driver app and customer panel
  - `kalkulator.html` – private work calculator and tax ledger (login required)
  - `become-a-courier.html` – demo page, not linked from the site
- `worker/` – the server
  - `cloudflare-worker.js` – the built Cloudflare worker (`prj-api`), ready to deploy
  - `google-apps-script.gs` – the source the worker is built from
  - `build-tools-2026-10-29/` – build script, runtime and tests from 29 Oct 2026. Older than the current worker: they need bringing up to date before the worker can be rebuilt from source.

## Rules

- No keys or passwords in this repository. Stripe, ORS and other keys live in Cloudflare secrets.
- Passwords in `test.mjs` are made-up test values.
