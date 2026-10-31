#!/usr/bin/env python3
"""Minimal Azure Blob REST emulator for local development and the test stack.

Azurite is the usual choice; this stand-in needs only the Python standard library. It speaks just enough of
the Blob service REST API (2020+ versions) for `azure-storage-blob` as the backend uses it
(`app/services/azure_storage.py`): create container, list blobs with prefix, put block blob (single PUT, with
`If-Match` / `If-None-Match` and blob metadata), get blob (with range), get properties, delete blob. Authentication
headers are accepted and ignored. Data is persisted under `--data-dir`, so a restart keeps what was written.

It listens on the endpoint of the connection string it is given (`--port`), by default the layout Azurite uses
(`http://127.0.0.1:10000/devstoreaccount1`), so `AZURE_STORAGE_CONNECTION_STRING=UseDevelopmentStorage=true`
works for the default port.
"""
from __future__ import annotations

import argparse
import base64
import email.utils
import hashlib
import json
import os
import re
import sys
import threading
import time
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from xml.sax.saxutils import escape

API_VERSION = "2025-01-05"


class Store:
    """Container -> blob name -> (bytes, properties). Persisted as files under data_dir."""

    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.lock = threading.RLock()
        self.containers: dict[str, dict[str, dict]] = {}
        self._load()

    # -- persistence ---------------------------------------------------------------------
    def _blob_path(self, container: str, name: str) -> Path:
        # Encode the blob name so '/' in names is one file, not a directory tree.
        safe = base64.urlsafe_b64encode(name.encode("utf-8")).decode("ascii")
        return self.data_dir / container / safe

    def _load(self) -> None:
        if not self.data_dir.exists():
            return
        for cdir in self.data_dir.iterdir():
            if not cdir.is_dir():
                continue
            blobs: dict[str, dict] = {}
            for f in cdir.iterdir():
                if f.suffix == ".meta":
                    continue
                meta_f = f.with_suffix(f.suffix + ".meta")
                if not meta_f.exists():
                    continue
                name = base64.urlsafe_b64decode(f.name.encode("ascii")).decode("utf-8")
                meta = json.loads(meta_f.read_text())
                blobs[name] = {"data": f.read_bytes(), **meta}
            self.containers[cdir.name] = blobs

    def _persist(self, container: str, name: str, blob: dict | None) -> None:
        p = self._blob_path(container, name)
        p.parent.mkdir(parents=True, exist_ok=True)
        meta_p = p.with_suffix(p.suffix + ".meta")
        if blob is None:
            p.unlink(missing_ok=True)
            meta_p.unlink(missing_ok=True)
            return
        p.write_bytes(blob["data"])
        meta = {k: v for k, v in blob.items() if k != "data"}
        meta_p.write_text(json.dumps(meta))

    # -- operations ----------------------------------------------------------------------
    def create_container(self, container: str) -> bool:
        with self.lock:
            if container in self.containers:
                return False
            self.containers[container] = {}
            (self.data_dir / container).mkdir(parents=True, exist_ok=True)
            return True

    def has_container(self, container: str) -> bool:
        return container in self.containers

    def put(self, container: str, name: str, data: bytes, content_type: str, metadata: dict | None = None,
            if_match: str | None = None, if_none_match: str | None = None) -> dict | None:
        """Write a blob. `if_match` / `if_none_match` follow the Blob service: the condition is checked and the write
        done under one lock, so two writers with the same ETag cannot both win. Returns None when the condition fails (412)."""
        with self.lock:
            blobs = self.containers[container]
            current = blobs.get(name)
            if if_match is not None:
                if current is None or (if_match != "*" and if_match != current["etag"]):
                    return None
            if if_none_match is not None:
                if current is not None and (if_none_match == "*" or if_none_match == current["etag"]):
                    return None
            now = time.time()
            blob = {
                "metadata": metadata or {},
                "data": data,
                "content_type": content_type or "application/octet-stream",
                "last_modified": now,
                "etag": '"0x' + hashlib.md5(data + str(now).encode() + os.urandom(4)).hexdigest()[:16].upper() + '"',
                "md5": base64.b64encode(hashlib.md5(data).digest()).decode("ascii"),
            }
            blobs[name] = blob
            self._persist(container, name, blob)
            return blob

    def get(self, container: str, name: str) -> dict | None:
        return self.containers.get(container, {}).get(name)

    def delete(self, container: str, name: str) -> bool:
        with self.lock:
            blobs = self.containers.get(container, {})
            if name not in blobs:
                return False
            del blobs[name]
            self._persist(container, name, None)
            return True

    def list(self, container: str, prefix: str) -> list[tuple[str, dict]]:
        with self.lock:
            blobs = self.containers.get(container, {})
            return sorted((n, b) for n, b in blobs.items() if n.startswith(prefix))


def http_date(ts: float) -> str:
    return email.utils.formatdate(ts, usegmt=True)


class Handler(BaseHTTPRequestHandler):
    store: Store
    account: str
    protocol_version = "HTTP/1.1"
    server_version = "blobemu/0.1"

    def log_message(self, fmt, *args):  # quieter log line
        sys.stderr.write("%s %s\n" % (self.command, self.path))

    # -- helpers -------------------------------------------------------------------------
    def _common_headers(self) -> None:
        self.send_header("x-ms-request-id", hashlib.md5(str(time.time()).encode()).hexdigest())
        self.send_header("x-ms-version", API_VERSION)
        self.send_header("Date", http_date(time.time()))

    def _error(self, status: HTTPStatus, code: str, message: str) -> None:
        body = (
            '<?xml version="1.0" encoding="utf-8"?><Error><Code>%s</Code><Message>%s</Message></Error>'
            % (code, escape(message))
        ).encode("utf-8")
        self.send_response(status)
        self._common_headers()
        self.send_header("x-ms-error-code", code)
        self.send_header("Content-Type", "application/xml")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":  # a HEAD answer has the headers only; a body would corrupt the kept-alive connection
            self.wfile.write(body)

    def _parse(self) -> tuple[str | None, str | None, dict[str, str]]:
        u = urllib.parse.urlsplit(self.path)
        parts = [urllib.parse.unquote(p) for p in u.path.split("/") if p]
        if not parts or parts[0] != self.account:
            return None, None, {}
        container = parts[1] if len(parts) > 1 else None
        blob = "/".join(parts[2:]) if len(parts) > 2 else None
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query, keep_blank_values=True).items()}
        return container, blob, q

    def _read_body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    # -- verbs ---------------------------------------------------------------------------
    def do_PUT(self) -> None:
        container, blob, q = self._parse()
        body = self._read_body()
        if container is None:
            return self._error(HTTPStatus.BAD_REQUEST, "InvalidUri", "account mismatch")
        if blob is None:
            if q.get("restype") == "container":
                created = self.store.create_container(container)
                if not created:
                    return self._error(HTTPStatus.CONFLICT, "ContainerAlreadyExists", "exists")
                self.send_response(HTTPStatus.CREATED)
                self._common_headers()
                self.send_header("ETag", '"0x1"')
                self.send_header("Last-Modified", http_date(time.time()))
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            return self._error(HTTPStatus.BAD_REQUEST, "InvalidQueryParameterValue", "unsupported container op")
        if not self.store.has_container(container):
            return self._error(HTTPStatus.NOT_FOUND, "ContainerNotFound", "container missing")
        if "comp" in q and q["comp"] not in ("blocklist",):
            return self._error(HTTPStatus.BAD_REQUEST, "InvalidQueryParameterValue", "unsupported comp=" + q["comp"])
        blob_type = self.headers.get("x-ms-blob-type", "BlockBlob")
        if blob_type != "BlockBlob":
            return self._error(HTTPStatus.BAD_REQUEST, "InvalidHeaderValue", "only BlockBlob")
        metadata = {k[len("x-ms-meta-"):]: v for k, v in self.headers.items() if k.lower().startswith("x-ms-meta-")}
        meta = self.store.put(
            container, blob, body, self.headers.get("x-ms-blob-content-type") or self.headers.get("Content-Type", ""),
            metadata, self.headers.get("If-Match"), self.headers.get("If-None-Match"),
        )
        if meta is None:
            if self.headers.get("If-None-Match") is not None:  # create-only write on an existing blob (as Azure: 409)
                return self._error(HTTPStatus.CONFLICT, "BlobAlreadyExists", "The specified blob already exists.")
            return self._error(HTTPStatus.PRECONDITION_FAILED, "ConditionNotMet", "The condition specified using HTTP conditional header(s) is not met.")
        self.send_response(HTTPStatus.CREATED)
        self._common_headers()
        self.send_header("ETag", meta["etag"])
        self.send_header("Last-Modified", http_date(meta["last_modified"]))
        self.send_header("Content-MD5", meta["md5"])
        self.send_header("x-ms-request-server-encrypted", "true")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_DELETE(self) -> None:
        container, blob, q = self._parse()
        if container is None or blob is None:
            return self._error(HTTPStatus.BAD_REQUEST, "InvalidUri", "blob delete only")
        if not self.store.has_container(container):
            return self._error(HTTPStatus.NOT_FOUND, "ContainerNotFound", "container missing")
        if not self.store.delete(container, blob):
            return self._error(HTTPStatus.NOT_FOUND, "BlobNotFound", "blob missing")
        self.send_response(HTTPStatus.ACCEPTED)
        self._common_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self) -> None:
        self._get(head=True)

    def do_GET(self) -> None:
        self._get(head=False)

    def _get(self, head: bool) -> None:
        container, blob, q = self._parse()
        if container is None:
            return self._error(HTTPStatus.BAD_REQUEST, "InvalidUri", "account mismatch")
        if not self.store.has_container(container):
            return self._error(HTTPStatus.NOT_FOUND, "ContainerNotFound", "container missing")
        if blob is None:
            if q.get("restype") == "container" and q.get("comp") == "list":
                return self._list(container, q)
            if q.get("restype") == "container":
                self.send_response(HTTPStatus.OK)
                self._common_headers()
                self.send_header("ETag", '"0x1"')
                self.send_header("Last-Modified", http_date(time.time()))
                self.send_header("x-ms-lease-status", "unlocked")
                self.send_header("x-ms-lease-state", "available")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            return self._error(HTTPStatus.BAD_REQUEST, "InvalidQueryParameterValue", "unsupported")
        b = self.store.get(container, blob)
        if b is None:
            return self._error(HTTPStatus.NOT_FOUND, "BlobNotFound", "blob missing")
        data: bytes = b["data"]
        total = len(data)
        rng = self.headers.get("x-ms-range") or self.headers.get("Range")
        status = HTTPStatus.OK
        start, end = 0, total - 1
        if rng:
            m = re.match(r"bytes=(\d+)-(\d*)", rng)
            if m and total == 0:
                # Azure answers a range GET on an empty blob with 416; the SDK then re-reads without a range.
                return self._error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE, "InvalidRange", "empty blob")
            if m:
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else total - 1
                end = min(end, total - 1)
                if start > total - 1:
                    return self._error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE, "InvalidRange", "range")
                status = HTTPStatus.PARTIAL_CONTENT
        chunk = data[start : end + 1] if total > 0 else b""
        self.send_response(status)
        self._common_headers()
        self.send_header("ETag", b["etag"])
        self.send_header("Last-Modified", http_date(b["last_modified"]))
        self.send_header("Content-Type", b["content_type"])
        self.send_header("x-ms-blob-type", "BlockBlob")
        self.send_header("x-ms-lease-status", "unlocked")
        self.send_header("x-ms-lease-state", "available")
        self.send_header("x-ms-server-encrypted", "true")
        self.send_header("x-ms-creation-time", http_date(b["last_modified"]))
        self.send_header("Accept-Ranges", "bytes")
        for mk, mv in (b.get("metadata") or {}).items():
            self.send_header("x-ms-meta-" + mk, mv)
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
        else:
            self.send_header("Content-MD5", b["md5"])
        self.send_header("Content-Length", str(len(chunk)))
        self.end_headers()
        if not head:
            self.wfile.write(chunk)

    def _list(self, container: str, q: dict[str, str]) -> None:
        prefix = q.get("prefix", "")
        items = self.store.list(container, prefix)
        xml = ['<?xml version="1.0" encoding="utf-8"?>']
        xml.append(
            '<EnumerationResults ServiceEndpoint="http://%s/" ContainerName="%s">' % (self.headers.get("Host", "127.0.0.1:10000"), escape(container))
        )
        xml.append("<Prefix>%s</Prefix><MaxResults>5000</MaxResults><Blobs>" % escape(prefix))
        for name, b in items:
            xml.append(
                "<Blob><Name>%s</Name><Properties>"
                "<Creation-Time>%s</Creation-Time><Last-Modified>%s</Last-Modified><Etag>%s</Etag>"
                "<Content-Length>%d</Content-Length><Content-Type>%s</Content-Type><Content-MD5>%s</Content-MD5>"
                "<BlobType>BlockBlob</BlobType><LeaseStatus>unlocked</LeaseStatus><LeaseState>available</LeaseState>"
                "<ServerEncrypted>true</ServerEncrypted></Properties><OrMetadata /></Blob>"
                % (
                    escape(name),
                    http_date(b["last_modified"]),
                    http_date(b["last_modified"]),
                    escape(b["etag"]),
                    len(b["data"]),
                    escape(b["content_type"]),
                    b["md5"],
                )
            )
        xml.append("</Blobs><NextMarker /></EnumerationResults>")
        body = "".join(xml).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self._common_headers()
        self.send_header("Content-Type", "application/xml")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=10000)
    ap.add_argument("--account", default="devstoreaccount1")
    ap.add_argument("--data-dir", default=os.environ.get("BLOBEMU_DATA_DIR", "./blobemu-data"))
    args = ap.parse_args()
    Handler.store = Store(Path(args.data_dir))
    Handler.account = args.account
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"blobemu listening on http://{args.host}:{args.port}/{args.account} (data: {args.data_dir})", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
