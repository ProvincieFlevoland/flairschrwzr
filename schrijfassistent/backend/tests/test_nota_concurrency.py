"""Optimistic concurrency of PUT /notas/{id}: the write is conditional on the blob ETag, Blob decides the race.

Runs the route against the stdlib blob emulator (`schrijfassistent/dev/blobemu`, which implements If-Match / If-None-Match
like Blob) with the real azure-storage-blob SDK. Skipped when the emulator source is missing."""
from __future__ import annotations

import json
import sys
import tempfile
import threading
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

try:
    import app.services.ai_agent  # noqa: F401
except ModuleNotFoundError:
    _stub = types.ModuleType("app.services.ai_agent")
    _stub.ai_agent = types.SimpleNamespace(client=None, get_agent_response=lambda prompt: "")
    sys.modules["app.services.ai_agent"] = _stub

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.endpoints import storage
from app.core.security import get_current_user
from app.services.azure_storage import AzureStorageService

EMU = Path(__file__).resolve().parents[2] / "dev" / "blobemu" / "server.py"
BASE_LM = "2026-10-24T08:00:00.000Z"


def _load_emulator():
    import importlib.util

    spec = importlib.util.spec_from_file_location("blobemu_server", EMU)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@unittest.skipUnless(EMU.exists(), "dev/blobemu/server.py not available")
class NotaConcurrencyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        emu = _load_emulator()
        cls._tmp = tempfile.TemporaryDirectory()
        emu.Handler.store = emu.Store(Path(cls._tmp.name))
        emu.Handler.account = "devstoreaccount1"
        cls.emu_store = emu.Handler.store
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), emu.Handler)
        cls.srv.daemon_threads = True
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        port = cls.srv.server_address[1]
        conn = (
            "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSrZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;"
            f"BlobEndpoint=http://127.0.0.1:{port}/devstoreaccount1;"
        )
        from azure.storage.blob import BlobServiceClient

        cls.service = AzureStorageService()
        cls.service.container_name = "govchat-docs"
        cls.service.blob_service_client = BlobServiceClient.from_connection_string(conn)
        cls.service.container_client = cls.service.blob_service_client.get_container_client("govchat-docs")
        cls.service.container_client.create_container()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        cls._tmp.cleanup()

    def setUp(self):
        app = FastAPI()
        app.include_router(storage.router, prefix="/api/v1/storage")
        app.dependency_overrides[get_current_user] = lambda: {"id": "u1"}
        self.client = TestClient(app, raise_server_exceptions=False)
        self.patch = mock.patch.object(storage, "azure_storage", self.service)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.nid = "race-" + str(id(self))
        self.url = f"/api/v1/storage/notas/{self.nid}"

    def _nota(self, content, lm):
        return {"id": self.nid, "title": "race", "content": content, "lastModified": lm}

    def _stored(self):
        return json.loads(self.service.download_blob(f"notas/{self.nid}.json"))

    def test_put_with_base_header_does_not_download_the_nota(self):
        self.assertEqual(self.client.put(self.url, json=self._nota("a", BASE_LM)).status_code, 200)
        with mock.patch.object(self.service, "download_blob", side_effect=AssertionError("downloaded")), \
                mock.patch.object(self.service, "download_blob_with_etag", side_effect=AssertionError("downloaded")):
            r = self.client.put(self.url, json=self._nota("b", "2026-10-24T08:05:00.000Z"), headers={"X-Nota-Base-Modified": BASE_LM})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.headers.get("etag"))

    def test_lost_race_between_check_and_write_is_409_and_not_written(self):
        """Another writer lands after this request compared the header and before it wrote: Blob answers 412, the route 409."""
        self.assertEqual(self.client.put(self.url, json=self._nota("a", BASE_LM)).status_code, 200)
        real_state = self.service.blob_state

        def state_then_competitor(name):
            result = real_state(name)
            self.service.upload_blob(name, json.dumps(self._nota("competitor", "2026-10-24T08:09:00.000Z")).encode(),
                                     metadata={"notalm": "2026-10-24T08:09:00.000Z"})
            return result

        with mock.patch.object(self.service, "blob_state", side_effect=state_then_competitor):
            r = self.client.put(self.url, json=self._nota("loser", "2026-10-24T08:06:00.000Z"), headers={"X-Nota-Base-Modified": BASE_LM})
        self.assertEqual(r.status_code, 409, r.text)
        detail = r.json()["detail"]
        self.assertEqual(detail["error"], "conflict")
        self.assertEqual(detail["base_last_modified"], BASE_LM)
        self.assertEqual(detail["stored_last_modified"], "2026-10-24T08:09:00.000Z")
        self.assertEqual(self._stored()["content"], "competitor")

    def test_eight_simultaneous_saves_with_the_same_base_one_wins(self):
        self.assertEqual(self.client.put(self.url, json=self._nota("a", BASE_LM)).status_code, 200)

        def save(i):
            r = self.client.put(self.url, json=self._nota(f"writer {i}", f"2026-10-24T08:0{i}:00.000Z"), headers={"X-Nota-Base-Modified": BASE_LM})
            return i, r.status_code

        with ThreadPoolExecutor(8) as pool:
            results = list(pool.map(save, range(1, 9)))
        self.assertEqual(sorted(st for _, st in results), [200] + [409] * 7, results)
        winner = next(i for i, st in results if st == 200)
        self.assertEqual(self._stored()["content"], f"writer {winner}")

    def test_if_match_header_is_the_validator(self):
        self.assertEqual(self.client.put(self.url, json=self._nota("a", BASE_LM)).status_code, 200)
        etag1 = self.client.get(self.url).headers["etag"]
        ok = self.client.put(self.url, json=self._nota("b", "2026-10-24T08:05:00.000Z"), headers={"If-Match": etag1})
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertNotEqual(ok.headers["etag"], etag1)
        stale = self.client.put(self.url, json=self._nota("c", "2026-10-24T08:06:00.000Z"), headers={"If-Match": etag1})
        self.assertEqual(stale.status_code, 409, stale.text)
        self.assertEqual(self._stored()["content"], "b")

    def test_first_save_with_header_and_creation_race(self):
        r = self.client.put(self.url, json=self._nota("a", BASE_LM), headers={"X-Nota-Base-Modified": "2026-10-23T00:00:00.000Z"})
        self.assertEqual(r.status_code, 200, r.text)
        self.client.delete(self.url)
        real_state = self.service.blob_state

        def state_then_create(name):
            result = real_state(name)  # None: no blob yet
            self.service.upload_blob(name, json.dumps(self._nota("other", "2026-10-24T08:09:00.000Z")).encode())
            return result

        with mock.patch.object(self.service, "blob_state", side_effect=state_then_create):
            r = self.client.put(self.url, json=self._nota("late", BASE_LM), headers={"X-Nota-Base-Modified": "2026-10-23T00:00:00.000Z"})
        self.assertEqual(r.status_code, 409, r.text)
        self.assertEqual(self._stored()["content"], "other")

    def test_nota_without_metadata_is_read_once_and_still_guarded(self):
        """A nota stored before has no `notalm` metadata: it is read once; the ETag of that read still guards the write."""
        self.service.upload_blob(f"notas/{self.nid}.json", json.dumps(self._nota("old", BASE_LM)).encode())
        stale = self.client.put(self.url, json=self._nota("x", "2026-10-24T08:06:00.000Z"), headers={"X-Nota-Base-Modified": "2020-01-01T00:00:00.000Z"})
        self.assertEqual(stale.status_code, 409, stale.text)
        self.assertEqual(stale.json()["detail"]["stored_last_modified"], BASE_LM)
        ok = self.client.put(self.url, json=self._nota("y", "2026-10-24T08:07:00.000Z"), headers={"X-Nota-Base-Modified": BASE_LM})
        self.assertEqual(ok.status_code, 200, ok.text)

    def test_put_without_header_is_last_write_wins(self):
        self.assertEqual(self.client.put(self.url, json=self._nota("a", BASE_LM)).status_code, 200)
        self.assertEqual(self.client.put(self.url, json=self._nota("b", "2020-01-01T00:00:00.000Z")).status_code, 200)
        self.assertEqual(self._stored()["content"], "b")


if __name__ == "__main__":
    unittest.main()
