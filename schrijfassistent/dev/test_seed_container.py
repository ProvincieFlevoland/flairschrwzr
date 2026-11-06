import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from azure.core.exceptions import ResourceExistsError

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("seed_container", HERE / "seed-container.py")
seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)

CONNECTION = (
    "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;"
    "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSrZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;"
    f"BlobEndpoint={seed.LOCAL_ENDPOINT};"
)


class SeedContainerTest(unittest.TestCase):
    def test_fixture_shape_matches_configuration_and_nota_metadata(self):
        blobs = list(seed.fixture_blobs())
        expected = json.loads((HERE / "fixtures/config/GS-nota-v5.expected-blobs.json").read_text())
        self.assertEqual([name for name, _, _ in blobs if not name.startswith("notas/")], expected)
        notas = [(data, metadata) for name, data, metadata in blobs if name.startswith("notas/")]
        self.assertEqual(len(notas), 3)
        for nota, metadata in notas:
            self.assertEqual(metadata, {"notalm": nota["lastModified"]})

    def test_refuses_nonlocal_storage_before_creating_client(self):
        for connection in ("UseDevelopmentStorage=true", CONNECTION + "AccountKey=other;"):
            with self.subTest(connection=connection):
                with patch.dict(os.environ, {"AZURE_STORAGE_CONNECTION_STRING": connection}):
                    with patch.object(seed, "BlobServiceClient") as client:
                        with self.assertRaisesRegex(RuntimeError, "restricted"):
                            seed.main()
                        client.from_connection_string.assert_not_called()

    def test_existing_blobs_are_preserved_and_missing_blobs_are_created(self):
        stored = {}

        def upload(name, data, *, overwrite, metadata):
            self.assertFalse(overwrite)
            if name in stored:
                raise ResourceExistsError("exists")
            stored[name] = (data, metadata)

        with patch.dict(os.environ, {
            "AZURE_STORAGE_CONNECTION_STRING": CONNECTION,
            "AZURE_STORAGE_CONTAINER_NAME": "govchat-docs",
        }):
            with patch.object(seed, "BlobServiceClient") as client:
                container = client.from_connection_string.return_value.get_container_client.return_value
                container.upload_blob.side_effect = upload
                seed.main()
                self.assertEqual(len(stored), 20)
                name = next(iter(stored))
                stored[name] = (b'{"edited":true}', None)
                before = dict(stored)
                container.create_container.side_effect = ResourceExistsError("exists")
                seed.main()
                self.assertEqual(stored, before)
                del stored[name]
                seed.main()
                self.assertEqual(len(stored), 20)


if __name__ == "__main__":
    unittest.main()
