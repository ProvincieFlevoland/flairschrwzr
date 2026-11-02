"""Request body size limits per route.

Without a limit a 60 MB item in `POST /upload-configuration` would be accepted. This ASGI middleware answers 413
before a body larger than the route's limit is read: by the `Content-Length` header when there is one, and by counting the bytes
of a chunked body. It sits inside the CORS middleware, so the 413 carries the CORS headers and the browser can read it.

Limits (settings, bytes): configuration upload 12 MiB (the frontend refuses files above 10 MiB; the v5 configuration is 135,647
bytes), nota and AI routes that carry nota text 10 MiB, everything else 2 MiB.
"""
from __future__ import annotations

import json

from app.core.config import settings

_BODY_METHODS = ("POST", "PUT", "PATCH", "DELETE")


def limit_for(path: str) -> int:
    p = path.rstrip("/")
    if p.endswith("/upload-configuration"):
        return settings.MAX_BODY_BYTES_UPLOAD_CONFIGURATION
    if "/notas/" in p or p.endswith("/summarize-nota") or p.endswith("/generate-nota-title"):
        return settings.MAX_BODY_BYTES_NOTA
    return settings.MAX_BODY_BYTES_DEFAULT


class _TooLarge(Exception):
    pass


class BodyLimitMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] not in _BODY_METHODS:
            return await self.app(scope, receive, send)
        limit = limit_for(scope.get("path", ""))
        declared = None
        for name, value in scope.get("headers", []):
            if name == b"content-length":
                try:
                    declared = int(value)
                except ValueError:
                    declared = None
                break
        if declared is not None and declared > limit:
            return await self._refuse(send, limit)

        started = False
        received = 0
        exceeded = False

        async def counting_receive():
            nonlocal received, exceeded
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    exceeded = True
                    raise _TooLarge()
            return message

        async def tracking_send(message):
            # FastAPI turns any exception raised while it reads a body into its own 400 ("error parsing the body"); once the
            # limit was exceeded that answer is replaced by the 413 here, on the way out.
            nonlocal started
            if exceeded:
                if not started:
                    started = True
                    await self._refuse(send, limit)
                return
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, counting_receive, tracking_send)
        except _TooLarge:
            if not started:
                started = True
                await self._refuse(send, limit)

    @staticmethod
    async def _refuse(send, limit):
        body = json.dumps({"detail": f"De aanvraag is te groot (maximaal {limit // (1024 * 1024)} MB voor deze route)."}).encode()
        await send({"type": "http.response.start", "status": 413,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})
