#!/usr/bin/env python3
"""Static server with caching disabled — browsers always revalidate modules."""
import os
from http.server import HTTPServer, SimpleHTTPRequestHandler


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, must-revalidate')
        super().end_headers()


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8123))
    HTTPServer(('', port), NoCacheHandler).serve_forever()
