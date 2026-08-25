#!/usr/bin/env python3
"""Serve the site over real paths.

Two jobs in one file. Before the static build exists it stands in for it:
anything that is not a file on disk falls through to the single-page shell,
which routes on `location.pathname` — so `/leilao-de-imoveis/rio-de-janeiro-rj/
copacabana/` works locally exactly as it will once each of those is its own
file. After the build it serves `dist/` unchanged, and the fallback never
fires, which is itself the check: a request that reaches the shell is a page
the build forgot to write.

Run: .venv/bin/python -u experiments/brazil/serve.py [--root dist] [--port 8899]
"""

from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).parent


class Handler(SimpleHTTPRequestHandler):
    fallback: str = ""

    def send_head(self):
        path = Path(self.translate_path(self.path))
        missing = not path.exists() or (path.is_dir() and not (path / "index.html").exists())
        if missing and self.fallback:
            self.path = self.fallback
        return super().send_head()

    def end_headers(self):
        # A stale page during a rebuild looks exactly like a bug in the page.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "404" in fmt % args:
            super().log_message(fmt, *args)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(HERE / "site"))
    ap.add_argument("--port", type=int, default=8899)
    ap.add_argument(
        "--fallback",
        default="/v2/index.html",
        help="what an unknown path falls through to; empty for a plain static server",
    )
    a = ap.parse_args()

    Handler.fallback = a.fallback
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), partial(Handler, directory=a.root))
    print(f"{a.root} → http://127.0.0.1:{a.port}/  (fallback: {a.fallback or 'none'})", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
