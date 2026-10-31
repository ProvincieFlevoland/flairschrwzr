"""Unit tests of app/core/body_limit.py and of require_beheerder through minimal FastAPI apps."""
from __future__ import annotations

import unittest

from fastapi import Body, Depends, FastAPI
from fastapi.testclient import TestClient

from app.core import body_limit, security
from app.core.config import settings


def _app():
    app = FastAPI()
    app.add_middleware(body_limit.BodyLimitMiddleware)

    @app.post("/upload-configuration")
    def up(data: dict = Body(...)):
        return {"n": len(data)}

    @app.put("/notas/{nid}")
    def nota(nid: str, data: dict = Body(...)):
        return {"ok": True}

    @app.patch("/other")
    def other(data: dict = Body(...)):
        return {"ok": True}

    @app.get("/other")
    def get_other():
        return {"ok": True}

    return app


class BodyLimitTests(unittest.TestCase):
    def setUp(self):
        self.old = (settings.MAX_BODY_BYTES_DEFAULT, settings.MAX_BODY_BYTES_UPLOAD_CONFIGURATION, settings.MAX_BODY_BYTES_NOTA)
        settings.MAX_BODY_BYTES_DEFAULT = 1000
        settings.MAX_BODY_BYTES_UPLOAD_CONFIGURATION = 5000
        settings.MAX_BODY_BYTES_NOTA = 3000
        self.c = TestClient(_app())

    def tearDown(self):
        (settings.MAX_BODY_BYTES_DEFAULT, settings.MAX_BODY_BYTES_UPLOAD_CONFIGURATION, settings.MAX_BODY_BYTES_NOTA) = self.old

    def body(self, n):
        return b'{"a":"' + b"x" * n + b'"}'

    def test_limits_per_route(self):
        self.assertEqual(self.c.post("/upload-configuration", content=self.body(4000), headers={"content-type": "application/json"}).status_code, 200)
        r = self.c.post("/upload-configuration", content=self.body(6000), headers={"content-type": "application/json"})
        self.assertEqual(r.status_code, 413)
        self.assertIn("te groot", r.json()["detail"])
        self.assertEqual(self.c.put("/notas/x", content=self.body(2000), headers={"content-type": "application/json"}).status_code, 200)
        self.assertEqual(self.c.put("/notas/x", content=self.body(4000), headers={"content-type": "application/json"}).status_code, 413)
        self.assertEqual(self.c.patch("/other", content=self.body(500), headers={"content-type": "application/json"}).status_code, 200)
        self.assertEqual(self.c.patch("/other", content=self.body(1500), headers={"content-type": "application/json"}).status_code, 413)

    def test_chunked_body_is_counted(self):
        def gen():
            for _ in range(10):
                yield b"x" * 200
        r = self.c.patch("/other", content=gen(), headers={"content-type": "application/json"})
        self.assertEqual(r.status_code, 413)

    def test_get_is_never_limited(self):
        self.assertEqual(self.c.get("/other").status_code, 200)

    def test_limit_for_paths(self):
        self.assertEqual(body_limit.limit_for("/api/v1/storage/upload-configuration"), settings.MAX_BODY_BYTES_UPLOAD_CONFIGURATION)
        self.assertEqual(body_limit.limit_for("/api/v1/storage/notas/n1"), settings.MAX_BODY_BYTES_NOTA)
        self.assertEqual(body_limit.limit_for("/api/v1/storage/summarize-nota"), settings.MAX_BODY_BYTES_NOTA)
        self.assertEqual(body_limit.limit_for("/api/v1/storage/configurations/x/metadata"), settings.MAX_BODY_BYTES_DEFAULT)

    def test_defaults_cover_the_frontend_cap(self):
        self.assertGreater(self.old[1], 10 * 1024 * 1024, "the configuration limit is above the 10 MB frontend cap")


class RoleCheckTests(unittest.TestCase):
    def client(self, user):
        app = FastAPI()

        async def fake_user():
            return user

        app.dependency_overrides[security.get_current_user] = fake_user

        @app.post("/w")
        def w(u=Depends(security.require_beheerder)):
            return {"ok": True}

        return TestClient(app)

    def test_only_openwebui_admin_passes(self):
        for role, want in [("admin", 200), (" Admin ", 200), ("user", 403), ("pending", 403), ("", 403)]:
            c = self.client({"id": "u", "role": role, "auth": "openwebui"})
            self.assertEqual(c.post("/w").status_code, want, role)

    def test_denied_is_logged(self):
        c = self.client({"id": "u1", "role": "user", "auth": "openwebui"})
        with self.assertLogs("app.core.security", level="INFO") as cm:
            c.post("/w")
        self.assertTrue(any("role-check=denied" in m and "u1" in m for m in cm.output))


if __name__ == "__main__":
    unittest.main()
