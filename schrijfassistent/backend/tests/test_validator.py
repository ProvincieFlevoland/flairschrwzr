"""Tests for agent JSON repair and validation."""

import json
import unittest


from app.core.validator import (
    repair_json_str,
    sanitize_json_str,
    validate_agent_response,
)


class TestSanitizeQuotes(unittest.TestCase):
    def test_typographic_double_quotes_become_single(self):
        raw = "\u201chuidige financieringsbehoefte\u201d"
        self.assertEqual(sanitize_json_str(raw), "'huidige financieringsbehoefte'")

    def test_repair_json_with_smart_quotes_inside_string_value(self):
        # Keys use straight "; inner phrase uses Unicode “ ” (must not become raw ")
        payload = (
            '{"Aanleiding": "Algemeen; \u201chuidige financieringsbehoefte\u201d zegt niet.",'
            ' "Suggestie": "Een korte verbetering."}'
        )
        repaired = repair_json_str(payload)
        data = json.loads(repaired)
        self.assertIn("\u201c", payload)
        self.assertNotIn("\u201c", data["Aanleiding"])
        self.assertIn("huidige financieringsbehoefte", data["Aanleiding"])


class TestValidateAgentResponse(unittest.TestCase):
    def test_validate_with_curly_quotes_inside_values(self):
        template = {"Aanleiding": "", "Suggestie": ""}
        # Same failure mode as production: smart quotes inside JSON string values
        response_str = (
            "{\n"
            ' "Aanleiding": "De tekst gebruikt \u201cinvulvelden\u201d en is onduidelijk.",\n'
            ' "Suggestie": "Vervang placeholders door concrete inhoud."\n'
            "}"
        )
        out = validate_agent_response(template, response_str)
        self.assertEqual(
            out["Aanleiding"],
            "De tekst gebruikt 'invulvelden' en is onduidelijk.",
        )
        self.assertIn("Suggestie", out)

    def test_b1_nested_suggesties_list_validates(self):
        """Template uses list placeholder for Suggesties; nested Herschrijvingen is not schema-checked."""
        template = {"Suggesties": []}
        response_str = """{
          "Suggesties": [
            {
              "Origineel": "oud fragment",
              "Herschrijvingen": [
                { "Tekst": "nieuw a", "Uitleg": "B1: korter" },
                { "Tekst": "nieuw b", "Uitleg": "B1: minder formeel" }
              ]
            }
          ]
        }"""
        out = validate_agent_response(template, response_str)
        self.assertIn("Suggesties", out)
        self.assertEqual(len(out["Suggesties"]), 1)
        self.assertEqual(out["Suggesties"][0]["Origineel"], "oud fragment")
        self.assertEqual(len(out["Suggesties"][0]["Herschrijvingen"]), 2)


if __name__ == "__main__":
    unittest.main()
