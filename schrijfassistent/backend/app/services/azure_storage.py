from azure.storage.blob import BlobServiceClient
from app.core.config import settings


from app.core.utils import natural_sort_key


class AzureStorageService:
    def __init__(self):
        self.connection_string = settings.AZURE_STORAGE_CONNECTION_STRING
        self.container_name = settings.AZURE_STORAGE_CONTAINER_NAME

        if self.connection_string:
            self.blob_service_client = BlobServiceClient.from_connection_string(
                self.connection_string
            )
            self.container_client = self.blob_service_client.get_container_client(
                self.container_name
            )
        else:
            self.blob_service_client = None
            self.container_client = None

    def list_configurations(self):
        """List all unique configurations (top-level folders) in the container."""
        if not self.container_client:
            return ["Azure Storage Connection String not configured"]

        blobs = self.container_client.list_blobs()
        # Extract the first part of the path (the configuration ID/name)
        configs = set()
        for blob in blobs:
            parts = blob.name.split("/")
            if len(parts) > 1 and parts[0] != "notas":
                configs.add(parts[0])

        return sorted(list(configs), key=natural_sort_key)

    def list_subfolders(self, config_id: str):
        """List subfolders (prefixes) within a specific configuration folder."""
        if not self.container_client:
            return []

        prefix = f"{config_id}/"
        blobs = self.container_client.list_blobs(name_starts_with=prefix)

        subfolders = set()
        for blob in blobs:
            # Remove the config_id/ part
            relative_path = blob.name[len(prefix) :]
            parts = relative_path.split("/")
            if len(parts) > 1:
                subfolders.add(parts[0])

        return sorted(list(subfolders), key=natural_sort_key)

    def get_subfolder_data(self, config_id: str, subfolder: str):
        """Retrieve and aggregate JSON data from all files within a subfolder."""
        if not self.container_client:
            return []

        prefix = f"{config_id}/{subfolder}/"
        blobs = self.container_client.list_blobs(name_starts_with=prefix)

        data = []
        import json

        for blob in sorted(blobs, key=lambda b: natural_sort_key(b.name)):
            if blob.name.endswith(".json"):
                blob_client = self.container_client.get_blob_client(blob)
                blob_data = blob_client.download_blob().readall()
                try:
                    data.append(json.loads(blob_data))
                except json.JSONDecodeError:
                    print(f"Error decoding JSON for blob: {blob.name}")

        return data

    def upload_blob(self, blob_name: str, data: bytes, metadata=None):
        """Upload data to a blob."""
        if not self.blob_service_client:
            raise Exception("Azure Storage Connection String not configured")

        blob_client = self.blob_service_client.get_blob_client(
            container=self.container_name, blob=blob_name
        )
        blob_client.upload_blob(data, overwrite=True, metadata=metadata)
        return f"Successfully uploaded {blob_name}"

    def blob_state(self, blob_name: str):
        """`(etag, metadata)` of a blob from its properties (one HEAD, no body), or None when it does not exist."""
        if not self.blob_service_client:
            raise Exception("Azure Storage Connection String not configured")
        from azure.core.exceptions import ResourceNotFoundError

        blob_client = self.blob_service_client.get_blob_client(
            container=self.container_name, blob=blob_name
        )
        try:
            props = blob_client.get_blob_properties()
        except ResourceNotFoundError:
            return None
        return props.etag, dict(props.metadata or {})

    def download_blob_with_etag(self, blob_name: str):
        """`(bytes, etag)` of one download; the ETag belongs to exactly the bytes returned."""
        if not self.blob_service_client:
            raise Exception("Azure Storage Connection String not configured")

        blob_client = self.blob_service_client.get_blob_client(
            container=self.container_name, blob=blob_name
        )
        stream = blob_client.download_blob()
        data = stream.readall()
        return data, stream.properties.etag

    def upload_blob_if(self, blob_name: str, data: bytes, etag=None, metadata=None):
        """Conditional write (optimistic concurrency). `etag` set: the blob is replaced only when its ETag still
        equals it (`If-Match`); `etag` None: the blob is created only when it does not exist (`If-None-Match: *`).
        Blob refuses a lost race with 412 (or 409 `BlobAlreadyExists` for the create-only form); the SDK raises
        `ResourceModifiedError` / `ResourceExistsError`, which the caller maps to the 409 answer. Returns the new ETag."""
        if not self.blob_service_client:
            raise Exception("Azure Storage Connection String not configured")
        from azure.core import MatchConditions

        blob_client = self.blob_service_client.get_blob_client(
            container=self.container_name, blob=blob_name
        )
        if etag is not None:
            result = blob_client.upload_blob(
                data, overwrite=True, etag=etag, match_condition=MatchConditions.IfNotModified, metadata=metadata
            )
        else:
            result = blob_client.upload_blob(data, overwrite=False, metadata=metadata)
        return result.get("etag")

    def download_blob(self, blob_name: str):
        """Download data from a blob."""
        if not self.blob_service_client:
            raise Exception("Azure Storage Connection String not configured")

        blob_client = self.blob_service_client.get_blob_client(
            container=self.container_name, blob=blob_name
        )
        return blob_client.download_blob().readall()

    def get_blobs_data(self, prefix: str):
        """Retrieve and return JSON data from all .json blobs directly under a given prefix."""
        if not self.container_client:
            return []

        import json as _json
        prefix_with_slash = prefix.rstrip('/') + '/'
        blobs = self.container_client.list_blobs(name_starts_with=prefix_with_slash)

        data = []
        for blob in sorted(blobs, key=lambda b: natural_sort_key(b.name)):
            if blob.name.endswith('.json'):
                blob_client = self.container_client.get_blob_client(blob)
                blob_data = blob_client.download_blob().readall()
                try:
                    data.append(_json.loads(blob_data))
                except _json.JSONDecodeError:
                    print(f"Error decoding JSON for blob: {blob.name}")
        return data

    def check_prefix_exists(self, prefix: str):
        """Check if any blobs exist with the given prefix (simulating a folder existence check)."""
        if not self.container_client:
            return False

        # Ensure prefix ends with a slash if it doesn't already
        if not prefix.endswith("/"):
            prefix += "/"

        blobs = self.container_client.list_blobs(name_starts_with=prefix)
        try:
            next(blobs)
            return True
        except StopIteration:
            return False

    def delete_blob(self, blob_name: str):
        """Delete a blob."""
        if not self.blob_service_client:
            raise Exception("Azure Storage Connection String not configured")

        blob_client = self.blob_service_client.get_blob_client(
            container=self.container_name, blob=blob_name
        )
        blob_client.delete_blob()
        return f"Successfully deleted {blob_name}"

    def delete_blobs_with_prefix(self, prefix: str):
        """Delete all blobs starting with a specific prefix."""
        if not self.container_client:
            return 0

        blobs = self.container_client.list_blobs(name_starts_with=prefix)
        count = 0
        for blob in blobs:
            self.delete_blob(blob.name)
            count += 1
        return count


azure_storage = AzureStorageService()
