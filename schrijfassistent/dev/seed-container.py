"""Seed only the Compose blob emulator, preserving every existing blob."""
from __future__ import annotations

import json
import os
from pathlib import Path

from azure.core.exceptions import ResourceExistsError
from azure.storage.blob import BlobServiceClient

FIXTURES = Path(__file__).resolve().parent / "fixtures"
LOCAL_ENDPOINT = "http://schrijfassistent-blobstorage-emulator:10000/devstoreaccount1"


def fixture_blobs():
    upload = json.loads((FIXTURES / "config" / "GS-nota-v5.upload.json").read_text(encoding="utf-8"))
    for folder, configuration in upload.items():
        yield f"{folder}/metadata.json", {
            key: value for key, value in configuration.items() if key != "mappen"
        }, None
        for subfolder, items in configuration["mappen"].items():
            for index, item in enumerate(items):
                item_id = item.get("id") if isinstance(item, dict) else None
                yield f"{folder}/{subfolder}/{item_id or index}.json", item, None
    for path in sorted((FIXTURES / "notas").glob("*.json")):
        nota = json.loads(path.read_text(encoding="utf-8"))
        yield f"notas/{nota['id']}.json", nota, {"notalm": nota["lastModified"]}


def main():
    connection = os.environ["AZURE_STORAGE_CONNECTION_STRING"]
    # Never seed an Azure account, even if someone accidentally supplies real credentials.
    if connection != (
        "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;"
        "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSrZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;"
        f"BlobEndpoint={LOCAL_ENDPOINT};"
    ):
        raise RuntimeError("Seeding is restricted to the Compose development emulator.")
    service = BlobServiceClient.from_connection_string(connection)
    container = service.get_container_client(os.environ["AZURE_STORAGE_CONTAINER_NAME"])
    try:
        container.create_container()
    except ResourceExistsError:
        pass
    created = 0
    for name, data, metadata in fixture_blobs():
        try:
            container.upload_blob(
                name, json.dumps(data, ensure_ascii=False, indent=4).encode("utf-8"),
                overwrite=False, metadata=metadata,
            )
        except ResourceExistsError:
            print(f"[seed] preserved {name}", flush=True)
        else:
            created += 1
    print(f"[seed] created {created} fixture blobs; existing data preserved", flush=True)


if __name__ == "__main__":
    main()
