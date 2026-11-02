# gunicorn settings of the Schrijfassistent backend (binds 0.0.0.0:8000; the Dockerfile exposes 8000).
#   - workers come from WEB_CONCURRENCY (default 2). cpu_count()*2+1 would read the host's cores inside a
#     Container App, so 0.5 vCPU / 1 GiB could start 17 or more workers (out of memory).
#   - preload_app: the Azure SDK imports happen once, before the fork.
#   - the access log is off in the container (SCHRIJFASSISTENT_IN_CONTAINER=1).
# `uvicorn.workers.UvicornWorker` is deprecated upstream in favour of the `uvicorn-worker` package; a future
# `pip install` may need that package.
import os

bind = "0.0.0.0:8000"
worker_class = "uvicorn.workers.UvicornWorker"
workers = int(os.environ.get("WEB_CONCURRENCY", "2"))
preload_app = True
timeout = 230
max_requests = 1000
max_requests_jitter = 50
# SAFETY: the access line carries the full request path and query string. In the container it stays off so
# that no user data lands in Log Analytics; security.py logs method and route template per storage call.
accesslog = None if os.environ.get("SCHRIJFASSISTENT_IN_CONTAINER") == "1" else "-"
errorlog = "-"
# gunicorn 26 opens a control socket under the home directory (/app), which is read-only for the
# runtime user by design; it logged "Control server error: Permission denied" on every start.
control_socket_disable = True
loglevel = "info"
