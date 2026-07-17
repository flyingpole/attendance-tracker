#!/usr/bin/env python3
"""Local dev-only static file server that disables browser caching.

Plain `python -m http.server` lets Chrome cache .js/.html files without
revalidating, so edits can silently not show up on reload. This is only used
for local testing during development — the real deployment (GitHub Pages)
handles caching normally.
"""
import http.server
import sys
import os

class NoCacheHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    os.chdir(os.path.join(os.path.dirname(__file__), ".."))
    with http.server.ThreadingHTTPServer(("", port), NoCacheHTTPRequestHandler) as httpd:
        print(f"Serving (no-cache) on port {port}")
        httpd.serve_forever()
