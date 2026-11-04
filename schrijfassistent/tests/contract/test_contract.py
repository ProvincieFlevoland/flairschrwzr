"""HTTP contract tests of the Schrijfassistent backend.

The tests run against a started backend (CONTRACT_BASE_URL) with an Open WebUI stand-in that knows the tokens
test-admin-token (role admin) and test-user-token (role user). Recorded AI answers come from dev/fixtures/ai and
are served by dev/mock.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import httpx
import pytest

import common as cc

S = cc.STORAGE
CONFIG_ID = "GS-nota v5"
FIXTURES = Path(cc.__file__).resolve().parents[2] / "dev" / "fixtures"


def agent(client, auth, assignment, user_message, chapter="h2", config_id=CONFIG_ID):
    """POST /generate-agent-response; the message travels in the JSON body."""
    params = {"config_id": config_id, "chapter_id": chapter, "assignment": assignment}
    return client.post(f"{S}/generate-agent-response", params=params, json={"user_message": user_message}, headers=auth)


def h2_text(fixtures) -> str:
    """The block text the recorded AI fixtures were recorded against (fixtures/ai/text/h2.txt)."""
    return (FIXTURES / "ai" / "text" / "h2.txt").read_text(encoding="utf-8")


def read_blob_bytes(blob_name: str) -> bytes | None:
    """Raw blob bytes via azure-storage-blob. CONTRACT_BLOB_CONNECTION_STRING="" skips the check (returns None)."""
    conn = os.environ.get("CONTRACT_BLOB_CONNECTION_STRING", "UseDevelopmentStorage=true")
    if conn == "":
        return None
    from azure.storage.blob import BlobServiceClient

    container = os.environ.get("CONTRACT_BLOB_CONTAINER", "govchat-docs")
    return BlobServiceClient.from_connection_string(conn).get_blob_client(container, blob_name).download_blob().readall()


def mock_log_lines() -> int | None:
    """Number of calls the Open WebUI stand-in has logged, or None when its log is not available."""
    f = os.environ.get("CONTRACT_OPENWEBUI_MOCK_LOG", "")
    if not f or not Path(f).exists():
        return None
    return sum(1 for _ in Path(f).open(encoding="utf-8"))


# ------------------------------------------------------------------------------------------ health
def test_health(client):
    """GET /health returns 200 and {"status":"healthy"}; /api/health is the same handler."""
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "healthy"
    assert client.get("/api/health").json()["status"] == "healthy"


# ------------------------------------------------------------------------------------------ authentication
def test_bearer_token_is_the_only_credential(client, auth):
    """GET /api/v1/storage/notas answers 200 with a verified Open WebUI bearer and 401 without a token, with a legacy X-Access-Token and with an unknown bearer."""
    ok = client.get(f"{S}/notas", headers=auth)
    assert ok.status_code == 200, ok.text
    assert isinstance(ok.json()["notas"], list)
    assert client.get(f"{S}/notas").status_code == 401
    assert client.get(f"{S}/notas", headers={"X-Access-Token": "open"}).status_code == 401
    assert client.get(f"{S}/notas", headers=cc.bearer("not-a-token")).status_code == 401
    assert client.get(f"{S}/notas", headers={"Authorization": "Basic abc"}).status_code == 401


def test_open_webui_token_cookie_is_not_accepted(client):
    """A valid Open WebUI token in the `token` cookie (no Authorization header) is not a credential: 401, and the value is never forwarded to Open WebUI."""
    token = cc.user_token()
    before = mock_log_lines()
    with httpx.Client(base_url=client.base_url, timeout=30, cookies={"token": token}) as c:
        r = c.get(f"{S}/notas")
    assert r.status_code == 401, r.text
    if before is not None:
        assert mock_log_lines() == before, "the cookie value was forwarded to Open WebUI"


def test_rejected_bearer_is_negatively_cached(client, scratch_id):
    """Two requests with the same rejected bearer cause one verification call to Open WebUI (negative cache of a few seconds); both answer 401."""
    before = mock_log_lines()
    if before is None:
        pytest.skip("the call log of the Open WebUI stand-in is not available (CONTRACT_OPENWEBUI_MOCK_LOG)")
    headers = cc.bearer(f"rejected-{scratch_id}")
    assert client.get(f"{S}/notas", headers=headers).status_code == 401
    assert client.get(f"{S}/notas", headers=headers).status_code == 401
    assert mock_log_lines() == before + 1


def test_summarize_nota(client, auth, fixtures):
    """POST /summarize-nota with a three-hoofdstuk body and the mocked chat-agent returns {summary} of at most 3 lines."""
    fx = fixtures("ai", "summary.json")
    chapters = [
        {"title": "Onderwerp", "content": "Parkeergarage onder het provinciehuis"},
        {"title": "Beslispunten", "content": "1. Opdracht te verlenen tot de bouw."},
        {"title": "Kern voorstel", "content": "Dekking uit het Economisch Programma."},
    ]
    r = client.post(f"{S}/summarize-nota", json={"chapters": chapters}, headers=auth)
    assert r.status_code == 200, r.text
    summary = r.json()["summary"]
    assert len(summary.splitlines()) <= 3
    assert summary == fx["expected"]  # the 4th recorded line is clamped away 
    # empty chapter list is a 400 
    assert client.post(f"{S}/summarize-nota", json={"chapters": []}, headers=auth).status_code == 400


def test_agent_response_b1(client, auth, fixtures):
    """POST /generate-agent-response?config_id=GS-nota v5&chapter_id=h2&assignment=agent_b1 with the recorded Suggesties fixture -> 200, ai_response equals the fixture object, validated true."""
    fx = fixtures("ai", "agent_b1.json")
    r = agent(client, auth, "agent_b1", h2_text(fixtures))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["validated"] is True
    assert body["ai_response"] == fx["expected"]
    assert "warning" not in body


def test_agent_response_violates_template(client, auth, fixtures):
    """A model answer that violates the output template answers 500 `Agent communication error: 422: {...}`.

    The route raises HTTPException(422, {error, details, raw_response}) inside its `try`, whose `except Exception`
    re-raises it as 500 with the detail dict stringified. The test pins that answer: the status, the "422:" marker,
    the fixed `error` sentence and the Dutch `details` text.
    """
    fx = fixtures("ai", "agent_b1.violates.json")
    r = agent(client, auth, "agent_b1", h2_text(fixtures) + " [[mock:violates]]")
    assert r.status_code == 500, r.text
    detail = r.json()["detail"]
    assert isinstance(detail, str)
    assert detail.startswith("Agent communication error: 422: ")
    assert fx["expected_detail_error"] in detail
    assert fx["expected_details_contains"] in detail          # Dutch validator message, in `details`
    assert "'raw_response'" in detail and "Analyse" in detail


def test_agent_response_unknown_assignment(client, auth, fixtures):
    """an unknown `assignment` -> 404 naming the assignment; unknown chapter or config -> 404 as well."""
    r = agent(client, auth, "agent_bestaat_niet", "x")
    assert r.status_code == 404, r.text
    assert "agent_bestaat_niet" in r.json()["detail"]
    assert agent(client, auth, "agent_b1", "x", chapter="h99").status_code == 404
    assert agent(client, auth, "agent_b1", "x", config_id="geen-config").status_code == 404


def test_agent_response_typographic_quotes(client, auth, fixtures):
    """same call with typographic quotes in the response -> 200 after repair_json_str (quotes become ASCII ')."""
    fx = fixtures("ai", "agent_b1.typographic.json")
    r = agent(client, auth, "agent_b1", h2_text(fixtures) + " [[mock:typographic]]")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["validated"] is True
    assert body["ai_response"] == fx["expected"]
    assert "“" not in json.dumps(body["ai_response"], ensure_ascii=False)


def test_agent_defaults(client, auth):
    """GET /agent-defaults returns the default spelling instruction that an empty chapter field falls back to."""
    r = client.get(f"{S}/agent-defaults", headers=auth)
    assert r.status_code == 200
    text = r.json()["instructions"]["agent_spelling_grammatica"]
    assert isinstance(text, str) and "spelling" in text


def test_agent_response_spelling_is_unvalidated_text(client, auth, fixtures):
    """agent_spelling_grammatica on the v5 config has an empty output template, so the backend returns the raw model text as a string with validated false."""
    fx = fixtures("ai", "agent_spelling_grammatica.json")
    r = agent(client, auth, "agent_spelling_grammatica", h2_text(fixtures))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["validated"] is False
    assert isinstance(body["ai_response"], str)
    assert json.loads(body["ai_response"]) == fx["parsed"]


def test_agent_response_structuur_h2_template_broken(client, auth, fixtures):
    """the v5 h2 structuur template is not parseable even after repair_json_str, so validation is skipped with a warning and validated false; h3's template is valid and validates."""
    fx2 = fixtures("ai", "agent_structuur.h2.json")
    assert fx2["template_broken_in_v5"] is True
    r = agent(client, auth, "agent_structuur", h2_text(fixtures), chapter="h2")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["validated"] is False
    assert body["warning"] == "Template configuration error; validation skipped."
    assert body["ai_response"] == fx2["expected"]

    fx3 = fixtures("ai", "agent_structuur.h3.json")
    r3 = agent(client, auth, "agent_structuur", "tekst", chapter="h3")
    assert r3.status_code == 200, r3.text
    assert r3.json() == {"ai_response": fx3["expected"], "validated": True}


@pytest.mark.parametrize("assignment,chapter", [
    ("agent_b1", "h2"), ("agent_spelling_grammatica", "h2"), ("agent_woordenlijst", "h2"), ("agent_structuur", "h1"),
])
def test_agent_response_hostile_markup_passes_through(client, auth, fixtures, assignment, chapter):
    """a model answer that carries markup (img onerror, script, svg onload, iframe javascript:, anchor javascript:)
    is returned unchanged by the backend, which is not a filter; the e2e scenario for hostile AI answers checks that the editor and the sidebar neutralise it.
    The fixtures are selected with [[mock:hostile]] and exist for every assignment of the four review flows (structuur only for chapter h1)."""
    fx = fixtures("ai", f"{assignment}.hostile.json")
    r = agent(client, auth, assignment, "Wij verzoeken u dit te accorderen. [[mock:hostile]]", chapter=chapter)
    assert r.status_code == 200, r.text
    body = r.json()
    if assignment == "agent_spelling_grammatica":
        assert body["validated"] is False and body["ai_response"] == fx["expected"]
    else:
        assert body["validated"] is True
        assert body["ai_response"] == fx["expected"]
    text = json.dumps(body["ai_response"], ensure_ascii=False)
    assert "onerror=" in text or "onload=" in text, "the payload reached the client untouched"


def test_agent_response_agent_failure_is_500(client, auth, fixtures):
    """an exception from the agent client surfaces as 500 `Agent communication error: ...` ."""
    r = agent(client, auth, "agent_b1", "x [[mock:error]]")
    assert r.status_code == 500
    assert r.json()["detail"].startswith("Agent communication error:")


def test_generate_nota_title_clamp(client, auth, fixtures):
    """POST /generate-nota-title clamps to 5 words and strips a quote pair (including the opening and closing pair “ ”); empty chapters -> 400."""
    fx = fixtures("ai", "title.json")
    r = client.post(f"{S}/generate-nota-title", json={"chapters": [{"title": "Onderwerp", "content": "Parkeergarage"}]}, headers=auth)
    assert r.status_code == 200, r.text
    title = r.json()["title"]
    assert len(title.split()) <= 5
    assert title == fx["expected"]
    assert client.post(f"{S}/generate-nota-title", json={"chapters": []}, headers=auth).status_code == 400


def test_agent_response_reads_the_body_only(client, auth, fixtures):
    """The message is read from the JSON body: with a message in the query as well the body is used; a query message alone or a body without `user_message` answers 422."""
    params = {"config_id": CONFIG_ID, "chapter_id": "h2", "assignment": "agent_b1"}
    fx = fixtures("ai", "agent_b1.json")
    both = client.post(f"{S}/generate-agent-response", params={**params, "user_message": "x [[mock:error]]"},
                       json={"user_message": h2_text(fixtures)}, headers=auth)
    assert both.status_code == 200, both.text
    assert both.json()["ai_response"] == fx["expected"]
    assert client.post(f"{S}/generate-agent-response", params=params, headers=auth).status_code == 422
    assert client.post(f"{S}/generate-agent-response", params={**params, "user_message": "alleen query"}, headers=auth).status_code == 422
    assert client.post(f"{S}/generate-agent-response", params=params, json={"nope": 1}, headers=auth).status_code == 422


def test_agent_response_long_message_in_body(client, auth):
    """a chapter far above the 8 KB URL limit of Front Door (about 30 KB) is accepted."""
    params = {"config_id": CONFIG_ID, "chapter_id": "h2", "assignment": "agent_spelling_grammatica"}
    r = client.post(f"{S}/generate-agent-response", params=params, json={"user_message": "Wij verzoeken u dit te accorderen. " * 900}, headers=auth)
    assert r.status_code == 200, r.text


def test_storage_500_carries_fixed_dutch_text(client, auth, scratch_id):
    """An unexpected storage failure answers 500 with a fixed Dutch text and no exception text, storage name or id."""
    r = client.delete(f"{S}/notas/{scratch_id}", headers=auth)     # the blob does not exist: delete_blob raises
    assert r.status_code == 500, r.text
    detail = r.json()["detail"]
    assert detail == "Opslaan of ophalen in de opslag is mislukt. Probeer het later opnieuw."
    for leak in ("BlobNotFound", "specified blob", "azure", "ErrorCode", scratch_id):
        assert leak.lower() not in detail.lower()


def test_put_nota_invalid_block_workflow(client, auth, scratch_id):
    """PUT /notas/{id} with blockWorkflow value "foo" -> 400 with the Dutch message; nothing is stored."""
    nota = {"id": scratch_id, "title": "x", "content": "", "blockWorkflow": {"block-h1": "foo"}}
    r = client.put(f"{S}/notas/{scratch_id}", json=nota, headers=auth)
    assert r.status_code == 400, r.text
    assert r.json()["detail"].startswith("Ongeldige blockWorkflow-waarde voor 'block-h1': 'foo'.")
    assert client.get(f"{S}/notas/{scratch_id}", headers=auth).status_code == 404
    # a non-object blockWorkflow is rejected too; the legacy value "ai" is still accepted
    assert client.put(f"{S}/notas/{scratch_id}", json={**nota, "blockWorkflow": "foo"}, headers=auth).status_code == 400
    try:
        ok = client.put(f"{S}/notas/{scratch_id}", json={**nota, "blockWorkflow": {"block-h1": "ai"}}, headers=auth)
        assert ok.status_code == 200 and ok.json() == {"status": "ok", "blob": f"notas/{scratch_id}.json"}
    finally:
        client.delete(f"{S}/notas/{scratch_id}", headers=auth)


def test_put_get_nota_roundtrip_utf8(client, auth, fixtures, scratch_id):
    """PUT then GET /notas/{id} with the v5 fixture nota containing ë, &nbsp; and a reviewer span -> identical JSON on read-back, non-ASCII kept literal (ensure_ascii=False)."""
    nota = dict(fixtures("notas", "nota-wip.json"))
    nota["id"] = scratch_id
    assert "ë" in nota["content"] and "&nbsp;" in nota["content"] and 'class="reviewer-highlight"' in nota["content"]
    try:
        r = client.put(f"{S}/notas/{scratch_id}", json=nota, headers=auth)
        assert r.status_code == 200, r.text
        g = client.get(f"{S}/notas/{scratch_id}", headers=auth)
        assert g.status_code == 200
        assert g.json() == nota
        assert cc.canonical_json(g.json()) == cc.canonical_json(nota)
        raw = g.content.decode("utf-8")
        assert "ë" in raw and "\\u00eb" not in raw           # literal UTF-8, not escaped
        assert "&nbsp;" in raw and "data-note-id=\\\"note-1\\\"" in raw
        # the list endpoint returns the same object
        listed = [n for n in client.get(f"{S}/notas", headers=auth).json()["notas"] if n["id"] == scratch_id]
        assert listed == [nota]
        # Byte-identical: GET /notas/{id} re-parses the blob, so an ensure_ascii=True writer would be
        # invisible through the API . Read the stored bytes from blob storage directly.
        stored = read_blob_bytes(f"notas/{scratch_id}.json")
        if stored is not None:
            assert stored == cc.canonical_json(nota).encode("utf-8")
            assert "ë".encode("utf-8") in stored and b"\\u00eb" not in stored
    finally:
        d = client.delete(f"{S}/notas/{scratch_id}", headers=auth)
        assert d.status_code == 200 and d.json() == {"status": "ok", "deleted": f"notas/{scratch_id}.json"}
    assert client.get(f"{S}/notas/{scratch_id}", headers=auth).status_code == 404


def test_upload_configuration_blob_layout(client, auth, fixtures, scratch_id):
    """POST /upload-configuration with the v5 flat export converted to `mappen` form, then GET .../subfolders and .../hoofdstukken/data -> the blob set and ordering storage.py produces for that input."""
    body = fixtures("config", "GS-nota-v5.upload.json")
    inner = list(body.values())[0]
    upload = {scratch_id: inner}
    expected_blobs = cc.expected_blobs_for_upload(upload)
    try:
        r = client.post(f"{S}/upload-configuration", json=upload, headers=auth)
        assert r.status_code == 200, r.text
        res = r.json()
        assert res["status"] == "success" and res["config_id"] == scratch_id
        assert res["action"] == "created" and res["files_deleted"] == 0
        assert res["files_created"] == len(expected_blobs) == 17

        assert scratch_id in client.get(f"{S}/configurations", headers=auth).json()["configurations"]
        subs = client.get(f"{S}/configurations/{scratch_id}/subfolders", headers=auth).json()["subfolders"]
        assert subs == ["hoofdstukken", "woordenlijst"]   # empty terminologie/regels lists create no blobs

        chapters = client.get(f"{S}/configurations/{scratch_id}/hoofdstukken/data", headers=auth).json()["data"]
        assert [c["id"] for c in chapters] == [f"h{i}" for i in range(1, 16)]   # natural order h1..h15
        assert chapters == inner["mappen"]["hoofdstukken"]
        assert client.get(f"{S}/configurations/{scratch_id}/woordenlijst/data", headers=auth).json()["data"] == ["Hallo"]

        meta = client.get(f"{S}/configurations/{scratch_id}/metadata", headers=auth).json()
        assert meta == {k: v for k, v in inner.items() if k != "mappen"}

        # Reconstruct the blob set from what the API exposes and compare with the expectation.
        reconstructed = [f"{scratch_id}/metadata.json"] + [f"{scratch_id}/hoofdstukken/{c['id']}.json" for c in chapters] + [f"{scratch_id}/woordenlijst/{i}.json" for i in range(len(inner["mappen"]["woordenlijst"]))]
        assert sorted(reconstructed) == sorted(expected_blobs)

        # Re-upload is a wipe-and-rebuild: action "rebuilt", 17 deleted, 17 created.
        again = client.post(f"{S}/upload-configuration", json=upload, headers=auth).json()
        assert (again["action"], again["files_deleted"], again["files_created"]) == ("rebuilt", 17, 17)
    finally:
        d = client.delete(f"{S}/configurations/{scratch_id}", headers=auth)
        assert d.status_code == 200 and d.json()["deleted_count"] == 17
    assert scratch_id not in client.get(f"{S}/configurations", headers=auth).json()["configurations"]


def test_patch_metadata_is_active(client, auth, fixtures, scratch_id):
    """PATCH .../metadata {isActive:false} then GET /configurations/{id}/metadata -> isActive false, other fields unchanged."""
    inner = list(fixtures("config", "GS-nota-v5.upload.json").values())[0]
    try:
        assert client.post(f"{S}/upload-configuration", json={scratch_id: inner}, headers=auth).status_code == 200
        before = client.get(f"{S}/configurations/{scratch_id}/metadata", headers=auth).json()
        assert before["isActive"] is True
        p = client.patch(f"{S}/configurations/{scratch_id}/metadata", json={"isActive": False}, headers=auth)
        assert p.status_code == 200, p.text
        assert p.json()["status"] == "success" and p.json()["metadata"]["isActive"] is False
        after = client.get(f"{S}/configurations/{scratch_id}/metadata", headers=auth).json()
        assert after["isActive"] is False
        assert {k: v for k, v in after.items() if k != "isActive"} == {k: v for k, v in before.items() if k != "isActive"}
        # body validation: a non-boolean is a 422 from pydantic
        assert client.patch(f"{S}/configurations/{scratch_id}/metadata", json={"isActive": "nee"}, headers=auth).status_code == 422
    finally:
        client.delete(f"{S}/configurations/{scratch_id}", headers=auth)
    assert client.get(f"{S}/configurations/{scratch_id}/metadata", headers=auth).status_code == 404


def _two_saves(client, auth, nota_id):
    base = {"id": nota_id, "title": "conflict", "content": "<p>a</p>", "lastModified": "2026-10-24T08:00:00.000Z"}
    assert client.put(f"{S}/notas/{nota_id}", json=base, headers=auth).status_code == 200
    newer = {**base, "content": "<p>b (other client)</p>", "lastModified": "2026-10-24T08:05:00.000Z"}
    assert client.put(f"{S}/notas/{nota_id}", json=newer, headers=auth).status_code == 200
    return base, newer


def test_put_nota_stale_base_header_conflict(client, auth, scratch_id):
    """PUT /notas/{id} with X-Nota-Base-Modified set to the lastModified the nota was loaded with, after another client saved a newer version -> 409."""
    try:
        base, newer = _two_saves(client, auth, scratch_id)
        stale = {**base, "content": "<p>c (stale client)</p>", "lastModified": "2026-10-24T08:06:00.000Z"}
        r = client.put(f"{S}/notas/{scratch_id}", json=stale, headers={**auth, "X-Nota-Base-Modified": base["lastModified"]})
        assert r.status_code == 409, r.text
        detail = r.json()["detail"]
        assert detail["error"] == "conflict"
        assert detail["stored_last_modified"] == newer["lastModified"]
        assert detail["base_last_modified"] == base["lastModified"]
        assert isinstance(detail["message"], str) and detail["message"]
        assert client.get(f"{S}/notas/{scratch_id}", headers=auth).json()["content"] == newer["content"]
    finally:
        client.delete(f"{S}/notas/{scratch_id}", headers=auth)


def test_put_nota_without_base_header_last_write_wins(client, auth, scratch_id):
    """the same stale PUT without the header -> 200, (last write wins without the header)."""
    try:
        base, newer = _two_saves(client, auth, scratch_id)
        stale = {**base, "content": "<p>c (stale client)</p>", "lastModified": "2026-10-24T08:06:00.000Z"}
        r = client.put(f"{S}/notas/{scratch_id}", json=stale, headers=auth)
        assert r.status_code == 200, r.text
        assert client.get(f"{S}/notas/{scratch_id}", headers=auth).json()["content"] == stale["content"]
    finally:
        client.delete(f"{S}/notas/{scratch_id}", headers=auth)


def test_put_nota_matching_base_header_is_accepted(client, auth, scratch_id):
    """PUT /notas/{id} with X-Nota-Base-Modified equal to the stored lastModified -> 200 and the content is replaced (the path every autosave takes)."""
    try:
        base, newer = _two_saves(client, auth, scratch_id)
        fresh = {**newer, "content": "<p>c (fresh client)</p>", "lastModified": "2026-10-24T08:10:00.000Z"}
        r = client.put(f"{S}/notas/{scratch_id}", json=fresh, headers={**auth, "X-Nota-Base-Modified": newer["lastModified"]})
        assert r.status_code == 200, r.text
        assert client.get(f"{S}/notas/{scratch_id}", headers=auth).json()["content"] == fresh["content"]
        # the new stored lastModified is the next base
        r2 = client.put(f"{S}/notas/{scratch_id}", json={**fresh, "content": "<p>d</p>"}, headers={**auth, "X-Nota-Base-Modified": fresh["lastModified"]})
        assert r2.status_code == 200, r2.text
    finally:
        client.delete(f"{S}/notas/{scratch_id}", headers=auth)


def test_put_nota_first_save_with_base_header_is_accepted(client, auth, scratch_id):
    """the first save of a nota (no stored blob) with X-Nota-Base-Modified set -> 200."""
    try:
        nota = {"id": scratch_id, "title": "first", "content": "<p>a</p>", "lastModified": "2026-10-24T08:00:00.000Z"}
        r = client.put(f"{S}/notas/{scratch_id}", json=nota, headers={**auth, "X-Nota-Base-Modified": "2026-10-23T00:00:00.000Z"})
        assert r.status_code == 200, r.text
        assert client.get(f"{S}/notas/{scratch_id}", headers=auth).json() == nota
    finally:
        client.delete(f"{S}/notas/{scratch_id}", headers=auth)


def test_put_nota_etag_validator(client, auth, scratch_id):
    """GET /notas/{id} and PUT answer an `ETag` header; `If-Match` with the current ETag -> 200 and a new ETag; with the previous (stale) ETag -> 409 with the same body keys as the conflict above and nothing written."""
    try:
        nota = {"id": scratch_id, "title": "etag", "content": "<p>a</p>", "lastModified": "2026-10-24T08:00:00.000Z"}
        first = client.put(f"{S}/notas/{scratch_id}", json=nota, headers=auth)
        assert first.status_code == 200, first.text
        etag1 = client.get(f"{S}/notas/{scratch_id}", headers=auth).headers.get("etag")
        assert etag1
        n2 = {**nota, "content": "<p>b</p>", "lastModified": "2026-10-24T08:05:00.000Z"}
        ok = client.put(f"{S}/notas/{scratch_id}", json=n2, headers={**auth, "If-Match": etag1})
        assert ok.status_code == 200, ok.text
        etag2 = ok.headers.get("etag")
        assert etag2 and etag2 != etag1
        assert client.get(f"{S}/notas/{scratch_id}", headers=auth).headers.get("etag") == etag2
        stale = client.put(f"{S}/notas/{scratch_id}", json={**nota, "content": "<p>c</p>"}, headers={**auth, "If-Match": etag1})
        assert stale.status_code == 409, stale.text
        detail = stale.json()["detail"]
        assert detail["error"] == "conflict" and detail["stored_last_modified"] == n2["lastModified"]
        assert client.get(f"{S}/notas/{scratch_id}", headers=auth).json()["content"] == n2["content"]
    finally:
        client.delete(f"{S}/notas/{scratch_id}", headers=auth)


def test_put_nota_concurrent_same_base_exactly_one_wins(client, auth, scratch_id):
    """eight saves with the same X-Nota-Base-Modified sent at once -> exactly one 200, the other seven 409; the stored nota is the winner's."""
    from concurrent.futures import ThreadPoolExecutor

    try:
        base = {"id": scratch_id, "title": "race", "content": "<p>a</p>", "lastModified": "2026-10-24T08:00:00.000Z"}
        assert client.put(f"{S}/notas/{scratch_id}", json=base, headers=auth).status_code == 200

        def save(i):
            body = {**base, "content": f"<p>writer {i}</p>", "lastModified": f"2026-10-24T08:0{i}:00.000Z"}
            r = client.put(f"{S}/notas/{scratch_id}", json=body, headers={**auth, "X-Nota-Base-Modified": base["lastModified"]})
            return i, r.status_code

        with ThreadPoolExecutor(8) as pool:
            results = list(pool.map(save, range(1, 9)))
        winners = [i for i, st in results if st == 200]
        assert sorted(st for _, st in results) == [200] + [409] * 7, results
        assert client.get(f"{S}/notas/{scratch_id}", headers=auth).json()["content"] == f"<p>writer {winners[0]}</p>"
    finally:
        client.delete(f"{S}/notas/{scratch_id}", headers=auth)
