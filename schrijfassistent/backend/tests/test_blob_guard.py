"""Unit tests of app/core/blob_guard.py. No storage, no network."""
from __future__ import annotations

import unittest

from fastapi import HTTPException

from app.core.blob_guard import (
    check_config_id, check_item_id, check_segment, check_upload_configuration, segment_problem,
)

LEGIT = ["GS-nota v5", "GS-nota v4", "h1", "h15", "r1700000000000", "r1-1700000000000", "n1760000000001", "conf-1700000000000",
         "nj3-1793134171449-1", "test-0f67eda4b64d", "mijn notas", "notas-2", "a.b", "a_b", "Ë", "x" * 128]
BAD = ["", " ", " a", "a ", ".", "..", "a..b", ".a", "a.", "a/b", "a\\b", "../notas", "a?b", "a#b", "a%b", "a%2Fb", "a\nb", "a\x00b", "a\x7fb",
       "zero​width", "bidi‮flip", "a b", "x" * 129, "a:b", "a*b", 'a"b', "a<b", "a|b", None, 5, ["a"], {"a": 1}, True]


class SegmentTests(unittest.TestCase):
    def test_legitimate_ids_pass(self):
        for v in LEGIT:
            self.assertIsNone(segment_problem(v), v)
            self.assertEqual(check_segment(v, "x"), v)

    def test_bad_values_are_refused_with_400(self):
        for v in BAD:
            self.assertIsNotNone(segment_problem(v), repr(v))
            with self.assertRaises(HTTPException) as cm:
                check_segment(v, "id")
            self.assertEqual(cm.exception.status_code, 400)
            if isinstance(v, str) and len(v) > 3:
                self.assertNotIn(v, str(cm.exception.detail), "the value is never echoed")

    def test_reserved_config_id(self):
        for v in ["notas", "NOTAS", "Notas"]:
            with self.assertRaises(HTTPException):
                check_config_id(v)
        self.assertEqual(check_config_id("notas-x"), "notas-x")
        self.assertEqual(check_segment("notas", "subfolder"), "notas", "only a configuration id is reserved")

    def test_item_id_accepts_text_and_plain_integers(self):
        self.assertEqual(check_item_id("h1"), "h1")
        self.assertEqual(check_item_id(5), "5")
        for v in [True, 1.5, ["a"], {"a": 1}, None, "../x"]:
            with self.assertRaises(HTTPException):
                check_item_id(v)


class UploadBodyTests(unittest.TestCase):
    def ok(self, body):
        check_upload_configuration(body)

    def refused(self, body):
        with self.assertRaises(HTTPException) as cm:
            check_upload_configuration(body)
        self.assertEqual(cm.exception.status_code, 400)

    def test_empty_body_is_left_to_the_route(self):
        self.ok({})

    def test_v5_shape_passes(self):
        self.ok({"GS-nota v5": {"name": "x", "mappen": {"hoofdstukken": [{"id": "h1"}, {"id": "h2"}], "regels": [], "woordenlijst": ["Hallo", {"a": 1}]}}})
        self.ok({"c": {"name": "x", "mappen": {"s": [{"id": 5}, {"a": 1}, "text", None]}}})
        self.ok({"c": {"name": "x"}})

    def test_attacks(self):
        self.refused({"notas": {"name": "x"}})
        self.refused({"": {"name": "x"}})
        self.refused({"../x": {"name": "x"}})
        self.refused({"c": {"mappen": {"../notas": [{"id": "n9"}]}}})
        self.refused({"c": {"mappen": {"s": [{"id": "../../notas/n7"}]}}})
        self.refused({"c": {"mappen": {"s": [{"id": {"a": 1}}]}}})
        self.refused({"c": {"mappen": ["a"]}})
        self.refused({"c": "text"})
        self.refused({"c": ["a"]})
        self.refused(["a"])
        self.refused("text")


if __name__ == "__main__":
    unittest.main()
