"""Words, sentences and paragraphs are counted in code (app/core/text_count.py), not by the language model.

The shared cases in dev/fixtures/text-count-cases.json are also checked by the frontend tests
(frontend/tests/text-count.test.mjs), so backend and frontend count the same way."""
from __future__ import annotations

import json
import sys
import types
import unittest
from pathlib import Path
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
from app.core.security import get_current_user
from app.core.text_count import (
    LengthRule,
    check_length_rule,
    count_block,
    count_text,
    count_words,
    find_length_rules,
    truncate_words,
)

SCHRIJFASSISTENT = Path(__file__).resolve().parents[2]
CASES = json.loads((SCHRIJFASSISTENT / "dev/fixtures/text-count-cases.json").read_text(encoding="utf-8"))["cases"]
GS_NOTA = json.loads((SCHRIJFASSISTENT / "dev/fixtures/config/GS-nota-v5.upload.json").read_text(encoding="utf-8"))


def _structuur_instruction(index: int) -> str:
    config = next(iter(GS_NOTA.values()))
    return config["mappen"]["hoofdstukken"][index]["agent_structuur"]


class SharedCasesTests(unittest.TestCase):
    def test_shared_cases(self):
        for case in CASES:
            with self.subTest(case["name"]):
                counted = count_text(case["text"])
                self.assertEqual(counted.words, case["words"])
                self.assertEqual([s.words for s in counted.sentences], case["sentences"])
                self.assertEqual(len(counted.paragraphs), case["paragraphs"])
                self.assertEqual(count_words(case["text"]), case["words"])


class CountTests(unittest.TestCase):
    def test_punctuation_does_not_change_the_word_count(self):
        plain = "Aanbesteding bouw parkeergarage provinciehuis"
        for variant in (
            "Aanbesteding bouw parkeergarage provinciehuis.",
            "Aanbesteding – bouw parkeergarage, provinciehuis!",
            "“Aanbesteding bouw parkeergarage provinciehuis”",
            "Aanbesteding bouw parkeergarage provinciehuis …",
        ):
            self.assertEqual(count_words(variant), count_words(plain), variant)

    def test_paragraph_counts(self):
        counted = count_text("Eerste zin. Tweede zin.\nDerde zin van de tweede alinea.")
        self.assertEqual([(p.words, p.sentences) for p in counted.paragraphs], [(4, 2), (6, 1)])

    def test_truncate_words_skips_punctuation(self):
        self.assertEqual(truncate_words("Subsidie – toekenning 4-5 mei comité Flevoland 2024", 5), "Subsidie – toekenning 4-5 mei comité")
        self.assertEqual(truncate_words("Een twee drie", 5), "Een twee drie")
        self.assertEqual(truncate_words("Een twee – drie", 2), "Een twee")


class LengthRuleTests(unittest.TestCase):
    def test_rules_from_the_gs_nota_configuration(self):
        titel = find_length_rules(_structuur_instruction(0))
        self.assertEqual([(r.text, r.limit, r.unit, r.per) for r in titel], [("Maximaal 5 woorden", 5, "woorden", None)])
        kern = find_length_rules(_structuur_instruction(2))
        # "Maximaal 12 regels" is about printed lines, which the code cannot know: left to the model.
        self.assertEqual([(r.limit, r.unit) for r in kern], [(100, "woorden")])
        # "Toelichting in maximaal twee zinnen waarom ..." is about one part of the text: left to the model.
        self.assertEqual(find_length_rules(_structuur_instruction(6)), [])

    def test_rule_forms(self):
        rules = find_length_rules(
            "REGELS\n"
            "• Maximaal vijf woorden\n"
            "- max. 15 woorden per zin\n"
            "Hooguit drie zinnen.\n"
            "• Niet meer dan 80 woorden per alinea\n"
            "• Ten hoogste 4 alinea's\n"
            "• Elk argument in één zin\n"
            "• De titel bevat maximaal 5 woorden en geen werkwoord\n"
        )
        self.assertEqual(
            [(r.limit, r.unit, r.per) for r in rules],
            [(5, "woorden", None), (15, "woorden", "zin"), (3, "zinnen", None), (80, "woorden", "alinea"), (4, "alinea's", None)],
        )

    def test_check_whole_text(self):
        rule = LengthRule("Maximaal 5 woorden", 5, "woorden")
        self.assertTrue(check_length_rule(rule, count_text("Aanbesteding bouw parkeergarage provinciehuis")).passes)
        self.assertTrue(check_length_rule(rule, count_text("Subsidietoekenning 4-5 mei comité Flevoland")).passes)
        result = check_length_rule(rule, count_text("Toekennen subsidie 4-5 mei comité Flevoland 2024"))
        self.assertFalse(result.passes)
        self.assertEqual(result.actual, 7)

    def test_check_per_sentence_names_the_long_sentence(self):
        rule = LengthRule("Maximaal 5 woorden per zin", 5, "woorden", "zin")
        result = check_length_rule(rule, count_text("Dit is kort. Deze zin is echt veel te lang voor de regel."))
        self.assertFalse(result.passes)
        self.assertIn('zin 2 ("Deze zin is echt veel te …") telt 10', result.detail)


class CountBlockTests(unittest.TestCase):
    def test_block_gives_counts_and_rule_outcome(self):
        block = count_block("Toekennen subsidie 4-5 mei comité Flevoland 2024", "REGELS\n• Maximaal 5 woorden\n")
        self.assertIn("- Woorden: 7", block)
        self.assertIn("- Zinnen: 1", block)
        self.assertIn('"Maximaal 5 woorden": voldoet NIET (de tekst telt 7 woorden, maximaal 5)', block)

    def test_block_for_a_passing_title(self):
        block = count_block("Aanbesteding bouw parkeergarage provinciehuis", "• Maximaal 5 woorden")
        self.assertIn('"Maximaal 5 woorden": voldoet (de tekst telt 4 woorden, maximaal 5)', block)
        self.assertNotIn("voldoet NIET", block)

    def test_without_paragraphs(self):
        block = count_block("Eerste zin. Tweede zin.", "• Maximaal 2 alinea's\n• Maximaal 3 zinnen", include_paragraphs=False)
        self.assertNotIn("Alinea's:", block)
        self.assertNotIn("Maximaal 2 alinea's", block)
        self.assertIn('"Maximaal 3 zinnen": voldoet', block)

    def test_empty_input_gives_no_block(self):
        self.assertEqual(count_block("  – • ", "• Maximaal 5 woorden"), "")

    def test_long_text_is_bounded(self):
        text = " ".join(f"Zin nummer {i}." for i in range(200))
        block = count_block(text)
        self.assertIn("- Zinnen: 200", block)
        self.assertIn("en nog 160 zinnen", block)


class _Blobs:
    def __init__(self, chapter):
        self.chapter = chapter

    def download_blob(self, name):
        if name.endswith("/hoofdstukken/c1.json"):
            return json.dumps(self.chapter).encode()
        raise FileNotFoundError(name)


class _Agent:
    client = object()
    model = "standaard-model"
    selectable = False

    def __init__(self, answer):
        self.prompts = []
        self.answer = answer

    def available_models(self):
        return None

    def get_agent_response(self, prompt, model=None):
        self.prompts.append(prompt)
        return self.answer


class PromptTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(storage.router, prefix="/api/v1/storage")
        app.dependency_overrides[get_current_user] = lambda: {"id": "u1"}
        self.client = TestClient(app, raise_server_exceptions=False)

    def _prompt(self, assignment, instruction, text):
        agent = _Agent(json.dumps({"Suggesties": []}))
        with mock.patch.object(storage, "azure_storage", _Blobs({assignment: instruction})), mock.patch.object(storage, "ai_agent", agent):
            resp = self.client.post(
                f"/api/v1/storage/generate-agent-response?config_id=cfg&chapter_id=c1&assignment={assignment}",
                json={"user_message": text},
            )
        self.assertEqual(resp.status_code, 200)
        return agent.prompts[0]

    def test_structuur_prompt_carries_the_count(self):
        prompt = self._prompt("agent_structuur", _structuur_instruction(0), "Toekennen subsidie 4-5 mei comité Flevoland 2024")
        self.assertIn("TELLING (berekend door de applicatie", prompt)
        self.assertIn('"Maximaal 5 woorden": voldoet NIET (de tekst telt 7 woorden, maximaal 5)', prompt)
        # the count sits between the answer rules and the input
        self.assertLess(prompt.index("ANTWOORDREGELS"), prompt.index("TELLING"))
        self.assertLess(prompt.index("TELLING"), prompt.index("GEBRUIKER INPUT: Toekennen subsidie"))
        self.assertTrue(prompt.endswith("GEBRUIKER INPUT: Toekennen subsidie 4-5 mei comité Flevoland 2024"))

    def test_b1_prompt_has_words_and_sentences_only(self):
        prompt = self._prompt("agent_b1", "Schrijf op B1-niveau, maximaal 15 woorden per zin.", "Dit is een zin. Nog een zin.")
        self.assertIn("- Zinnen: 2", prompt)
        self.assertNotIn("Alinea's:", prompt)

    def test_spelling_and_woordenlijst_prompts_are_unchanged(self):
        for assignment in ("agent_spelling_grammatica", "agent_woordenlijst"):
            prompt = self._prompt(assignment, "Instructie", "Dit is een zin.")
            self.assertNotIn("TELLING", prompt, assignment)

    def test_nota_title_is_clamped_on_real_words(self):
        agent = _Agent("Subsidie – toekenning 4-5 mei comité Flevoland 2024")
        with mock.patch.object(storage, "ai_agent", agent), mock.patch.object(storage, "_model_for", lambda *a, **k: None):
            resp = self.client.post("/api/v1/storage/generate-nota-title", json={"chapters": [{"title": "T", "content": "x"}]})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {"title": "Subsidie – toekenning 4-5 mei comité"})


if __name__ == "__main__":
    unittest.main()
