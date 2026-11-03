#!/usr/bin/env python3
"""Seeds a running backend with the fixture data (idempotent).

1. ensures the blob container exists (the SDK never creates it, and an emulator starts empty)
2. POST /upload-configuration with fixtures/config/GS-nota-v5.upload.json
   (wipes and rebuilds the `GS-nota v5/` prefix, exactly like the admin's "Opslaan")
3. PUT /notas/{id} for the three fixture notas (WIP, Final-draft, Final)
4. verifies GET /configurations, .../subfolders and GET /notas

Environment: SEED_BASE_URL (default http://localhost:8011), SEED_BEARER (an Open WebUI token with the role
admin, sent as `Authorization: Bearer`; required because every route verifies the token),
AZURE_STORAGE_CONNECTION_STRING (default UseDevelopmentStorage=true), AZURE_STORAGE_CONTAINER_NAME
(default govchat-docs). Run it with the backend venv's python so azure-storage-blob is importable.

`--prune` also deletes every nota that is not one of the three fixtures, so a run that created or changed
notas leaves the fixtures as they were.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent
STORAGE = "/api/v1/storage"


def expected_blobs_for_upload(body: dict) -> list[str]:
    """Blob names that POST /upload-configuration creates for an upload body."""
    folder = list(body.keys())[0]
    cfg = body[folder]
    names = [f"{folder}/metadata.json"]
    for sub, items in cfg.get("mappen", {}).items():
        if not isinstance(items, list):
            continue
        for index, item in enumerate(items):
            item_id = item.get("id") if isinstance(item, dict) else None
            names.append(f"{folder}/{sub}/{item_id}.json" if item_id else f"{folder}/{sub}/{index}.json")
    return names


def ensure_container() -> None:
    from azure.storage.blob import BlobServiceClient
    from azure.core.exceptions import ResourceExistsError

    conn = os.environ.get("AZURE_STORAGE_CONNECTION_STRING", "UseDevelopmentStorage=true")
    name = os.environ.get("AZURE_STORAGE_CONTAINER_NAME", "govchat-docs")
    svc = BlobServiceClient.from_connection_string(conn)
    try:
        svc.create_container(name)
        print(f"[seed] created container {name}")
    except ResourceExistsError:
        print(f"[seed] container {name} exists")


def main() -> int:
    ensure_container()
    upload = json.loads((HERE / "fixtures" / "config" / "GS-nota-v5.upload.json").read_text(encoding="utf-8"))
    config_id = list(upload.keys())[0]
    bearer = os.environ.get("SEED_BEARER", "")
    headers = {"Authorization": f"Bearer {bearer}"} if bearer else {}
    base_url = os.environ.get("SEED_BASE_URL", "http://localhost:8011").rstrip("/")
    with httpx.Client(base_url=base_url, timeout=60, headers=headers) as c:
        r = c.post(f"{STORAGE}/upload-configuration", json=upload)
        r.raise_for_status()
        res = r.json()
        print(f"[seed] upload-configuration: {res['action']} deleted={res['files_deleted']} created={res['files_created']}")
        assert res["files_created"] == len(expected_blobs_for_upload(upload)), res

        for f in sorted((HERE / "fixtures" / "notas").glob("*.json")):
            nota = json.loads(f.read_text(encoding="utf-8"))
            r = c.put(f"{STORAGE}/notas/{nota['id']}", json=nota)
            r.raise_for_status()
            print(f"[seed] nota {nota['id']} ({nota['status']}): {r.json()['blob']}")

        if "--prune" in sys.argv[1:]:
            keep = {json.loads(f.read_text(encoding="utf-8"))["id"] for f in (HERE / "fixtures" / "notas").glob("*.json")}
            for n in c.get(f"{STORAGE}/notas").json()["notas"]:
                if n["id"] not in keep:
                    c.delete(f"{STORAGE}/notas/{n['id']}").raise_for_status()
                    print(f"[seed] pruned nota {n['id']}")

        configs = c.get(f"{STORAGE}/configurations").json()["configurations"]
        subs = c.get(f"{STORAGE}/configurations/{config_id}/subfolders").json()["subfolders"]
        notas = c.get(f"{STORAGE}/notas").json()["notas"]
        print(f"[seed] configurations={configs} subfolders={subs} notas={[n['id'] for n in notas]}")
        assert config_id in configs and set(subs) == {"hoofdstukken", "woordenlijst"}, (configs, subs)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
