# Schrijfassistent

The Schrijfassistent is an editor for GS-nota's (statenvoorstellen) inside GovChat. Authors write a nota in a structured editor, let an AI agent draft and check chapters, and save with conflict detection. Beheerders (admins) maintain the configuration that defines the nota structure.

It has two parts:

- `frontend/` is a Svelte 5 bundle. The overlay's `loader.js` adds a launcher card to Open WebUI and mounts the bundle in the page.
- `backend/` is a FastAPI service. It stores notas and configurations in Azure Blob Storage and calls an Azure AI Foundry agent.

Related documents: [API.md](API.md) describes the HTTP interface and [OPERATIONS.md](OPERATIONS.md) is the Azure Container Apps checklist.

In the taalreview sidebar, whitespace-only text (such as a double-space correction) is displayed as the reason for the suggestion. Accepting the suggestion still applies the actual replacement text.

## Architecture

```
Browser (Open WebUI page)
  loader.js  --card-->  SchrijfassistentApp bundle   --fetch + Bearer-->  backend (FastAPI)
                         mount(container, {                                  |-- GET {OPENWEBUI_INTERNAL_URL}/api/v1/auths/   (who is this?)
                           getToken, user,                                   |-- Azure Blob Storage   (notas/, configurations)
                           config, onClose })                                `-- Azure AI Foundry     (chat-agent)
```

- The admin container of the overlay builds the bundle (`admin/Dockerfile`, stage 1) and publishes it to the shared static volume under `apps/schrijfassistent/`.
- The bundle sends the Open WebUI session token as a bearer token. The backend checks it against Open WebUI (60 s positive cache, 8 s negative cache). An Open WebUI admin becomes a beheerder; every other role is an auteur.
- Notas are blobs. A save is conditional: the client sends the last known modification time and the backend answers 409 when someone else saved in between.
- The backend never stores the token and never logs nota content.

## Repository layout

| Path | Content |
|---|---|
| `frontend/` | Svelte bundle, unit tests, dev harness (`dev/`), build scripts (`scripts/`) |
| `backend/` | FastAPI app (`app/`), gunicorn config, Dockerfile, unit tests (`tests/`) |
| `dev/` | local-dev and test-stack scripts, blob emulator, Open WebUI token stand-in, AI mock, fixtures |
| `tests/contract/` | pytest + httpx tests against a running backend |
| `tests/e2e/` | Playwright scenarios against the bundle in an Open WebUI look-alike (`hostsim`) |
| `ops/kql/` | Log Analytics queries |
| `API.md`, `OPERATIONS.md` | interface and operations documents |

## Configuration

The backend reads environment variables. Outside a container it also reads `backend/.env` (or the file named in `SCHRIJFASSISTENT_ENV_FILE`); environment variables win over the file. In the container only the environment counts: the variables are set on the Azure Container App (`OPERATIONS.md`, section 2).

| Variable | Default | Meaning |
|---|---|---|
| `OPENWEBUI_INTERNAL_URL` | none, required | Base URL of Open WebUI, used to verify tokens. The service refuses to start without it. |
| `OPENWEBUI_VERIFY_TIMEOUT_SEC` | `3` | Timeout of the verification call |
| `PROJECT_ENDPOINT` | empty | Azure AI Foundry project endpoint for the `chat-agent` deployment |
| `AZURE_STORAGE_CONNECTION_STRING` | empty | Blob access with the storage account's connection string |
| `AZURE_STORAGE_CONTAINER_NAME` | `govchat-docs` | Blob container |
| `AZURE_CLIENT_ID` | none | Client id of a user-assigned identity (read by the Azure SDK) |
| `CORS_ALLOW_ORIGINS` | `http://localhost:3000,http://localhost:5174` | Comma-separated list of allowed origins |
| `ROOT_PATH` | empty | Path prefix when a proxy does not strip it, for example `/apps/schrijfassistent` |
| `API_V1_STR` | `/api/v1` | Prefix of the API routes |
| `PROJECT_NAME` | `Schrijfassistent API` | Title in the OpenAPI document |
| `MAX_BODY_BYTES_UPLOAD_CONFIGURATION` | 12 MiB | Body limit of `upload-configuration` |
| `MAX_BODY_BYTES_NOTA` | 10 MiB | Body limit of the nota, title and summary routes |
| `MAX_BODY_BYTES_DEFAULT` | 2 MiB | Body limit of every other route |
| `WEB_CONCURRENCY` | `2` | Gunicorn workers (container) |
| `SOFTWARE_VERSION_TAG` | image version | Informational |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `false` | Present for App Service style deployments; unused otherwise |
| `SCHRIJFASSISTENT_ENV_FILE` | none | Path of an env file to read |
| `SCHRIJFASSISTENT_IN_CONTAINER` | none | `1` makes the backend ignore env files; the image sets it |

## Run locally

Prerequisites: Python 3.13 (with `uv`, used by `make-venv.sh`), Node 20 or newer.

```
# backend: venv with the requirements
bash schrijfassistent/dev/make-venv.sh schrijfassistent/backend/.venv schrijfassistent/backend

# backend on http://localhost:8011
bash schrijfassistent/dev/run-local-dev.sh
bash schrijfassistent/dev/run-local-dev.sh stop

# bundle: build, or run the frontend harness on http://localhost:5175
cd schrijfassistent/frontend && npm install && npm run build
npm run dev:harness
```

`run-local-dev.sh` has two modes:

- Without `backend/.env` it runs in demo mode. AI answers are recorded replies for the three seeded notas, and storage is a local blob emulator on port 10001.
- With `backend/.env` (copy `.env.example`) it uses the real AI project and your `az login`. When the file holds no storage setting, it still uses the emulator, so nothing is written to Azure.

The script seeds fixture notas and verifies tokens against `OPENWEBUI_URL` (default `http://localhost:3000`). `BACKEND_PORT`, `BLOB_PORT`, `SEED_MOCK_PORT` and `PY` override the defaults. To see the card inside Open WebUI, follow the steps in `docker-compose.local.yaml` at the repository root.

## Tests

| Suite | Command | Needs |
|---|---|---|
| Frontend unit tests | `cd schrijfassistent/frontend && npm test` | Node |
| CSS checks | `npm run check:css-scope` and `npm run check:dark-twins` | Node |
| Type check | `npm run check` | Node, `svelte-check` |
| Backend unit tests | `cd schrijfassistent/backend && python -m pytest` | venv from `make-venv.sh` |
| Contract tests | `bash schrijfassistent/tests/contract/run.sh` | running backend and token stand-in |
| End-to-end | `node schrijfassistent/tests/e2e/run.mjs` | running test stack, Playwright library, Chromium |
| Admin overlay | `cd admin && npm test` | Node |

### Test stack

`dev/run-test-stack.sh` starts everything the contract and e2e suites need on ports you choose: the blob emulator, the Open WebUI token stand-in, the backend with replayed AI answers, seed data, the frontend harness and `hostsim`. It records its pids and `dev/stop-test-stack.sh` stops only those.

```
export BUILD_DIR=/tmp/sa-stack BACKEND_PORT=8071 OW_PORT=8072 BLOB_PORT=10071 DEV_PORT=3070 HOSTSIM_PORT=3071
bash schrijfassistent/dev/run-test-stack.sh
bash schrijfassistent/tests/contract/run.sh          # reads the addresses from the running file
E2E_RUNNING_FILE=schrijfassistent/dev/.running-test-stack.json \
  PLAYWRIGHT_LIB=/path/to/node_modules/playwright \
  node schrijfassistent/tests/e2e/run.mjs            # add --only <scenario> for a subset
bash schrijfassistent/dev/stop-test-stack.sh
```

The scripts list every option in their header. The contract tests take `CONTRACT_BASE_URL`, `CONTRACT_BEARER`, `CONTRACT_USER_BEARER`, `CONTRACT_BLOB_CONNECTION_STRING`, `CONTRACT_BLOB_CONTAINER`, `CONTRACT_CORS_ORIGIN`, `CONTRACT_OPENWEBUI_MOCK_LOG` and `CONTRACT_PYTHON`. The e2e runner takes `E2E_BASE_URL`, `E2E_HOSTSIM_URL`, `E2E_BEARER`, `E2E_ADMIN_BEARER`, `E2E_RUNNING_FILE`, `E2E_ONLY` and `E2E_HEADLESS`. `hostsim` serves the real `loader.js` and the built bundle, so run `npm run build` first. Reports go to `tests/e2e/reports/` (git-ignored).

## Build and images

- Bundle: `cd schrijfassistent/frontend && npm install && npm run build` writes `dist/` (IIFE `SchrijfassistentApp`, CSS and fonts).
- Admin image: `docker build -f admin/Dockerfile --build-arg VERSION=<tag> .` from the repository root. Stage 1 builds the bundle from `schrijfassistent/frontend`; stage 2 is the Express admin app with the bundle in `defaults/apps/schrijfassistent/`.
- Backend image: `docker build -f schrijfassistent/backend/Dockerfile --build-arg VERSION=<tag> schrijfassistent/backend`. It runs gunicorn with uvicorn workers on port 8000 as a non-root user.
- The admin image build runs `npm ci`, so it needs `schrijfassistent/frontend/package-lock.json` in the repository. Create it once with `npm install --package-lock-only` and commit it.
- The pipeline `.azuredevops/dev/azure-pipelines.yml` builds both images and rolls them out.
- `backend/requirements.lock` pins the backend dependencies; `backend/scripts/make-lock.sh` regenerates it.
