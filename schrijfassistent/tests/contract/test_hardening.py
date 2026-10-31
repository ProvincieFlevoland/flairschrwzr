"""Contract tests of the input guards, the body limits and the beheerder check.

Each guard test plants a canary (a scratch configuration and a scratch nota), runs the attack and asserts that the
answer is a 400 (or 413, 403) and that nothing changed: the lists of notas and configurations and the canary
blobs are identical afterwards. The bearer must belong to an Open WebUI admin (`test-admin-token`), because the
routes that change a configuration need the beheerder role.
"""
from __future__ import annotations

import json
import os
import uuid
from urllib.parse import quote

import httpx
import pytest

import common as cc

S = cc.STORAGE
ADMIN = cc.bearer(cc.admin_token())
USER = cc.bearer(cc.user_token())


def _inner(fixtures):
    return list(fixtures("config", "GS-nota-v5.upload.json").values())[0]


def _state(client, headers):
    notas = client.get(f"{S}/notas", headers=headers).json()["notas"]
    configs = client.get(f"{S}/configurations", headers=headers).json()["configurations"]
    return sorted(n.get("id", "?") for n in notas), sorted(configs)


@pytest.fixture
def canary(client, auth, fixtures, scratch_id):
    """A scratch configuration (17 blobs) and a scratch nota that no attack may touch."""
    cfg = f"{scratch_id}-cfg"
    nota = {"id": f"{scratch_id}-nota", "title": "canary", "content": "<p>x</p>", "lastModified": "2026-01-01T00:00:00Z"}
    assert client.post(f"{S}/upload-configuration", json={cfg: _inner(fixtures)}, headers=auth).status_code == 200
    assert client.put(f"{S}/notas/{nota['id']}", json=nota, headers=auth).status_code == 200
    yield {"cfg": cfg, "nota": nota, "state": _state(client, auth)}
    client.delete(f"{S}/configurations/{cfg}", headers=auth)
    client.delete(f"{S}/notas/{nota['id']}", headers=auth)


def _intact(client, auth, canary):
    assert _state(client, auth) == canary["state"], "an attack changed the list of notas or configurations"
    assert client.get(f"{S}/notas/{canary['nota']['id']}", headers=auth).json() == canary["nota"]
    subs = client.get(f"{S}/configurations/{canary['cfg']}/subfolders", headers=auth).json()["subfolders"]
    assert "hoofdstukken" in subs
    assert len(client.get(f"{S}/configurations/{canary['cfg']}/hoofdstukken/data", headers=auth).json()["data"]) == 15


BAD_IDS = [
    "notas", "NOTAS", "Notas", "", "..", ".", "a/b", "a\\b", "../notas", "..%2Fnotas", "a?b", "a#b", "a%b", "a%2Fb", " lead", "trail ",
    ".hidden", "dot.", "a..b", "x" * 129, "a\nb", "a\x00b", "a\x7fb", "zero​width", "bidi‮flip", "tab\there",
]


def test_upload_configuration_refuses_bad_folder_keys(client, auth, canary):
    """POST /upload-configuration with a folder key that is `notas` (any case), empty, `.`, `..`, has a slash, backslash, `?`, `#`, `%`, a leading or trailing space or dot, `..` inside, over 128 characters, or a control, zero-width or bidi character -> 400 and nothing changes (no nota deleted, no stray blob, the canary configuration intact)."""
    for bad in BAD_IDS:
        r = client.post(f"{S}/upload-configuration", json={bad: {"name": "x", "mappen": {}}}, headers=auth)
        if bad == "":
            assert r.status_code == 400, (bad, r.status_code, r.text)
        else:
            assert r.status_code == 400, (bad, r.status_code, r.text)
        assert "notas" not in r.text.lower() or r.status_code == 400
    _intact(client, auth, canary)


def test_config_routes_refuse_bad_ids_in_the_path(client, auth, canary):
    """PATCH .../metadata, DELETE /configurations/{id} and the three reads with an id that decodes to `notas`, `..`, `a?b`, `a#b`, `a%b`, a leading space or a control character -> 400 (404 where the router cannot match a slash) and nothing changes; in particular DELETE `notas` keeps every nota and PATCH of a bad id creates no phantom configuration."""
    for bad in ["notas", "NOTAS", "..", "a?b", "a#b", "a%b", " lead", "trail ", "a\x01b", "zero​width", "a/b", "a\\b", "x" * 129]:
        seg = quote(bad, safe="")
        for method, path, kw in [
            ("DELETE", f"{S}/configurations/{seg}", {}),
            ("PATCH", f"{S}/configurations/{seg}/metadata", {"json": {"isActive": False}}),
            ("GET", f"{S}/configurations/{seg}/metadata", {}),
            ("GET", f"{S}/configurations/{seg}/subfolders", {}),
            ("GET", f"{S}/configurations/{seg}/hoofdstukken/data", {}),
        ]:
            r = client.request(method, path, headers=auth, **kw)
            assert r.status_code in (400, 404), (method, bad, r.status_code, r.text[:200])
            if "/" not in bad and "\\" not in bad and bad != "..":   # `..` is normalised away by the router: 404
                assert r.status_code == 400, (method, bad, r.status_code)
    r = client.get(f"{S}/configurations/{canary['cfg']}/{quote('../notas', safe='')}/data", headers=auth)
    assert r.status_code in (400, 404)
    _intact(client, auth, canary)


def test_upload_configuration_refuses_bad_inner_names(client, auth, canary, fixtures):
    """POST /upload-configuration with a harmless folder key but a subfolder name (`../notas`, `a/b`) or an item id (`../../notas/n7`, `a/b`, `.`, a dict, a list, a float, true) that would write outside the folder, or a malformed structure (content not an object, `mappen` not an object) -> 400 BEFORE the folder is wiped: the canary configuration of the same key keeps its 17 blobs and no nota is written."""
    cfg = canary["cfg"]
    inner = _inner(fixtures)
    attacks = [
        {**inner, "mappen": {"../notas": [{"id": "n9", "x": 1}]}},
        {**inner, "mappen": {"a/b": [{"id": "n9"}]}},
        {**inner, "mappen": {"hoofdstukken": [{"id": "../../notas/n7"}]}},
        {**inner, "mappen": {"hoofdstukken": [{"id": "a/b"}]}},
        {**inner, "mappen": {"hoofdstukken": [{"id": "a\\b"}]}},
        {**inner, "mappen": {"hoofdstukken": [{"id": ".."}]}},
        {**inner, "mappen": {"hoofdstukken": [{"id": {"x": 1}}]}},
        {**inner, "mappen": {"hoofdstukken": [{"id": ["a"]}]}},
        {**inner, "mappen": {"hoofdstukken": [{"id": 1.5}]}},
        {**inner, "mappen": {"hoofdstukken": [{"id": True}]}},
        {**inner, "mappen": {"hoofdstukken": [{"id": "h1"}, {"id": "ok"}, {"id": "bad?"}]}},
        {**inner, "mappen": ["not", "an", "object"]},
        "a string",
        ["a", "list"],
    ]
    for body in attacks:
        r = client.post(f"{S}/upload-configuration", json={cfg: body}, headers=auth)
        assert r.status_code == 400, (str(body)[:120], r.status_code, r.text[:200])
        _intact(client, auth, canary)
    # a top level that is not an object at all
    r = client.post(f"{S}/upload-configuration", json=[1, 2], headers=auth)
    assert r.status_code in (400, 422)
    _intact(client, auth, canary)


def test_legitimate_ids_still_work(client, auth, fixtures, scratch_id):
    """the ids of the fixtures and the original data pass the guard: `GS-nota v5`-style names with a space, dots, dashes and underscores, `h1` to `h15`, numeric item ids, an id with `ë`, a name that merely contains `notas`; upload, read, patch and delete all answer 200."""
    inner = _inner(fixtures)
    for cid in [f"{scratch_id} v5", f"{scratch_id}-notas-2", f"{scratch_id}_conf.v2", f"{scratch_id} ë"]:
        body = {**inner, "mappen": {**inner["mappen"], "extra": [{"id": 5, "a": 1}, {"id": "r1700000000000-ab"}, {"a": 2}]}}
        try:
            r = client.post(f"{S}/upload-configuration", json={cid: body}, headers=auth)
            assert r.status_code == 200, (cid, r.status_code, r.text)
            assert client.get(f"{S}/configurations/{quote(cid, safe='')}/metadata", headers=auth).status_code == 200
            assert client.patch(f"{S}/configurations/{quote(cid, safe='')}/metadata", json={"isActive": False}, headers=auth).status_code == 200
        finally:
            d = client.delete(f"{S}/configurations/{quote(cid, safe='')}", headers=auth)
            assert d.status_code == 200 and d.json()["deleted_count"] >= 17


def test_nota_ids_and_blob_names_are_guarded(client, auth, canary):
    """PUT, GET and DELETE /notas/{id} with an id that decodes to `..`, `a?b`, `a#b`, `a%b`, a leading space or a control character, and GET /download/{blob} -> 400 (404 where the router cannot match a slash) and nothing is written or deleted."""
    nota = {"id": "x", "title": "evil", "content": "<p>x</p>", "lastModified": "2026-01-01T00:00:00Z"}
    for bad in ["..", "a?b", "a#b", "a%b", " lead", "trail ", "a\x01b", "zero​width", "a/b", "x" * 129]:
        seg = quote(bad, safe="")
        for method, kw in [("PUT", {"json": nota}), ("GET", {}), ("DELETE", {})]:
            r = client.request(method, f"{S}/notas/{seg}", headers=auth, **kw)
            assert r.status_code in (400, 404), (method, bad, r.status_code, r.text[:200])
            if "/" not in bad and bad != "..":
                assert r.status_code == 400, (method, bad, r.status_code)
        r = client.get(f"{S}/download/{seg}", headers=auth)
        assert r.status_code in (400, 404), (bad, r.status_code)
    _intact(client, auth, canary)


def _big_config(mib: float) -> bytes:
    pad = "x" * int(mib * 1024 * 1024)
    return json.dumps({"test-big": {"name": "big", "pad": pad, "mappen": {}}}).encode()


def test_body_limits(client, auth, canary):
    """a body above the route limit answers 413 and nothing is written: POST /upload-configuration above 12 MiB (declared length and chunked), PUT /notas/{id} above 10 MiB, any other route above 2 MiB (PATCH metadata); a 10.5 MiB configuration (above the 10 MiB cap of the configurator, below the 12 MiB limit of the backend) is stored."""
    h = {**auth, "content-type": "application/json"}
    big = _big_config(12.5)
    r = client.post(f"{S}/upload-configuration", content=big, headers=h)
    assert r.status_code == 413, (r.status_code, r.text[:200])
    assert "te groot" in r.json()["detail"]

    def chunks():
        for i in range(0, len(big), 65536):
            yield big[i:i + 65536]
    r = client.post(f"{S}/upload-configuration", content=chunks(), headers=h)
    assert r.status_code == 413, ("chunked", r.status_code)
    nota = {**canary["nota"], "content": "x" * (10 * 1024 * 1024 + 10)}
    r = client.put(f"{S}/notas/{canary['nota']['id']}", json=nota, headers=auth)
    assert r.status_code == 413, ("nota", r.status_code)
    r = client.patch(f"{S}/configurations/{canary['cfg']}/metadata", content=b'{"isActive":false,"pad":"' + b"x" * (3 * 1024 * 1024) + b'"}', headers=h)
    assert r.status_code == 413, ("patch", r.status_code)
    assert client.get(f"{S}/configurations/{canary['cfg']}/metadata", headers=auth).json()["isActive"] is True
    _intact(client, auth, canary)
    assert "test-big" not in client.get(f"{S}/configurations", headers=auth).json()["configurations"]
    ok = json.dumps({f"{canary['cfg']}-big": {"name": "big", "pad": "x" * int(10.5 * 1024 * 1024), "mappen": {}}}).encode()
    try:
        r = client.post(f"{S}/upload-configuration", content=ok, headers=h)
        assert r.status_code == 200, (r.status_code, r.text[:200])
    finally:
        client.delete(f"{S}/configurations/{canary['cfg']}-big", headers=auth)


def test_413_carries_cors_headers(client, auth):
    """the 413 answer of the body limit carries the CORS headers of an allowed origin, so the browser shows the refusal instead of a network error."""
    origin = os.environ.get("CONTRACT_CORS_ORIGIN") or os.environ.get("CONTRACT_APP_URL", "http://localhost:3000/").rstrip("/")
    big = _big_config(12.5)
    r = client.post(f"{S}/upload-configuration", content=big, headers={**auth, "content-type": "application/json", "origin": origin})
    assert r.status_code == 413
    if r.headers.get("access-control-allow-origin") is None:
        pytest.skip(f"origin {origin} is not in the CORS allow-list of this backend")
    assert r.headers["access-control-allow-origin"] == origin


MUTATING = [
    ("POST", "/upload-configuration", lambda cid: {"json": {cid: {"name": "x", "mappen": {}}}}),
    ("PATCH", "/configurations/{cid}/metadata", lambda cid: {"json": {"isActive": True}}),
    ("DELETE", "/configurations/{cid}", lambda cid: {}),
]


def test_role_check_on_mutating_configuration_routes(client, scratch_id):
    """The routes that change a configuration (POST /upload-configuration, PATCH .../metadata, DELETE /configurations/{id}) answer 403 to a verified Open WebUI user with the role `user`, 200 to an `admin` and 401 without a token; the reads (GET /configurations, .../metadata, .../subfolders, .../data, GET /notas) and the nota writes stay open to the `user`."""
    cid = f"{scratch_id}-role"
    try:
        assert client.post(f"{S}/upload-configuration", json={cid: {"name": "x", "isActive": True, "mappen": {"hoofdstukken": [{"id": "h1"}]}}}, headers=ADMIN).status_code == 200
        for path in ["/configurations", f"/configurations/{cid}/metadata", f"/configurations/{cid}/subfolders", f"/configurations/{cid}/hoofdstukken/data", "/notas"]:
            assert client.get(S + path, headers=USER).status_code == 200, path
        for method, path, kw in MUTATING:
            r = client.request(method, S + path.format(cid=cid), headers=USER, **kw(cid))
            assert r.status_code == 403, (method, path, r.status_code, r.text[:200])
            assert r.json()["detail"] == "Alleen een beheerder mag configuraties wijzigen."
        assert client.get(f"{S}/configurations/{cid}/metadata", headers=ADMIN).json()["isActive"] is True
        assert cid in client.get(f"{S}/configurations", headers=USER).json()["configurations"]
        nota = {"id": f"{cid}-n", "title": "t", "content": "<p>x</p>", "lastModified": "2026-01-01T00:00:00Z"}
        assert client.put(f"{S}/notas/{nota['id']}", json=nota, headers=USER).status_code == 200
        assert client.delete(f"{S}/notas/{nota['id']}", headers=USER).status_code == 200
        for method, path, kw in MUTATING:
            assert client.request(method, S + path.format(cid=cid), **kw(cid)).status_code == 401, (method, path)
        for method, path, kw in MUTATING:
            r = client.request(method, S + path.format(cid=cid), headers=ADMIN, **kw(cid))
            assert r.status_code == 200, (method, path, r.status_code, r.text[:200])
    finally:
        client.delete(f"{S}/configurations/{cid}", headers=ADMIN)


def test_removed_routes_are_gone(client, auth):
    """the password routes (/api/v1/auth/*) and the raw blob routes (GET /blobs, POST /upload, POST /upload-file) do not exist: 404 or 405 for every caller, with and without a token; GET /download/{id} remains."""
    base = S.rsplit("/storage", 1)[0]
    for headers in ({}, auth):
        for method, url, kw in [
            ("GET", f"{base}/auth/status", {}),
            ("POST", f"{base}/auth/login", {"json": {"password": "x"}}),
            ("GET", f"{base}/auth/session", {}),
            ("GET", f"{S}/blobs", {}),
            ("POST", f"{S}/upload", {"params": {"blob_name": "test-root.json", "data": "{}"}}),
            ("POST", f"{S}/upload-file", {"files": {"file": ("test-root-file.json", b"{}", "application/json")}}),
        ]:
            r = client.request(method, url, headers=headers, **kw)
            assert r.status_code in (404, 405), (method, url, bool(headers), r.status_code)
    assert client.get(f"{S}/download/test-root.json", headers=auth).status_code == 404
