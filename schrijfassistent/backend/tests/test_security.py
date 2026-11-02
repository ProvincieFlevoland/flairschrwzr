"""Unit tests for app/core/security.py.

They exercise the dependency through a minimal FastAPI app, with the shared httpx.AsyncClient
replaced by a fake Open WebUI, so no network and no storage are needed. The contract tests cover
the live path.
"""
from __future__ import annotations

import asyncio
import logging
import unittest
from typing import Any, Dict

import httpx
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.core import security
from app.core.config import settings


class _FakeResponse:
    def __init__(self, status_code: int, body: Any = None):
        self.status_code = status_code
        self._body = body

    def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


class _FakeClient:
    def __init__(self, owner):
        self.owner = owner

    async def get(self, url, headers=None):
        o = self.owner
        o.calls += 1
        o.active += 1
        o.max_active = max(o.max_active, o.active)
        try:
            await asyncio.sleep(o.delay)
            token = (headers or {}).get("Authorization", "")[7:]
            r = o.responses.get(token)
            if r is None:
                return _FakeResponse(401, {"detail": "Invalid token"})
            if isinstance(r, Exception):
                raise r
            return r
        finally:
            o.active -= 1


class SecurityTests(unittest.TestCase):
    def setUp(self):
        security.clear_cache()
        self.calls = 0
        self.active = 0
        self.max_active = 0
        self.delay = 0
        self.responses: Dict[str, Any] = {}
        self._orig_client = security._get_client
        self._orig = settings.OPENWEBUI_INTERNAL_URL
        settings.OPENWEBUI_INTERNAL_URL = "http://openwebui.test"
        fake = _FakeClient(self)
        security._get_client = lambda: fake
        app = FastAPI()

        @app.get("/whoami")
        async def whoami(user=Depends(security.get_current_user)):
            return user

        self.client = TestClient(app)

    def tearDown(self):
        security._get_client = self._orig_client
        settings.OPENWEBUI_INTERNAL_URL = self._orig
        security.clear_cache()

    def test_bearer_is_verified_and_cached(self):
        self.responses["tok"] = _FakeResponse(200, {"id": "u1", "email": "a@b", "name": "A", "role": "admin"})
        for _ in range(3):
            r = self.client.get("/whoami", headers={"Authorization": "Bearer tok"})
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.json(), {"id": "u1", "email": "a@b", "name": "A", "role": "admin", "auth": "openwebui"})
        self.assertEqual(self.calls, 1)  # positive result cached (60 s)

    def test_cookie_token_is_not_accepted(self):
        # bearer only. A valid Open WebUI token in the `token` cookie is ignored.
        self.responses["cookie-tok"] = _FakeResponse(200, {"id": "u2", "email": "", "name": "", "role": "user"})
        self.client.cookies.set("token", "cookie-tok")
        r = self.client.get("/whoami")
        self.client.cookies.clear()
        self.assertEqual(r.status_code, 401)
        self.assertEqual(self.calls, 0)

    def test_rejected_token_falls_through_and_is_negatively_cached(self):
        for _ in range(4):
            r = self.client.get("/whoami", headers={"Authorization": "Bearer unknown"})
            self.assertEqual(r.status_code, 401)
        self.assertEqual(self.calls, 1)  # 401 cached for NEGATIVE_TTL_SEC: one round trip per window

    def test_negative_entry_expires(self):
        self.client.get("/whoami", headers={"Authorization": "Bearer unknown"})
        key = security._token_key("unknown")
        security._cache[key] = (0.0, None)  # expired
        self.client.get("/whoami", headers={"Authorization": "Bearer unknown"})
        self.assertEqual(self.calls, 2)

    def test_openwebui_unreachable_is_401_and_negatively_cached(self):
        self.responses["tok"] = httpx.ConnectTimeout("timeout")
        for _ in range(3):
            r = self.client.get("/whoami", headers={"Authorization": "Bearer tok"})
            self.assertEqual(r.status_code, 401)
        self.assertEqual(self.calls, 1)

    def test_non_200_and_bad_body_are_no_user(self):
        self.responses["a"] = _FakeResponse(503, {})
        self.responses["b"] = _FakeResponse(200, ValueError("not json"))
        self.responses["c"] = _FakeResponse(200, {"no": "id"})
        for t in "abc":
            self.assertEqual(self.client.get("/whoami", headers={"Authorization": f"Bearer {t}"}).status_code, 401)

    def test_openwebui_connect_error_is_401(self):
        self.responses["tok"] = httpx.ConnectError("refused")
        r = self.client.get("/whoami", headers={"Authorization": "Bearer tok"})
        self.assertEqual(r.status_code, 401)

    def test_no_credentials_and_legacy_header_are_401_and_logged_as_denied(self):
        with self.assertLogs("app.core.security", level="INFO") as cm:
            self.assertEqual(self.client.get("/whoami").status_code, 401)
            self.assertEqual(self.client.get("/whoami", headers={"X-Access-Token": "anything"}).status_code, 401)
            self.assertEqual(self.client.get("/whoami", headers={"Authorization": "Basic abc"}).status_code, 401)
        self.assertEqual(sum("auth=denied" in m for m in cm.output), 3)
        self.assertEqual(self.calls, 0)

    def test_logs_never_contain_the_token(self):
        self.responses["secret-token-value"] = _FakeResponse(200, {"id": "u1", "email": "", "name": "", "role": "user"})
        with self.assertLogs("app.core.security", level="INFO") as cm:
            self.client.get("/whoami", headers={"Authorization": "Bearer secret-token-value"})
        self.assertNotIn("secret-token-value", "\n".join(cm.output))

    def test_verifications_do_not_block_each_other(self):
        """The dependency awaits; slow Open WebUI answers overlap instead of serialising."""
        self.delay = 0.3
        for i in range(3):
            self.responses[f"t{i}"] = _FakeResponse(200, {"id": f"u{i}", "email": "", "name": "", "role": "user"})

        async def run():
            transport = httpx.ASGITransport(app=self.client.app)
            async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
                return await asyncio.gather(
                    *[c.get("/whoami", headers={"Authorization": f"Bearer t{i}"}) for i in range(3)]
                )

        results = asyncio.run(run())
        self.assertTrue(all(r.status_code == 200 for r in results))
        self.assertEqual(self.max_active, 3)

    def test_lru_evicts_oldest_not_everything(self):
        orig = security.CACHE_MAX_ENTRIES
        security.CACHE_MAX_ENTRIES = 3
        try:
            for i in range(5):
                security._cache_store(f"k{i}", {"id": str(i)}, 60.0)
            self.assertEqual(list(security._cache), ["k2", "k3", "k4"])
            security._cache_lookup("k2")  # touch: k3 is now the oldest
            security._cache_store("k5", {"id": "5"}, 60.0)
            self.assertEqual(list(security._cache), ["k4", "k2", "k5"])
        finally:
            security.CACHE_MAX_ENTRIES = orig


if __name__ == "__main__":
    unittest.main()
