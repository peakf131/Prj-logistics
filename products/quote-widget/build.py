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

