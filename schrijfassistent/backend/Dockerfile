# Schrijfassistent backend image.
# API only: the frontend bundle ships through the admin image. Built by GitHub Actions
# (.github/workflows/build.yml, context schrijfassistent/backend) and published as
# ghcr.io/provincieflevoland/flairschrwzr-schrijfassistent-api:vX.Y.Z, the same tag as the admin image;
# Azure DevOps then points its own Container App at that tag.
FROM python:3.12-slim

# Build metadata passed by the pipeline (same arguments as the admin image).
ARG VERSION=dev
ARG GIT_COMMIT=unknown
LABEL org.opencontainers.image.title="schrijfassistent-api" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${GIT_COMMIT}"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    SCHRIJFASSISTENT_IN_CONTAINER=1 \
    WEB_CONCURRENCY=2 \
    SOFTWARE_VERSION_TAG=${VERSION}

WORKDIR /app

# Dependencies first so the layer is cached across source changes.
# requirements.txt is the human list; requirements.lock is the hashed set (scripts/make-lock.sh).
# While requirements.lock holds no hashes the build falls back to the unpinned requirements.txt, and the
# weekly base-image refresh also refreshes Python packages. Once the lock holds hashes, --require-hashes is enforced.
COPY requirements.txt requirements.lock ./
RUN if grep -q -- '--hash=' requirements.lock; then \
      pip install --no-cache-dir --require-hashes -r requirements.lock; \
    else \
      echo "WARNING: requirements.lock has no hashes; installing unpinned requirements.txt"; \
      pip install --no-cache-dir -r requirements.txt; \
    fi

COPY main.py gunicorn.conf.py ./
COPY app ./app
# Make the code readable for the runtime user whatever the file modes of the build context are
# (a checkout with 0600 files, as on some developer machines, otherwise gives PermissionError).
RUN chmod -R a+rX /app/main.py /app/gunicorn.conf.py /app/app

# Non-root user.
RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --home-dir /app --shell /usr/sbin/nologin app
# The code tree stays root-owned and read-only for the runtime user.
USER app

# gunicorn.conf.py binds 0.0.0.0:8000; workers from WEB_CONCURRENCY (default 2), access log off.
EXPOSE 8000

# No curl in python:slim; the check uses the standard library. GET /health is the pipeline smoke path too.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status == 200 else 1)"

CMD ["gunicorn", "-c", "gunicorn.conf.py", "main:app"]
