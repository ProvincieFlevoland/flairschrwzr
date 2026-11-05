"""Provider selection of app/services/ai_agent.py.

The LiteLLM path is exercised end to end against a stand-in OpenAI-compatible server on 127.0.0.1, so no real
model service is needed. The Foundry path is only checked for its configuration handling (no Azure call)."""
from __future__ import annotations

import json
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest import mock

from app.services import ai_agent as ai_agent_module

try:
    import openai  # noqa: F401
    HAVE_OPENAI = True
except ModuleNotFoundError:
    HAVE_OPENAI = False


def _settings(**overrides):
    values = dict(AI_PROVIDER="foundry", AI_MODEL="", PROJECT_ENDPOINT="", LITELLM_URL="", LITELLM_API_KEY="")
    values.update(overrides)
    return types.SimpleNamespace(**values)


def _service(**overrides):
    with mock.patch.object(ai_agent_module, "settings", _settings(**overrides)):
        return ai_agent_module.AIAgentService()


class _StandIn(BaseHTTPRequestHandler):
    calls: list = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        type(self).calls.append({"path": self.path, "auth": self.headers.get("Authorization"), "body": body})
        answer = {
            "id": "chatcmpl-1", "object": "chat.completion", "created": 0, "model": body["model"],
            "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "antwoord"}}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }
        data = json.dumps(answer).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


class ProviderSelectionTest(unittest.TestCase):
    def test_foundry_without_endpoint_is_disabled(self):
        svc = _service()
        self.assertEqual(svc.provider, "foundry")
        self.assertIsNone(svc.client)
        with self.assertRaisesRegex(Exception, "PROJECT_ENDPOINT"):
            svc.get_agent_response("x")

    def test_foundry_model_defaults_to_chat_agent_and_can_be_renamed(self):
        self.assertEqual(_service().model, "chat-agent")
        self.assertEqual(_service(AI_MODEL="schrijfassistent").model, "schrijfassistent")

    def test_litellm_without_url_is_disabled(self):
        svc = _service(AI_PROVIDER="litellm", AI_MODEL="m")
        self.assertIsNone(svc.client)
        with self.assertRaisesRegex(Exception, "LITELLM_URL"):
            svc.get_agent_response("x")

    def test_litellm_without_model_is_disabled(self):
        svc = _service(AI_PROVIDER="litellm", LITELLM_URL="http://127.0.0.1:9", LITELLM_API_KEY="sk-test")
        self.assertIsNone(svc.client)
        self.assertEqual(svc.model, "")

    def test_unknown_provider_is_disabled(self):
        svc = _service(AI_PROVIDER="iets-anders", AI_MODEL="m", PROJECT_ENDPOINT="https://example.test",
                       LITELLM_URL="http://127.0.0.1:9")
        self.assertIsNone(svc.client)

    def test_provider_name_is_case_insensitive(self):
        self.assertEqual(_service(AI_PROVIDER=" LiteLLM ").provider, "litellm")


@unittest.skipUnless(HAVE_OPENAI, "openai is not installed")
class LiteLLMCallTest(unittest.TestCase):
    def setUp(self):
        _StandIn.calls = []
        self.server = HTTPServer(("127.0.0.1", 0), _StandIn)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_chat_completion_goes_to_litellm_with_model_and_key(self):
        svc = _service(AI_PROVIDER="litellm", AI_MODEL="schrijfassistent", LITELLM_URL=self.url + "/v1/",
                       LITELLM_API_KEY="sk-test")
        self.assertEqual(svc.get_agent_response("hallo"), "antwoord")
        (call,) = _StandIn.calls
        self.assertEqual(call["path"], "/v1/chat/completions")
        self.assertEqual(call["auth"], "Bearer sk-test")
        self.assertEqual(call["body"]["model"], "schrijfassistent")
        self.assertEqual(call["body"]["messages"], [{"role": "user", "content": "hallo"}])

    def test_url_without_v1_works_too(self):
        svc = _service(AI_PROVIDER="litellm", AI_MODEL="m", LITELLM_URL=self.url, LITELLM_API_KEY="sk-test")
        self.assertEqual(svc.get_agent_response("hallo"), "antwoord")
        self.assertEqual(_StandIn.calls[0]["path"], "/chat/completions")

    def test_empty_key_still_sends_a_request(self):
        svc = _service(AI_PROVIDER="litellm", AI_MODEL="m", LITELLM_URL=self.url)
        self.assertIsNotNone(svc.client)
        self.assertEqual(svc.get_agent_response("hallo"), "antwoord")


if __name__ == "__main__":
    unittest.main()
