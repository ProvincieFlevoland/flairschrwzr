#!/usr/bin/env python3
"""Stand-in for Open WebUI's token endpoint, for the contract and e2e tests and for local development without Open WebUI.

The backend's `get_current_user` (schrijfassistent/backend/app/core/security.py) forwards a bearer token to
`{OPENWEBUI_INTERNAL_URL}/api/v1/auths/` and expects the Open WebUI user object back (id, email, name, role, ...).
This server answers that one route from a token -> user table and answers 401 for every other token.

    python3 openwebui_auth_server.py --port 8012 [--tokens tokens.json] [--log calls.jsonl]

Token table: JSON object {token: {id, email, name, role}}. Default table:
    test-admin-token   -> {id: "u-admin", email: "admin@example.test", name: "Test Admin", role: "admin"}
    test-user-token    -> {id: "u-user",  email: "user@example.test",  name: "Test User",  role: "user"}
The environment variable OPENWEBUI_MOCK_TOKENS (a path) names a table file. Every call is appended to --log
(method, path, outcome, never the token itself), so a test can count the verification calls the backend makes.
Standard library only; the tokens are test values.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DEFAULT_TOKENS = {
    "test-admin-token": {"id": "u-admin", "email": "admin@example.test", "name": "Test Admin", "role": "admin"},
    "test-user-token": {"id": "u-user", "email": "user@example.test", "name": "Test User", "role": "user"},
}

TOKENS: dict = {}
LOG: Path | None = None


def _log(entry: dict) -> None:
    if LOG is None:
        return
    entry["ts"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


class Handler(BaseHTTPRequestHandler):
    server_version = "MockOpenWebUI/0.1"

    def log_message(self, fmt, *args):  # quiet; the jsonl log is the record
        sys.stderr.write("[openwebui-mock] " + (fmt % args) + "\n")

    def _send(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/health":
            return self._send(200, {"status": True})
        if path.rstrip("/") != "/api/v1/auths":
            _log({"method": "GET", "path": path, "outcome": "404"})
            return self._send(404, {"detail": "Not Found"})
        auth = self.headers.get("Authorization", "")
        token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        if not token:
            # Open WebUI also reads the `token` cookie; the backend only forwards a bearer.
            cookie = self.headers.get("Cookie", "")
            for part in cookie.split(";"):
                k, _, v = part.strip().partition("=")
                if k == "token":
                    token = v
        user = TOKENS.get(token)
        if user is None:
            _log({"method": "GET", "path": path, "outcome": "401"})
            return self._send(401, {"detail": "Invalid token"})
        _log({"method": "GET", "path": path, "outcome": "200", "user_id": user["id"]})
        body = {
            "id": user["id"],
            "email": user["email"],
            "name": user["name"],
            "role": user["role"],
            "profile_image_url": "/user.png",
            "token": token,
            "token_type": "Bearer",
            "expires_at": None,
            "permissions": {},
        }
        return self._send(200, body)


def main() -> int:
    global TOKENS, LOG
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8012)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--tokens", default=os.environ.get("OPENWEBUI_MOCK_TOKENS", ""))
    ap.add_argument("--log", default="")
    a = ap.parse_args()
    TOKENS = dict(DEFAULT_TOKENS)
    if a.tokens:
        TOKENS.update(json.loads(Path(a.tokens).read_text(encoding="utf-8")))
    LOG = Path(a.log) if a.log else None
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    sys.stderr.write(f"[openwebui-mock] listening on http://{a.host}:{a.port} tokens={sorted(TOKENS)}\n")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
