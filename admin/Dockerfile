# Admin container image, multi-stage (see schrijfassistent/README.md).
# Build context is the repository root ('.' in .azuredevops/dev/azure-pipelines.yml and
# docker-compose.local.yaml), so every COPY path carries its directory prefix.
#
#   docker build -f admin/Dockerfile --build-arg VERSION=1.2.3 .
#
# Stage 1 builds the Schrijfassistent bundle from schrijfassistent/frontend (npm ci, vite build);
# the `test` target (docker build --target test) runs svelte-check, the node tests and the CSS checks. Stage 2 is the admin image,
# plus the bundle output copied into defaults/apps/schrijfassistent/, which publishAll() copies to
# PUBLISH_DIR/apps/ so Open WebUI serves it at /static/apps/schrijfassistent/.

# ---- stage 1: bundle ---------------------------------------------------------------------
FROM node:20 AS bundle

# The pipeline passes --build-arg VERSION=<SOFTWARE_VERSION_TAG>; the bundle shows it in the header
# gear menu and `az containerapp update` sets the same value as SOFTWARE_VERSION_TAG.
ARG VERSION=dev
ENV SOFTWARE_VERSION_TAG=$VERSION
ENV CI=true

WORKDIR /bundle

# Reproducible installs: `npm ci` only, from the committed package-lock.json, so the Monday
# rebuild of the pipeline (weekly schedule, base-image refresh) ships the same dependency set as the last
# reviewed build; only the base image layers move. There is no `npm install` fallback: a missing lock file fails
# the build with the message below. Generate the lock file once on a machine with
# registry access (`cd schrijfassistent/frontend && npm install --package-lock-only`) and commit it; dependency
# upgrades are then a reviewed change of package.json and package-lock.json together.
COPY schrijfassistent/frontend/package*.json ./
RUN if [ ! -f package-lock.json ]; then \
      echo "ERROR: schrijfassistent/frontend/package-lock.json is missing. The bundle build needs the committed lock file (npm ci)." >&2; \
      echo "       Generate it on a machine with registry access: cd schrijfassistent/frontend && npm install --package-lock-only, then commit it." >&2; \
      exit 1; \
    fi \
 && npm ci --no-audit --no-fund

COPY schrijfassistent/frontend/ ./
RUN node node_modules/vite/bin/vite.js build

# ---- test target: not part of the release build ---------------------------------------
FROM bundle AS test
# svelte-check (checkJs is off), the frontend node tests, the build-time CSS scope check and the dark twin tie check.
RUN npm run check \
 && node --test tests/*.test.mjs \
 && node scripts/check-css-scope.mjs \
 && node scripts/check-dark-twins.mjs

# ---- stage 2a: admin dependencies (npm itself does not end up in the image) --------------
FROM node:20-alpine AS deps

WORKDIR /app

COPY admin/package.json admin/package-lock.json ./
RUN npm ci --omit=dev

# ---- stage 2b: admin image ---------------------------------------------------------------
FROM node:20-alpine

# The runtime only needs node. Remove the bundled package managers (npm, corepack, yarn):
# they are not used at runtime and their own dependencies show up in vulnerability scans.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY admin/package.json admin/server.js ./
COPY admin/lib/ ./lib/
COPY admin/views/ ./views/
COPY admin/defaults/ ./defaults/

# The built bundle: schrijfassistent.<hash>.js/.css, manifest.json and logo_flevoland.png.
# No built artefact is committed to git; this directory exists inside the image only.
COPY --from=bundle /bundle/dist/ ./defaults/apps/schrijfassistent/

EXPOSE 3002

CMD ["node", "server.js"]
