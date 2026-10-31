"""The backend logs no nota text on its error paths, and the routes that call the
synchronous Azure SDK are plain functions (Starlette runs them in the thread pool, so the event loop stays free).

The AI answer quotes the author's chapter, so a marker placed in the answer must never reach the log, whichever way the
validation fails. The responses to the client are untouched."""
from __future__ import annotations

import asyncio
import json
import logging
import unittest
from unittest import mock

import sys
import types

try:  # the Azure AI client is not installed in the offline venv; the routes only need the two attributes of the service
    import app.services.ai_agent  # noqa: F401
except ModuleNotFoundError:
    _stub = types.ModuleType("app.services.ai_agent")
    _stub.ai_agent = types.SimpleNamespace(client=None, get_agent_response=lambda prompt: "")
    sys.modules["app.services.ai_agent"] = _stub

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.endpoints import storage
from app.core.security import get_current_user

MARKER = "MARKER-geheime-notatekst-4711"
TEMPLATE = {"Suggesties": [{"Origineel": "", "Suggestie": "", "Uitleg": ""}]}


class _FakeBlobs:
    def download_blob(self, name):
        if name.endswith("/hoofdstukken/c1.json"):
            return json.dumps({"agent_b1": "instructie", "agent_b1_output_template": json.dumps(TEMPLATE)}).encode()
        raise FileNotFoundError(name)


class _FakeAgent:
    client = object()

    def __init__(self, answer=None, error=None):
        self.answer, self.error = answer, error

    def get_agent_response(self, prompt):
        if self.error:
            raise self.error
        return self.answer


class LogHygieneTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(storage.router, prefix="/api/v1/storage")
        app.dependency_overrides[get_current_user] = lambda: {"id": "u1"}
        self.client = TestClient(app, raise_server_exceptions=False)

    def _call(self, agent, path="/api/v1/storage/generate-agent-response?config_id=cfg&chapter_id=c1&assignment=agent_b1", method="post", **kw):
        if "json" not in kw and "generate-agent-response" in path:
            kw["json"] = {"user_message": "hallo"}  # the message travels in the body
        with mock.patch.object(storage, "azure_storage", _FakeBlobs()), mock.patch.object(storage, "ai_agent", agent):
            with self.assertLogs(level="DEBUG") as cm:
                logging.getLogger("test").debug("anchor")  # assertLogs needs at least one record
                resp = getattr(self.client, method)(path, **kw)
        # the app's own log lines; the test client's httpx logger echoes the request URL and is not part of the service
        return resp, "\n".join(f"{r.name}: {r.getMessage()}" for r in cm.records if not r.name.startswith("httpx"))

    def test_validation_failure_logs_no_answer_text(self):
        answer = json.dumps({"Anders": f"Origineel {MARKER}"})
        resp, log = self._call(_FakeAgent(answer))
        self.assertEqual(resp.status_code, 500)  # the 422 is caught by the route and answered as a 500
        self.assertNotIn(MARKER, log)
        self.assertIn("Validation failed", log)

    def test_unparsable_answer_logs_no_answer_text(self):
        resp, log = self._call(_FakeAgent(f"{MARKER} {{{{ geen json ]]"))
        self.assertIn(resp.status_code, (200, 500))
        self.assertNotIn(MARKER, log)

    def test_agent_failure_logs_class_only(self):
        resp, log = self._call(_FakeAgent(error=RuntimeError(f"upstream echoed {MARKER}")))
        self.assertEqual(resp.status_code, 500)
        self.assertNotIn(MARKER, log)
        self.assertIn("RuntimeError", log)

    def test_title_failure_logs_no_nota_text(self):
        body = {"chapters": [{"title": "Onderwerp", "content": MARKER}]}
        resp, log = self._call(
            _FakeAgent(error=RuntimeError(f"echo {MARKER}")),
            path="/api/v1/storage/generate-nota-title",
            json=body,
        )
        self.assertEqual(resp.status_code, 500)
        self.assertNotIn(MARKER, log)

    def test_user_message_never_logged(self):
        """The message (nota text) is in the body; it never reaches the log."""
        answer = json.dumps({"Anders": "x"})
        base = "/api/v1/storage/generate-agent-response?config_id=cfg&chapter_id=c1&assignment=agent_b1"
        resp, log = self._call(_FakeAgent(answer), path=base, json={"user_message": MARKER})
        self.assertEqual(resp.status_code, 500)  # validation failure answers as in test_validation_failure_logs_no_answer_text
        self.assertNotIn(MARKER, log)

    def test_agent_route_reads_the_body_only(self):
        seen = []

        class Echo(_FakeAgent):
            def get_agent_response(self, prompt):
                seen.append(prompt)
                return json.dumps({"Suggesties": []})

        base = "/api/v1/storage/generate-agent-response?config_id=cfg&chapter_id=c1&assignment=agent_b1"
        r1, _ = self._call(Echo(), path=base, json={"user_message": "uit de body"})
        r2, _ = self._call(Echo(), path=base + "&user_message=query", json={"user_message": "body wint"})
        r3, _ = self._call(Echo(), path=base, json={})
        r4, _ = self._call(Echo(), path=base + "&user_message=alleen%20query", json=None)
        self.assertEqual([r1.status_code, r2.status_code], [200, 200])
        self.assertTrue(seen[0].endswith("GEBRUIKER INPUT: uit de body"))
        self.assertTrue(seen[1].endswith("GEBRUIKER INPUT: body wint"))
        self.assertEqual(r3.status_code, 422)
        self.assertEqual(r4.status_code, 422)

    def test_title_clamp_strips_quote_pairs(self):
        """a “ ” pair no longer survives on the title."""
        class Title(_FakeAgent):
            pass

        for raw, expected in (("“Parkeergarage onder het provinciehuis bouwen.”", "Parkeergarage onder het provinciehuis bouwen"),
                              ('"Titel"', "Titel"), ("«Titel»", "Titel"), ("„Titel”", "Titel")):
            resp, _ = self._call(Title(answer=raw), path="/api/v1/storage/generate-nota-title", json={"chapters": [{"title": "t", "content": "c"}]})
            self.assertEqual(resp.json()["title"], expected)

    def test_storage_500_text_is_fixed_and_log_keeps_class(self):
        """the 500 answer of a storage route is a fixed Dutch text; the log has the exception class only."""
        class Boom:
            def delete_blob(self, name):
                raise RuntimeError(f"https://secret.blob.core.windows.net/{MARKER}")

        with mock.patch.object(storage, "azure_storage", Boom()):
            with self.assertLogs(level="DEBUG") as cm:
                logging.getLogger("test").debug("anchor")
                resp = self.client.delete("/api/v1/storage/notas/n1")
        self.assertEqual(resp.status_code, 500)
        self.assertEqual(resp.json()["detail"], storage.STORAGE_ERROR_TEXT)
        self.assertNotIn(MARKER, resp.text)
        log = "\n".join(cm.output)
        self.assertNotIn(MARKER, log)
        self.assertIn("RuntimeError", log)

    def test_blocking_routes_are_plain_functions(self):
        for fn in (
            storage.save_nota,
            storage.generate_agent_response,
            storage.generate_nota_title,
            storage.summarize_nota,
            storage.upload_configuration,
        ):
            self.assertFalse(asyncio.iscoroutinefunction(fn), fn.__name__)


if __name__ == "__main__":
    unittest.main()
