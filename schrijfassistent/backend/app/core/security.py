"""Request identity for the storage routes.

`get_current_user` is a FastAPI dependency applied to every `/api/v1/storage/*` route. The only
accepted credential is an Open WebUI token as `Authorization: Bearer <token>` (bearer only; the `token`
cookie is not accepted). It is forwarded to `{OPENWEBUI_INTERNAL_URL}/api/v1/auths/`
with a shared non-blocking `httpx.AsyncClient`. A positive answer is cached for 60 seconds keyed by
the sha256 of the token and yields {id, email, name, role, auth: "openwebui"}. Every other request
answers 401 and logs `auth=denied`.

Cache notes. A positive entry lives 60 s, so a token revoked in Open WebUI keeps working for up
to 60 s per worker (accepted). A negative entry (401, any other status, an error or an
unexpected body) lives NEGATIVE_TTL_SEC so a bad token or an unreachable Open WebUI costs one
round trip per window, not one per request. Both live in one bounded LRU (OrderedDict).

Logging: one line per request, `auth=<kind>` plus the route template. Never the token,
never a header value, never a body.
"""
from __future__ import annotations

import hashlib
import logging
import threading
import time
from collections import OrderedDict
from typing import Any, Dict, Optional

import httpx
from fastapi import Depends, Header, HTTPException, Request

from app.core.config import settings

logger = logging.getLogger(__name__)

CACHE_TTL_SEC = 60.0
NEGATIVE_TTL_SEC = 8.0
CACHE_MAX_ENTRIES = 10000
_OPENWEBUI_AUTHS_PATH = "/api/v1/auths/"

# token sha256 -> (expires_at, user | None); None is a negative entry. Most recently used last.
_cache: "OrderedDict[str, tuple]" = OrderedDict()
_cache_lock = threading.Lock()
_client: Optional[httpx.AsyncClient] = None


def _token_key(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _cache_lookup(key: str):
    """Returns (hit, user). A hit with user None is a negative entry."""
    now = time.monotonic()
    with _cache_lock:
        entry = _cache.get(key)
        if entry is None:
            return False, None
        expires_at, user = entry
        if expires_at <= now:
            del _cache[key]
            return False, None
        _cache.move_to_end(key)
        return True, user


def _cache_store(key: str, user: Optional[Dict[str, Any]], ttl: float) -> None:
    now = time.monotonic()
    with _cache_lock:
        _cache[key] = (now + ttl, user)
        _cache.move_to_end(key)
        # SAFETY: bounded cache. Expired entries go first, then the least recently used one, so a
        # flood of distinct tokens cannot grow memory and never drops every live session at once.
        if len(_cache) > CACHE_MAX_ENTRIES:
            for k in [k for k, (exp, _) in _cache.items() if exp <= now][:CACHE_MAX_ENTRIES // 10 + 1]:
                _cache.pop(k, None)
            while len(_cache) > CACHE_MAX_ENTRIES:
                _cache.popitem(last=False)


def clear_cache() -> None:
    """Test hook."""
    with _cache_lock:
        _cache.clear()


def _get_client() -> httpx.AsyncClient:
    """One lazily created client per process: connection reuse, no blocking of the event loop.
    The timeout is per phase in httpx (connect, read, write, pool), so the wall-clock bound of
    one verification is up to about twice OPENWEBUI_VERIFY_TIMEOUT_SEC."""
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            timeout=settings.OPENWEBUI_VERIFY_TIMEOUT_SEC,
            limits=httpx.Limits(max_connections=20),
            follow_redirects=False,
        )
    return _client


def _user_from_openwebui(payload: Any) -> Optional[Dict[str, Any]]:
    """Shape of GET /api/v1/auths/ (open_webui/routers/auths.py): id, email, name, role, ..."""
    if not isinstance(payload, dict) or not payload.get("id"):
        return None
    return {
        "id": str(payload.get("id")),
        "email": payload.get("email") or "",
        "name": payload.get("name") or "",
        "role": payload.get("role") or "",
        "auth": "openwebui",
    }


async def verify_openwebui_token(token: str) -> Optional[Dict[str, Any]]:
    """Forward the token to Open WebUI. Returns the user, or None when Open WebUI rejects it,
    is unreachable, is not configured, or answers something unexpected (all logged, none raised)."""
    base = settings.OPENWEBUI_INTERNAL_URL.strip().rstrip("/")
    if not base:
        logger.warning("auth=openwebui-skipped reason=OPENWEBUI_INTERNAL_URL not set")
        return None
    key = _token_key(token)
    hit, cached = _cache_lookup(key)
    if hit:
        return cached
    try:
        r = await _get_client().get(
            base + _OPENWEBUI_AUTHS_PATH,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        )
    except httpx.HTTPError as e:
        logger.warning("auth=openwebui-error reason=%s", type(e).__name__)
        _cache_store(key, None, NEGATIVE_TTL_SEC)
        return None
    if r.status_code != 200:
        logger.info("auth=openwebui-rejected status=%s", r.status_code)
        _cache_store(key, None, NEGATIVE_TTL_SEC)
        return None
    try:
        user = _user_from_openwebui(r.json())
    except ValueError:
        user = None
    if user is None:
        logger.warning("auth=openwebui-error reason=unexpected body")
        _cache_store(key, None, NEGATIVE_TTL_SEC)
        return None
    _cache_store(key, user, CACHE_TTL_SEC)
    return user


def _bearer_from_header(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    scheme, _, value = authorization.partition(" ")
    if scheme.lower() != "bearer" or not value.strip():
        return None
    return value.strip()


def _route_label(request: Request) -> str:
    route = request.scope.get("route")
    path = getattr(route, "path", None) or request.url.path
    return f"{request.method} {path}"


async def get_current_user(
    request: Request,
    authorization: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    route = _route_label(request)
    token = _bearer_from_header(authorization)
    if token:
        user = await verify_openwebui_token(token)
        if user is not None:
            logger.info("auth=openwebui user_id=%s route=%s", user["id"], route)
            return user
    logger.info("auth=denied route=%s", route)
    raise HTTPException(status_code=401, detail="Niet ingelogd.")


def _is_beheerder(user: Dict[str, Any]) -> bool:
    """Open WebUI `admin` maps to `beheerder` (the same normalisation as identityAdapter.js)."""
    return user.get("auth") == "openwebui" and str(user.get("role") or "").strip().lower() == "admin"


async def require_beheerder(
    request: Request,
    user: Dict[str, Any] = Depends(get_current_user),
) -> Dict[str, Any]:
    """Dependency of the routes that change a configuration: upload-configuration, delete
    configuration and config metadata PATCH. 403 unless the verified Open WebUI user has the role `admin`.
    Reads of the configurations and the nota routes stay open to every authenticated user."""
    if _is_beheerder(user):
        return user
    logger.warning("role-check=denied auth=%s user_id=%s role=%r route=%s", user.get("auth"), user.get("id"), user.get("role"), _route_label(request))
    raise HTTPException(status_code=403, detail="Alleen een beheerder mag configuraties wijzigen.")
