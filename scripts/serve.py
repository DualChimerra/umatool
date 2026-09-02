#!/usr/bin/env python3
"""Static server for `docs/`, with caching turned off.

`python -m http.server` sends no cache headers at all, which browsers read as
licence to keep an ES module in memory for the rest of the session. Editing a
file and reloading then shows the old one, which is a miserable way to develop
a site made of two dozen modules. This sends `no-store` and nothing else
changes.

    python scripts/serve.py [port] [--directory docs]
"""

import argparse
import functools
import http.server
import os
import socketserver


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.mjs': 'text/javascript',
        '.js': 'text/javascript',
        '.json': 'application/json',
        '.webp': 'image/webp',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()

    def log_message(self, fmt, *args):        # one line per request is plenty
        if '404' in (args[1] if len(args) > 1 else ''):
            super().log_message(fmt, *args)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('port', nargs='?', type=int, default=int(os.environ.get('PORT') or 8080))
    ap.add_argument('--directory', default=os.path.join(os.path.dirname(__file__), '..', 'docs'))
    args = ap.parse_args()

    root = os.path.abspath(args.directory)
    handler = functools.partial(NoCacheHandler, directory=root)

    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    with Server(('127.0.0.1', args.port), handler) as httpd:
        print(f'Serving {root} on http://localhost:{args.port}/  (no-store)')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
