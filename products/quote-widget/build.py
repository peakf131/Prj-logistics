#!/usr/bin/env python3
"""Builds dist/worker.js (Cloudflare worker, serves the widget and admin) and dist/widget.js."""
import json, pathlib
here = pathlib.Path(__file__).parent
src = lambda n: (here / 'src' / n).read_text(encoding='utf-8')
shared, widget, server, admin = src('shared.js'), src('widget.js'), src('server.js'), src('admin.html')
widget_js = '/* PRJ Instant Quote widget */\n(function(){\n' + shared + '\n' + widget + '\n})();\n'
worker_js = shared + '\n' + server.replace('__WIDGET_JS__', json.dumps(widget_js)).replace('__ADMIN_HTML__', json.dumps(admin))
(here / 'dist').mkdir(exist_ok=True)
(here / 'dist' / 'widget.js').write_text(widget_js, encoding='utf-8')
(here / 'dist' / 'worker.js').write_text(worker_js, encoding='utf-8')
print('widget.js', len(widget_js), 'bytes; worker.js', len(worker_js), 'bytes')

# sales page: on the PRJ website (widget from the server, offline demo if the server is not reachable) and a self-contained preview
import base64, re
logo = 'data:image/png;base64,' + base64.b64encode((here / 'src' / 'logo-white.png').read_bytes()).decode()
landing = src('landing.html').replace('__LOGO__', logo)
API = 'https://prj-quote.patryk-forgiel.workers.dev'
site_tag = '<script src="instant-quote-widget.js" data-tenant="demo" data-api="' + API + '" data-fallback="offline" data-name="Your Courier Co" data-colour="#2563EB" data-target="#iq-demo" async></script>'
head = '<!doctype html>\n<html lang="en-GB" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<link rel="canonical" href="https://www.prjlogistics.co.uk/instant-quote.html">\n'
page = landing.replace('__WIDGET_TAG__', site_tag)
t_end = page.index('</style>') + len('</style>')
(here / 'dist' / 'instant-quote.html').write_text(head + page[:t_end] + '\n</head><body>\n' + page[t_end:] + '\n</body></html>\n', encoding='utf-8')
(here / 'dist' / 'instant-quote-widget.js').write_text(widget_js, encoding='utf-8')
inline = '<script data-tenant="demo" data-mode="offline" data-name="Your Courier Co" data-colour="#2563EB" data-target="#iq-demo">' + widget_js.replace('</', '<\\/') + '</script>'
(here / 'dist' / 'preview.html').write_text(landing.replace('__WIDGET_TAG__', inline), encoding='utf-8')
print('landing pages built')
