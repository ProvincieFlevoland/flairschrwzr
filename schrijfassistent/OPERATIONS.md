# Schrijfassistent: operations on Azure Container Apps

This checklist covers the backend Container App, its identity and roles, the Front Door route, monitoring and rollback. The admin overlay app and its pipeline are described in `docs/`.

## 1. Container App

| Item | Value |
|---|---|
| Image | `schrijfassistent-api` from the environment's container registry, built from `schrijfassistent/backend/` by the pipeline |
| Name | set in the pipeline variable `backendContainerApp`; the resource group in `backendResourceGroup`; the container name in `backendContainerName` (`api`) |
| Port | 8000 (`gunicorn.conf.py` binds `0.0.0.0:8000`) |
| Resources | 0.5 vCPU, 1 GiB |
| Scale | minimum 1, maximum 2 replicas. The token cache lives in memory per worker, and autosave writes every 10 s while someone is typing. |
| Workers | `WEB_CONCURRENCY=2`. Do not use the CPU count of the node. |
| Probes | liveness, readiness and startup all use `GET /health` on port 8000; the startup probe waits 20 s first. The answer is `{"status":"healthy","version":"1.1"}`. |
| User | non-root `app` (uid 10001) |
| Image rollout | the pipeline runs `az containerapp update` with the image digest and smoke-tests `GET /health` on the app FQDN. The agent pool must reach that FQDN. |
| Image ownership | with `image_managed_externally = true` in the Terraform module, Terraform leaves `image` alone after creation |

The backend deploy step in the pipeline is skipped while `backendContainerApp` still holds its `TODO` value.

## 2. Environment variables

The `.env` file is not read in the container (`SCHRIJFASSISTENT_IN_CONTAINER=1` is set in the image). Every setting is an environment variable on the Container App, with the same names as in `backend/.env.example`. The full list is in `README.md`.

| Variable | Secret | Value |
|---|---|---|
| `AZURE_STORAGE_CONNECTION_STRING` | yes, Container App secret | connection string of the storage account |
| `AZURE_STORAGE_CONTAINER_NAME` | no | `govchat-docs` |
| `AZURE_CLIENT_ID` | no | client id of the user-assigned identity, so `DefaultAzureCredential` picks it |
| `PROJECT_ENDPOINT` | yes, Container App secret | endpoint of the AI Foundry project that hosts the `chat-agent` deployment |
| `OPENWEBUI_INTERNAL_URL` | no | internal URL of the Open WebUI Container App. Required: the backend does not start without it. |
| `OPENWEBUI_VERIFY_TIMEOUT_SEC` | no | `3` |
| `CORS_ALLOW_ORIGINS` | no | the GovChat origin, for example `https://flair-dev.ai.flevoland.nl`. Only needed when the app is called from another origin. |
| `ROOT_PATH` | no | empty. Set to `/apps/schrijfassistent` only when Front Door cannot strip the prefix (section 4). |
| `WEB_CONCURRENCY` | no | `2` |
| `SOFTWARE_VERSION_TAG` | no | set by the pipeline on every rollout |

The two secret values are stored as Container App secrets, and their environment variables reference the secret (`secretref`). No Key Vault is used.

## 3. Identity and roles

| Role | Scope | Reason |
|---|---|---|
| `AcrPull` | container registry | pull the image |
| AI Foundry role (`Azure AI User` or equivalent) | AI Foundry project | call the agent through the project endpoint |
| `Cognitive Services OpenAI User` | Azure OpenAI resource behind the project | the `chat-agent` deployment runs under this identity |

## 4. Front Door

Route the app under the GovChat host, for example `flair-dev.ai.flevoland.nl`:

| Item | Value |
|---|---|
| Pattern | `/apps/schrijfassistent/api/*` |
| Origin | the backend Container App |
| Rewrite | strip `/apps/schrijfassistent`, so `/apps/schrijfassistent/api/v1/storage/notas` reaches the backend as `/api/v1/storage/notas`. Use origin path `/` and a rule set rewrite from `/apps/schrijfassistent/` to `/` with unmatched path preserved. |
| Headers | pass `Authorization`, `X-Nota-Base-Modified`, `If-Match` and `Content-Type` unchanged |
| Caching | off |
| Origin response timeout | 240 s. The AI routes wait on Azure OpenAI, and gunicorn allows 230 s. Front Door's default of 60 s would turn a slow generation into a 504. |
| Health probe | `/apps/schrijfassistent/api/health` |

The launcher card sets `config.api_base_url` to `/apps/schrijfassistent`, and the bundle appends `/api/v1/...`. Browser and Open WebUI then share one origin, so CORS does not apply.

If the rule cannot strip the prefix, set `ROOT_PATH=/apps/schrijfassistent` on the Container App. FastAPI then serves the same routes under that prefix.

If no path rule is possible at all, give the backend external ingress on its own hostname. Put that hostname in `config.api_base_url` of the launcher card and list the GovChat origin in `CORS_ALLOW_ORIGINS`.

### WAF

- Raise the body limit to 12 MiB for `POST /api/v1/storage/upload-configuration` only. The backend refuses larger bodies with 413. The v5 configuration fixture is about 135 kB, which exceeds the default WAF limit of 128 KB.
- The other routes can keep the default limit.
- Smoke test: a 135 kB upload returns 200 and an 11 MB upload returns 413 from the backend.
- Check that a 403 from the backend (a signed-in user who is not an admin saving a configuration) reaches the browser unchanged.

## 5. Reachability of Open WebUI

Each request with a bearer token makes the backend call `GET {OPENWEBUI_INTERNAL_URL}/api/v1/auths/`. Check three things before go-live:

- the Open WebUI app is reachable from the backend inside the Container Apps environment;
- TLS on that URL is valid for Python's default trust store (a private CA needs a bundle in the image);
- no network policy or WAF rule blocks the call.

If Open WebUI cannot be reached, the backend answers 401 and logs `auth=denied`.

## 6. Data protection

- Turn on blob versioning and soft delete (30 days) on the storage account.
- Keep a backup copy of the `notas/` and configuration blobs.

## 7. Open WebUI upgrades

`loader.js` anchors on the Open WebUI sidebar markup. Pin the Open WebUI image tag. On every upgrade, open the launcher card and the sidebar entry in a test environment before the rollout.

## 8. Logging and monitoring

Container console logs go to the environment's Log Analytics workspace. The gunicorn access log is off, because the request line carries the query string and `user_message` travels there.

| Log line | Meaning |
|---|---|
| `auth=<openwebui\|denied> route=<method path template>` | one line per storage call, with the Open WebUI user id where known; never the token or nota content |
| `config-write` | a beheerder saved or deleted a configuration |
| `role-check=denied` | a non-beheerder tried to write a configuration |
| `Conflict on nota` | a nota save was refused with 409 |

Saved queries are in `schrijfassistent/ops/kql/`:

| File | Shows |
|---|---|
| `auth-denied.kql` | calls refused with 401 |
| `role-denied.kql` | configuration writes refused with 403 |
| `config-writes.kql` | configuration writes; only beheerders should appear |
| `conflicts.kql` | nota save conflicts |
| `errors-5xx.kql` | server errors |

The queries read the Container App console log. Check the `appName` filter at the top of each file against the deployed app name. To see requests that Front Door blocks before they reach the app, enable the diagnostic setting `FrontDoorAccessLog`.

## 9. Rollback

Redeploy an earlier image digest:

```
az containerapp update -n <app> -g <resource group> --image <registry>/schrijfassistent-api@sha256:<earlier digest>
```

The pipeline publishes each digest in the `image-backend` artifact.
