import logging

# Logging is configured before the app modules are imported: importing app.api.endpoints.storage creates the AI
# client, and its INFO line ("AI provider <name> initialized (model <model>)") would otherwise be dropped.
# The auth=<kind> lines of app.core.security are INFO; the Azure SDK's per-request logging stays off.
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("azure").setLevel(logging.WARNING)
logging.getLogger("httpx").setLevel(logging.WARNING)

from fastapi import FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from app.api.endpoints import storage  # noqa: E402
from app.core.config import settings  # noqa: E402
from app.core.body_limit import BodyLimitMiddleware  # noqa: E402

# Without a way to verify tokens every request would answer 401: refuse to start instead.
if not settings.OPENWEBUI_INTERNAL_URL.strip():
    raise RuntimeError("OPENWEBUI_INTERNAL_URL is required (token verification).")

# ROOT_PATH is the fallback for a Front Door rule that cannot strip the path prefix:
# with ROOT_PATH=/apps/schrijfassistent the routes answer at /apps/schrijfassistent/api/v1/... too.
# Newer FastAPI versions deprecate the `root_path` parameter in favour of the server's `--root-path`; move it to
# gunicorn.conf.py (UvicornWorker CONFIG_KWARGS) if that warning ever becomes an error.
app = FastAPI(title=settings.PROJECT_NAME, root_path=settings.ROOT_PATH or "")

@app.get("/health")
@app.get("/api/health")
def health_check():
    """Health check endpoint for Azure and monitoring."""
    return {"status": "healthy", "version": "1.1"}

# CORS allow-list: the GovChat origin (env CORS_ALLOW_ORIGINS; the default
# holds the local development origins), a fixed set of request headers, no credentials.
# Request body limits. Added before CORS so that CORS stays the outermost layer and a 413 carries its headers.
app.add_middleware(BodyLimitMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allow_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "X-Nota-Base-Modified", "If-Match", "Content-Type"],
    expose_headers=["ETag"],  # the validator a client may send back as If-Match
)

app.include_router(storage.router, prefix=settings.API_V1_STR + "/storage", tags=["storage"])

# This service serves the API only. The frontend ships as a bundle through the admin image.

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=True)
