#!/usr/bin/env python3
"""Builds the COSO website: dist/coso.html (+ coso-widget.js, images) for hosting, dist/preview.html (offline demo, one file)."""
import pathlib, shutil, re
here = pathlib.Path(__file__).parent
CONTACT = 'contact@prjlogistics.co.uk'            # change to hello@<coso domain> when the domain and mailbox exist
API = 'https://prj-quote.patryk-forgiel.workers.dev'
page = (here / 'src' / 'index.html').read_text(encoding='utf-8')
dark = (here / 'brand' / 'wordmark-dark.svg').read_text(encoding='utf-8')
dark = re.sub(r'\s+role="img"', ' role="img" focusable="false"', dark, count=1)
widget = (here.parent / 'quote-widget' / 'dist' / 'widget.js').read_text(encoding='utf-8')
attrs = 'data-tenant="demo" data-name="Your Courier Co" data-colour="#FFC20E" data-target="#iq-demo"'
page = page.replace('__LOGO_DARK__', dark).replace('__LOGO_DARK_SMALL__', dark).replace('__CONTACT__', CONTACT)
out = here / 'dist'; out.mkdir(exist_ok=True)
head = ('<!doctype html>\n<html lang="en-GB" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
        '<meta name="theme-color" content="#111111"><link rel="icon" type="image/png" sizes="32x32" href="coso-icon-32.png"><link rel="apple-touch-icon" href="coso-icon-180.png">\n'
        '<meta property="og:title" content="COSO Courier Solutions"><meta property="og:description" content="Software for UK courier companies, built by couriers."><meta property="og:image" content="https://www.prjlogistics.co.uk/coso-og.png">\n')
site = page.replace('__WIDGET_TAG__', '<script src="coso-widget.js" ' + attrs + ' data-api="' + API + '" data-fallback="offline" async></script>')
t = site.index('</style>') + len('</style>')
(out / 'coso.html').write_text(head + site[:t] + '\n</head><body>\n' + site[t:] + '\n</body></html>\n', encoding='utf-8')
(out / 'coso-widget.js').write_text(widget, encoding='utf-8')
for f in ['coso-icon-32.png', 'coso-icon-180.png', 'coso-icon-192.png', 'coso-icon-512.png', 'coso-og.png', 'coso-logo.png', 'coso-logo-dark.png']:
    shutil.copy(here / 'brand' / f, out / f)
inline = '<script ' + attrs + ' data-mode="offline">' + widget.replace('</', '<\\/') + '</script>'
(out / 'preview.html').write_text(page.replace('__WIDGET_TAG__', inline), encoding='utf-8')
print('built', [p.name for p in out.iterdir()])
