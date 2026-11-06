"""Model choice per configuratie, kop and opdracht (app/core/model_resolver.py, the AI routes and app/services/ai_agent.py).

The routes are tested with a fake agent that records the model it was asked for; the LiteLLM path of the service is
tested end to end against a stand-in OpenAI-compatible server on 127.0.0.1 (no real model service)."""
from __future__ import annotations

import json
import sys
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest import mock

try:  # the routes only need the attributes of the service; the stand-in tests below need the real one
    import app.services.ai_agent as ai_agent_module
except ModuleNotFoundError:  # pragma: no cover - offline venv without the AI SDKs
    ai_agent_module = None
    _stub = types.ModuleType("app.services.ai_agent")
    _stub.ai_agent = types.SimpleNamespace(client=None, get_agent_response=lambda prompt, model=None: "")
    sys.modules["app.services.ai_agent"] = _stub

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api.endpoints import storage
from app.core.model_resolver import check_upload_models, resolve_model
from app.core.security import get_current_user

try:
    import openai  # noqa: F401
    HAVE_OPENAI = True
except ModuleNotFoundError:
    HAVE_OPENAI = False

CONFIG = {
    "name": "GS-nota",
    "aiModellen": {
        "standaard": "slim",
        "opdrachten": {"agent_spelling_grammatica": "snel", "titel": "titel-model", "samenvatting": ""},
    },
}
CHAPTER_PLAIN = {"id": "h1", "agent_b1": "B1", "agent_spelling_grammatica": "S", "agent_structuur": "St"}
CHAPTER_OWN = {
    "id": "h3",
    "agent_b1": "B1", "agent_spelling_grammatica": "S", "agent_structuur": "St",
    "aiModellen": {"standaard": "kop-model", "opdrachten": {"agent_structuur": "slimst"}},
}


class ResolverTests(unittest.TestCase):
    def test_most_specific_choice_wins(self):
        self.assertEqual(resolve_model("agent_structuur", CHAPTER_OWN, CONFIG), ("slimst", "kop-opdracht"))
        self.assertEqual(resolve_model("agent_b1", CHAPTER_OWN, CONFIG), ("kop-model", "kop"))
        self.assertEqual(resolve_model("agent_spelling_grammatica", CHAPTER_PLAIN, CONFIG), ("snel", "configuratie-opdracht"))
        self.assertEqual(resolve_model("agent_b1", CHAPTER_PLAIN, CONFIG), ("slim", "configuratie"))
        self.assertEqual(resolve_model("agent_b1", CHAPTER_PLAIN, {}), (None, "standaard"))

    def test_empty_choices_are_inherited(self):
        chapter = {"aiModellen": {"standaard": "  ", "opdrachten": {"agent_b1": ""}}}
        self.assertEqual(resolve_model("agent_b1", chapter, CONFIG), ("slim", "configuratie"))
        self.assertEqual(resolve_model("samenvatting", None, CONFIG), ("slim", "configuratie"))

    def test_nota_wide_tasks_use_the_configuration(self):
        self.assertEqual(resolve_model("titel", None, CONFIG), ("titel-model", "configuratie-opdracht"))

    def test_existing_configuration_without_choice_uses_ai_model(self):
        self.assertEqual(resolve_model("agent_b1", {"agent_b1": "x"}, {"name": "oud"}), (None, "standaard"))
        self.assertEqual(resolve_model("agent_b1", None, None), (None, "standaard"))

    def test_malformed_blocks_are_ignored(self):
        self.assertEqual(resolve_model("agent_b1", {"aiModellen": "slim"}, {"aiModellen": {"opdrachten": ["x"]}}), (None, "standaard"))

    def test_unavailable_model_falls_back_with_a_warning(self):
        with self.assertLogs("app.core.model_resolver", level="WARNING") as cm:
            self.assertEqual(resolve_model("agent_structuur", CHAPTER_OWN, CONFIG, ["kop-model", "slim"]), ("kop-model", "kop"))
        self.assertIn("slimst", cm.output[0])
        self.assertEqual(resolve_model("agent_structuur", CHAPTER_OWN, CONFIG, []), (None, "standaard"))


class UploadCheckTests(unittest.TestCase):
    def _upload(self, config_models=None, chapter_models=None):
        chapter = {"id": "h1"}
        if chapter_models is not None:
            chapter["aiModellen"] = chapter_models
        inner = {"name": "x", "mappen": {"hoofdstukken": [chapter]}}
        if config_models is not None:
            inner["aiModellen"] = config_models
        return {"cfg": inner}

    def test_valid_and_absent_blocks_pass(self):
        check_upload_models(self._upload())
        check_upload_models(self._upload({"standaard": "slim", "opdrachten": {"titel": "snel", "agent_b1": ""}}, {"standaard": None}))

    def test_malformed_blocks_are_refused(self):
        for config_models, chapter_models in (
            ("slim", None),
            ({"opdrachten": ["slim"]}, None),
            ({"standaard": 5}, None),
            (None, {"opdrachten": {"agent_b1": "a\nb"}}),
            (None, {"standaard": "x" * 201}),
        ):
            with self.assertRaises(HTTPException) as cm:
                check_upload_models(self._upload(config_models, chapter_models))
            self.assertEqual(cm.exception.status_code, 400)


class _Blobs:
    def __init__(self, metadata=None, chapters=None):
        self.metadata = metadata
        self.chapters = chapters or {}

    def download_blob(self, name):
        if name == "cfg/metadata.json" and self.metadata is not None:
            return json.dumps(self.metadata).encode()
        for cid, chapter in self.chapters.items():
            if name == f"cfg/hoofdstukken/{cid}.json":
                return json.dumps(chapter).encode()
        raise FileNotFoundError(name)


class _Agent:
    client = object()
    model = "standaard-model"
    provider = "litellm"
    selectable = True

    def __init__(self, answer='{"Suggesties": []}', available=None, models=None, list_error=None):
        self.answer, self.available, self.models, self.list_error = answer, available, models or [], list_error
        self.calls = []

    def available_models(self):
        return self.available

    def list_models(self):
        if self.list_error:
            raise self.list_error
        return list(self.models)

    def get_agent_response(self, prompt, model=None):
        self.calls.append(model)
        return self.answer


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.app = FastAPI()
        self.app.include_router(storage.router, prefix="/api/v1/storage")
        self.user = {"id": "u1", "auth": "openwebui", "role": "admin"}
        self.app.dependency_overrides[get_current_user] = lambda: self.user
        self.client = TestClient(self.app, raise_server_exceptions=False)

    def _post(self, agent, blobs, path, body):
        with mock.patch.object(storage, "azure_storage", blobs), mock.patch.object(storage, "ai_agent", agent):
            return self.client.post(path, json=body)

    def _agent_call(self, agent, chapter_id, assignment, metadata=CONFIG):
        blobs = _Blobs(metadata, {"h1": CHAPTER_PLAIN, "h3": CHAPTER_OWN})
        path = f"/api/v1/storage/generate-agent-response?config_id=cfg&chapter_id={chapter_id}&assignment={assignment}"
        return self._post(agent, blobs, path, {"user_message": "tekst"})

    def test_agent_route_uses_the_chosen_model(self):
        agent = _Agent()
        for chapter_id, assignment in (("h3", "agent_structuur"), ("h3", "agent_b1"), ("h1", "agent_spelling_grammatica"), ("h1", "agent_b1")):
            self.assertEqual(self._agent_call(agent, chapter_id, assignment).status_code, 200)
        self.assertEqual(agent.calls, ["slimst", "kop-model", "snel", "slim"])

    def test_agent_route_without_choice_uses_ai_model(self):
        agent = _Agent()
        self.assertEqual(self._agent_call(agent, "h1", "agent_b1", metadata=None).status_code, 200)
        self.assertEqual(agent.calls, [None])

    def test_agent_route_skips_a_model_that_is_not_offered(self):
        agent = _Agent(available=["slim", "snel"])
        self.assertEqual(self._agent_call(agent, "h3", "agent_structuur").status_code, 200)
        self.assertEqual(agent.calls, ["slim"])

    def test_foundry_ignores_the_choice(self):
        agent = _Agent()
        agent.selectable = False
        self.assertEqual(self._agent_call(agent, "h3", "agent_structuur").status_code, 200)
        self.assertEqual(agent.calls, [None])

    def test_agent_route_logs_the_model_not_the_text(self):
        agent = _Agent()
        with self.assertLogs("app.api.endpoints.storage", level="INFO") as cm:
            self._agent_call(agent, "h3", "agent_structuur")
        line = next(l for l in cm.output if "ai-call" in l)
        self.assertIn("model=slimst", line)
        self.assertIn("source=kop-opdracht", line)
        self.assertNotIn("tekst", line)

    def test_title_and_summary_use_the_configuration(self):
        agent = _Agent(answer="Korte titel")
        body = {"chapters": [{"title": "a", "content": "b"}], "config_id": "cfg"}
        self.assertEqual(self._post(agent, _Blobs(CONFIG), "/api/v1/storage/generate-nota-title", body).status_code, 200)
        self.assertEqual(self._post(agent, _Blobs(CONFIG), "/api/v1/storage/summarize-nota", body).status_code, 200)
        self.assertEqual(agent.calls, ["titel-model", "slim"])

    def test_title_without_config_id_still_works(self):
        agent = _Agent(answer="Korte titel")
        r = self._post(agent, _Blobs(CONFIG), "/api/v1/storage/generate-nota-title", {"chapters": [{"title": "a", "content": "b"}]})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(agent.calls, [None])

    def test_bad_config_id_is_refused(self):
        for bad in ("../x", 5):
            r = self._post(_Agent(), _Blobs(CONFIG), "/api/v1/storage/summarize-nota", {"chapters": [{"title": "a", "content": "b"}], "config_id": bad})
            self.assertEqual(r.status_code, 400, bad)

    def test_upload_refuses_a_malformed_model_block(self):
        body = {"cfg": {"name": "x", "aiModellen": "slim", "mappen": {}}}
        with mock.patch.object(storage, "azure_storage", _Blobs()):
            r = self.client.post("/api/v1/storage/upload-configuration", json=body)
        self.assertEqual(r.status_code, 400)

    def test_model_list_for_a_beheerder(self):
        agent = _Agent(models=["slim", "snel"])
        with mock.patch.object(storage, "ai_agent", agent):
            r = self.client.get("/api/v1/storage/ai-models")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"provider": "litellm", "default": "standaard-model", "selectable": True, "models": ["slim", "snel"]})

    def test_model_list_when_the_service_is_down(self):
        agent = _Agent(list_error=ConnectionError("http://geheim-intern/v1"))
        with mock.patch.object(storage, "ai_agent", agent):
            r = self.client.get("/api/v1/storage/ai-models")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["models"], [])
        self.assertIn("niet worden opgehaald", r.json()["error"])
        self.assertNotIn("geheim", r.text)

    def test_model_list_is_for_a_beheerder_only(self):
        self.user = {"id": "u2", "auth": "openwebui", "role": "user"}
        with mock.patch.object(storage, "ai_agent", _Agent(models=["slim"])):
            r = self.client.get("/api/v1/storage/ai-models")
        self.assertEqual(r.status_code, 403)


class _StandIn(BaseHTTPRequestHandler):
    calls: list = []
    known = {"slim", "snel", "standaard"}
    models_status = 200

    def _send(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        type(self).calls.append({"path": self.path, "auth": self.headers.get("Authorization")})
        if type(self).models_status != 200:
            return self._send(type(self).models_status, {"error": {"message": "down"}})
        self._send(200, {"object": "list", "data": [{"id": m, "object": "model", "created": 0, "owned_by": "x"} for m in sorted(type(self).known)]})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        type(self).calls.append({"path": self.path, "model": body["model"]})
        if body["model"] not in type(self).known:
            return self._send(400, {"error": {"message": f"Invalid model name passed in model={body['model']}", "type": "invalid_request_error", "code": "400"}})
        self._send(200, {
            "id": "c", "object": "chat.completion", "created": 0, "model": body["model"],
            "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": f"antwoord van {body['model']}"}}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        })

    def log_message(self, *args):
        pass


@unittest.skipUnless(HAVE_OPENAI and ai_agent_module is not None, "openai is not installed")
class LiteLLMModelTests(unittest.TestCase):
    def setUp(self):
        _StandIn.calls = []
        _StandIn.models_status = 200
        self.server = HTTPServer(("127.0.0.1", 0), _StandIn)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        settings = types.SimpleNamespace(AI_PROVIDER="litellm", AI_MODEL="standaard", PROJECT_ENDPOINT="",
                                         LITELLM_URL=f"http://127.0.0.1:{self.server.server_port}/v1", LITELLM_API_KEY="sk-test")
        with mock.patch.object(ai_agent_module, "settings", settings):
            self.svc = ai_agent_module.AIAgentService()
        self.svc.client = self.svc.client.with_options(max_retries=0)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_chosen_model_is_sent(self):
        self.assertEqual(self.svc.get_agent_response("hallo", model="snel"), "antwoord van snel")
        self.assertEqual(self.svc.get_agent_response("hallo"), "antwoord van standaard")
        self.assertEqual([c["model"] for c in _StandIn.calls], ["snel", "standaard"])

    def test_refused_model_is_retried_with_the_default(self):
        with self.assertLogs("app.services.ai_agent", level="WARNING") as cm:
            self.assertEqual(self.svc.get_agent_response("hallo", model="weg"), "antwoord van standaard")
        self.assertEqual([c["model"] for c in _StandIn.calls], ["weg", "standaard"])
        self.assertIn("weg", cm.output[0])

    def test_model_list_comes_from_litellm_and_is_kept(self):
        self.assertTrue(self.svc.selectable)
        self.assertEqual(self.svc.list_models(), ["slim", "snel", "standaard"])
        self.assertEqual(self.svc.available_models(), ["slim", "snel", "standaard"])
        gets = [c for c in _StandIn.calls if "model" not in c]
        self.assertEqual(len(gets), 1)
        self.assertEqual(gets[0]["path"], "/v1/models")
        self.assertEqual(gets[0]["auth"], "Bearer sk-test")

    def test_unknown_model_list_does_not_block_a_call(self):
        _StandIn.models_status = 500
        self.assertIsNone(self.svc.available_models())
        self.assertIsNone(self.svc.available_models())  # not asked again right away
        self.assertEqual(len([c for c in _StandIn.calls if "model" not in c]), 1)
        with self.assertRaises(Exception):
            self.svc.list_models(force=True)

    def test_foundry_offers_no_choice(self):
        settings = types.SimpleNamespace(AI_PROVIDER="foundry", AI_MODEL="", PROJECT_ENDPOINT="", LITELLM_URL="", LITELLM_API_KEY="")
        with mock.patch.object(ai_agent_module, "settings", settings):
            svc = ai_agent_module.AIAgentService()
        self.assertFalse(svc.selectable)
        self.assertIsNone(svc.available_models())
        self.assertEqual(svc.list_models(), [])


if __name__ == "__main__":
    unittest.main()
