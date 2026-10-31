"""Drop-in replacement for `app.services.ai_agent` that replays recorded fixtures.

Served by sitecustomize.py in place of the real module. The backend builds one prompt string per call and only
that string reaches the mock, so the fixture is chosen from the prompt:

  * `generate-agent-response` prompts start with `INSTRUCTION: ` and carry one of four assignment-specific
    ANTWOORDREGELS blocks; the block identifies the assignment. For structuur the chapter is found by matching
    the instruction text against the chapters of the seeded v5 configuration (fixtures/config/GS-nota-v5.upload.json),
    because every chapter has its own output template and the validator forbids extra keys.
  * the title prompt starts with "Je bent een assistent voor GS-nota's"   -> fixtures/ai/title.json
  * the summary prompt starts with "Geef één regel: een korte samenvatting" -> fixtures/ai/summary.json

Variants ("violates", "typographic", "hostile", plus "error", which raises) are selected per request by a marker
inside the user text, `[[mock:<variant>]]`, which a test appends to `user_message`; or globally with the
environment variable AI_MOCK_VARIANT. The marker travels inside the request, so it works against a backend in
Docker as well.

Every call is appended as a JSON line to the file named by AI_MOCK_LOG (default dev/.ai-mock-calls.jsonl), so
browser scenarios can assert call order.
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
from pathlib import Path

logger = logging.getLogger(__name__)

_HERE = Path(__file__).resolve().parent
_FIXTURES = Path(os.environ.get("AI_MOCK_FIXTURES_DIR", _HERE.parent / "fixtures"))
_LOG = Path(os.environ.get("AI_MOCK_LOG", _HERE.parent / ".ai-mock-calls.jsonl"))
_MARKER = re.compile(r"\[\[mock:([a-z_-]+)\]\]")


def _load(name: str) -> dict:
    return json.loads((_FIXTURES / "ai" / f"{name}.json").read_text(encoding="utf-8"))


def _chapters() -> list[dict]:
    try:
        body = json.loads((_FIXTURES / "config" / "GS-nota-v5.upload.json").read_text(encoding="utf-8"))
        return list(body.values())[0]["mappen"]["hoofdstukken"]
    except Exception:  # fixtures not generated yet
        return []


def classify(prompt: str) -> tuple[str, str | None]:
    """Return (assignment, chapter_id|None) for a backend prompt."""
    if prompt.startswith("Je bent een assistent voor GS-nota's"):
        return "title", None
    if prompt.startswith("Geef één regel: een korte samenvatting"):
        return "summary", None
    if "Origineel, Categorie, Alternatieven" in prompt:
        return "agent_woordenlijst", None
    if "Voor elk item moet 'Uitleg' een duidelijke" in prompt:
        return "agent_spelling_grammatica", None
    if "(array van objecten met Origineel, Suggestie, Uitleg). Geen Analysis" in prompt:
        return "agent_b1", None
    # default ANTWOORDREGELS block: structuur or one of the two unused agents
    m = re.match(r"INSTRUCTION: (.*?)\n\nANTWOORDREGELS:", prompt, re.S)
    instruction = m.group(1) if m else ""
    for ch in _chapters():
        if instruction and ch.get("agent_structuur") == instruction:
            return "agent_structuur", ch["id"]
        if instruction and ch.get("agent_digitale_toegankelijkheid") == instruction and instruction:
            return "agent_digitale_toegankelijkheid", ch["id"]
        if instruction and ch.get("agent_open_overheid") == instruction and instruction:
            return "agent_open_overheid", ch["id"]
    return "agent_structuur", None


class MockAIAgentService:
    """Same surface as `AIAgentService`; `client` is a truthy sentinel."""

    def __init__(self):
        self.endpoint = "mock://recorded"
        self.project_client = None
        self.client = object()
        self.calls = 0

    def get_agent_response(self, user_message: str) -> str:
        self.calls += 1
        prompt = user_message or ""
        assignment, chapter = classify(prompt)
        variant = os.environ.get("AI_MOCK_VARIANT", "") or None
        mm = _MARKER.search(prompt)
        if mm:
            variant = mm.group(1)
        self._log(assignment, chapter, variant, prompt)
        if variant == "error":
            raise Exception("mocked agent failure (variant=error)")

        candidates = []
        if variant:
            candidates.append(f"{assignment}.{variant}")
        if chapter:
            candidates.append(f"{assignment}.{chapter}")
        candidates.append(assignment)
        for name in candidates:
            if (_FIXTURES / "ai" / f"{name}.json").exists():
                fx = _load(name)
                logger.info("ai mock: %s -> fixture %s", assignment, name)
                return fx["raw"]
        # Generic fallback that validates against every structuur template with a Suggestie key.
        logger.warning("ai mock: no fixture for %s (chapter=%s); generic reply", assignment, chapter)
        return json.dumps({"Suggestie": "Generieke suggestie uit de AI-mock."}, ensure_ascii=False)

    def _log(self, assignment, chapter, variant, prompt):
        try:
            _LOG.parent.mkdir(parents=True, exist_ok=True)
            with _LOG.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps({
                    "ts": time.time(), "assignment": assignment, "chapter": chapter,
                    "variant": variant, "prompt_chars": len(prompt),
                    "user_input": prompt.split("GEBRUIKER INPUT: ", 1)[1][:200] if "GEBRUIKER INPUT: " in prompt else None,
                }, ensure_ascii=False) + "\n")
        except Exception:
            pass


ai_agent = MockAIAgentService()
AIAgentService = MockAIAgentService
