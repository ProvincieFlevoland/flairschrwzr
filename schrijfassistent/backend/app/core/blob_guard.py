"""One central guard for every value that becomes part of a blob name.

The storage routes build blob names from request values: `<config_id>/metadata.json`, `<folder>/<subfolder>/<item id>.json`,
`notas/<nota_id>.json`, the `blob_name` and the file name of the raw upload routes. Used as they come, a key such as `notas` or `../notas`, an item id such as `../../notas/n7` or a blob name with a slash reached
other prefixes (one request deleted every nota). `check_segment` accepts only one path segment made of what legitimate ids
contain (letters, digits, `_`, space, `.` and `-`: `GS-nota v5`, `h1` to `h15`, `r<ms>`, `n<ms>`, `conf-<ms>`, `nj3-...`), and
refuses everything else with a 400 before any blob call: empty or untrimmed values, over 128 characters, `.` and `..` (and any
value containing `..`), a leading or trailing dot or space, any path separator, backslash, `?`, `#`, `%`, control, zero-width and
bidi characters (they are not word characters), and, for a configuration id, the reserved top-level folder `notas`.

The guard raises `HTTPException(400)`. Callers run it BEFORE the `try:` of the route: the routes wrap their work in
`except Exception`, which would turn a 400 raised inside into a 500. The frontend mirrors the rule (`validateConfigId`).
"""
from __future__ import annotations

import re
from typing import Any

from fastapi import HTTPException

MAX_SEGMENT_LENGTH = 128
RESERVED_CONFIG_IDS = ("notas",)
# `\w` is the Unicode word class (letters, digits, underscore): `ë` in a name stays legal, zero-width and bidi marks do not.
_SEGMENT = re.compile(r"[\w .\-]+")


def segment_problem(value: Any, *, reserved: bool = False) -> str | None:
    """Why `value` cannot be a blob path segment, or None when it can."""
    if not isinstance(value, str):
        return "geen tekst"
    if value == "":
        return "leeg"
    if value != value.strip():
        return "begint of eindigt met een spatie"
    if len(value) > MAX_SEGMENT_LENGTH:
        return f"langer dan {MAX_SEGMENT_LENGTH} tekens"
    if value in (".", "..") or ".." in value:
        return "bevat '..'"
    if value.startswith(".") or value.endswith("."):
        return "begint of eindigt met een punt"
    if _SEGMENT.fullmatch(value) is None:
        return "bevat een teken dat niet is toegestaan (alleen letters, cijfers, spatie, punt, streepje en underscore)"
    if reserved and value.lower() in RESERVED_CONFIG_IDS:
        return "is gereserveerd"
    return None


def check_segment(value: Any, what: str, *, reserved: bool = False) -> str:
    """Returns `value` when it is a safe segment, else raises HTTPException(400). Never echoes the value."""
    problem = segment_problem(value, reserved=reserved)
    if problem is not None:
        raise HTTPException(status_code=400, detail=f"Ongeldig(e) {what}: {problem}.")
    return value


def check_config_id(value: Any, what: str = "configuratie-id") -> str:
    return check_segment(value, what, reserved=True)


def check_item_id(value: Any, what: str = "item-id") -> str:
    """An item id of an upload: text, or a plain integer (stored as `5.json` for `id: 5`); a bool, float, list or
    object is refused."""
    if isinstance(value, int) and not isinstance(value, bool):
        value = str(value)
    return check_segment(value, what)


def check_upload_configuration(data: Any) -> None:
    """Validates the whole body of POST /upload-configuration before anything is deleted or written: the folder key, every
    `mappen` key and every item id. A malformed structure (not an object, `mappen` not an object) is a 400 too."""
    if not data:
        return  # the empty body keeps its original answer inside the route
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="Ongeldige configuratie: verwacht een JSON-object.")
    folder = next(iter(data.keys()))
    check_config_id(folder, "configuratie-id")
    config_data = data[folder]
    if not isinstance(config_data, dict):
        raise HTTPException(status_code=400, detail="Ongeldige configuratie: de inhoud is geen JSON-object.")
    mappen = config_data.get("mappen", {})
    if not isinstance(mappen, dict):
        raise HTTPException(status_code=400, detail="Ongeldige configuratie: 'mappen' is geen JSON-object.")
    for subfolder, items in mappen.items():
        check_segment(subfolder, "mapnaam")
        if not isinstance(items, list):
            continue
        for item in items:
            if isinstance(item, dict) and item.get("id"):
                check_item_id(item.get("id"), "item-id")
