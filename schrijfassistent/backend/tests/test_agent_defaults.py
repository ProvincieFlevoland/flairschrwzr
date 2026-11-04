"""The spelling instruction is editable in the beheeromgeving: the chapter's `agent_spelling_grammatica` goes into the
prompt, and an empty or missing one falls back to the default text. The answer-format rules stay in the code.
Structuur and Direct Duidelijk (agent_b1) keep their stored instruction as before."""
from __future__ import annotations

import json
import sys
import types
import unittest
from unittest import mock

try:  # the Azure AI client is not installed in the offline venv; the routes only need the two attributes of the service
    import app.services.ai_agent  # noqa: F401
except ModuleNotFoundError:
    _stub = types.ModuleType("app.services.ai_agent")
    _stub.ai_agent = types.SimpleNamespace(client=None, get_agent_response=lambda prompt: "")
    sys.modules["app.services.ai_agent"] = _stub

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.endpoints import storage
from app.core.agent_defaults import DEFAULT_SPELLING_INSTRUCTION, resolve_instruction
from app.core.security import get_current_user

ANSWER = json.dumps({"Suggesties": []})


class _Blobs:
    def __init__(self, chapter):
        self.chapter = chapter

    def download_blob(self, name):
        if name.endswith("/hoofdstukken/c1.json"):
            return json.dumps(self.chapter).encode()
        raise FileNotFoundError(name)


class _Agent:
    client = object()

    def __init__(self):
        self.prompts = []

    def get_agent_response(self, prompt):
        self.prompts.append(prompt)
        return ANSWER


class ResolveInstructionTests(unittest.TestCase):
    def test_stored_spelling_instruction_wins(self):
        self.assertEqual(resolve_instruction("agent_spelling_grammatica", {"agent_spelling_grammatica": "Eigen regels"}), "Eigen regels")

    def test_empty_or_missing_spelling_instruction_uses_default(self):
        for chapter in ({"agent_spelling_grammatica": ""}, {"agent_spelling_grammatica": "  \n"}, {"agent_spelling_grammatica": None}, {}):
            self.assertEqual(resolve_instruction("agent_spelling_grammatica", chapter), DEFAULT_SPELLING_INSTRUCTION, chapter)

    def test_other_assignments_are_unchanged(self):
        self.assertEqual(resolve_instruction("agent_b1", {"agent_b1": ""}), "")
        self.assertEqual(resolve_instruction("agent_structuur", {"agent_structuur": "S"}), "S")
        self.assertIsNone(resolve_instruction("agent_b1", {}))
        self.assertIsNone(resolve_instruction("agent_bestaat_niet", {}))


class AgentRouteTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(storage.router, prefix="/api/v1/storage")
        app.dependency_overrides[get_current_user] = lambda: {"id": "u1"}
        self.client = TestClient(app, raise_server_exceptions=False)

    def _prompt(self, chapter, assignment="agent_spelling_grammatica"):
        agent = _Agent()
        with mock.patch.object(storage, "azure_storage", _Blobs(chapter)), mock.patch.object(storage, "ai_agent", agent):
            resp = self.client.post(
                f"/api/v1/storage/generate-agent-response?config_id=cfg&chapter_id=c1&assignment={assignment}",
                json={"user_message": "Dit is  een tekst ."},
            )
        return resp, (agent.prompts[0] if agent.prompts else None)

    def test_stored_spelling_instruction_reaches_the_prompt(self):
        resp, prompt = self._prompt({"agent_spelling_grammatica": "Let vooral op de spelling van plaatsnamen."})
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(prompt.startswith("INSTRUCTION: Let vooral op de spelling van plaatsnamen.\n\nANTWOORDREGELS:"))
        self.assertNotIn(DEFAULT_SPELLING_INSTRUCTION, prompt)

    def test_empty_spelling_instruction_uses_the_default(self):
        resp, prompt = self._prompt({"agent_spelling_grammatica": ""})
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(prompt.startswith(f"INSTRUCTION: {DEFAULT_SPELLING_INSTRUCTION}\n\nANTWOORDREGELS:"))

    def test_missing_spelling_instruction_uses_the_default(self):
        resp, prompt = self._prompt({"agent_structuur": "S"})
        self.assertEqual(resp.status_code, 200)
        self.assertIn(DEFAULT_SPELLING_INSTRUCTION, prompt)

    def test_answer_format_rules_stay_in_code(self):
        _, prompt = self._prompt({"agent_spelling_grammatica": "Eigen regels"})
        rules = prompt.split("\n\nANTWOORDREGELS:", 1)[1]
        self.assertIn("'Suggesties'", rules)
        self.assertIn("Voor elk item moet 'Uitleg' een duidelijke", rules)
        self.assertIn("In Origineel: kopieer een aaneengesloten substring EXACT", rules)
        # what the agent checks is no longer hard-coded
        self.assertNotIn("Signaleer ook subtiele problemen", rules)

    def test_b1_keeps_its_404_and_stored_text(self):
        resp, prompt = self._prompt({"agent_structuur": "S"}, assignment="agent_b1")
        self.assertEqual(resp.status_code, 404)
        self.assertIsNone(prompt)
        resp, prompt = self._prompt({"agent_b1": "B1-instructie"}, assignment="agent_b1")
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(prompt.startswith("INSTRUCTION: B1-instructie\n\nANTWOORDREGELS:"))

    def test_agent_defaults_endpoint(self):
        resp = self.client.get("/api/v1/storage/agent-defaults")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {"instructions": {"agent_spelling_grammatica": DEFAULT_SPELLING_INSTRUCTION}})


if __name__ == "__main__":
    unittest.main()
