# Lokale ontwikkelomgeving

Dit document beschrijft hoe je de volledige stack lokaal draait en welke environment variabelen daarvoor nodig zijn:

| Onderdeel | Waar | Poort |
|---|---|---|
| Open WebUI (container) | `docker-compose.local.yaml` | 3000 |
| Admin overlay (container) | `docker-compose.local.yaml`, `admin/` | 3002 |
| Schrijfassistent backend (op de host) | `schrijfassistent/backend` | 8011 |
| Schrijfassistent frontend (bundle) | `schrijfassistent/frontend` | in de admin-image / harness op 5175 |

## Vereisten

| Vereiste | Waarvoor | Opmerking |
|---|---|---|
| Docker (Docker Desktop of Engine) met Docker Compose v2 | Open WebUI en admin overlay | Op Windows: Docker Desktop met WSL 2-integratie. |
| Linux of macOS; op Windows **WSL 2** (bijv. Ubuntu) | Backend starten (`run-local-dev.sh`) | Het script is bash; niet via PowerShell of Git Bash. |
| `bash`, `curl`, `python3` | `run-local-dev.sh`, blob-emulator, seed | Standaard aanwezig in WSL/Linux/macOS. |
| [`uv`](https://docs.astral.sh/uv/) | Backend-venv aanmaken (`make-venv.sh`) | Installeren binnen WSL. |
| Python 3.13 | Backend-venv | `uv` haalt deze zelf op. |
| Node.js en npm | Alleen voor losse frontend-ontwikkeling (`npm`, harness) | Voor de normale route niet nodig: de bundle wordt in de admin-image gebouwd. |
| Azure CLI (`az login`) en toegang tot het Foundry-project | Alleen voor echte AI (backend met `.env`) | Niet nodig in demo-modus. Zie "Azure-login en rollen" in sectie 3. |
| Vrije poorten 3000, 3002, 8011, 10001 | | Aanpasbaar, zie de overrides in sectie 3. |

Shell-scripts (`*.sh`) moeten LF-regeleindes hebben; `.gitattributes` dwingt dat af.

## Overzicht en volgorde

1. Backend starten op de host (`bash schrijfassistent/dev/run-local-dev.sh`). **Windows: draai dit in WSL (Linux)**, niet in PowerShell of Git Bash; zie sectie 3.
2. Containers starten (`docker compose -f docker-compose.local.yaml up --build`).
3. Inloggen op <http://localhost:3000> (eerste bezoek maakt het lokale admin-account aan) en via de App Launcher **Schrijfassistent** openen.

> De volgorde van de containers is belangrijk: Open WebUI overschrijft `/static/loader.js` bij elke start, de admin-container publiceert de overlay opnieuw ~15 seconden na zijn eigen start (en daarna elke `GOVCHAT_REPUBLISH_INTERVAL_SEC`). Is de overlay weg na een herstart van alleen Open WebUI? Herstart dan ook `govchat-admin`.

## 1. Open WebUI container

Ingesteld in `docker-compose.local.yaml` (service `open-webui`, image `ghcr.io/open-webui/open-webui:v0.8.10`, pin dezelfde tag als flair-dev).

| Variabele | Lokale waarde | Toelichting |
|---|---|---|
| `STATIC_DIR` | `/app/backend/static` | **Verplicht**: hiermee wordt de overlay (loader.js, apps.json, bundle) via `/static` geserveerd. |
| `WEBUI_NAME` | `GovChat lokaal` | Weergavenaam. |
| `CORS_ALLOW_ORIGIN` | `http://localhost:3000` | Toegestane origin. |

Volumes: `govchat-static` -> `/app/backend/static` (gedeeld met de admin), `open-webui-data` -> `/app/backend/data`.

## 2. Admin overlay container

Service `govchat-admin`, gebouwd uit `admin/Dockerfile` met de repository-root als build-context (multi-stage: bouwt eerst `schrijfassistent/frontend`; de bundle zit in de image).

Ingesteld in `docker-compose.local.yaml`:

| Variabele | Lokale waarde | Default in `admin/server.js` | Toelichting |
|---|---|---|---|
| `ADMIN_PASSWORD` | `lokaal123` | `changeme` | Wachtwoord admin-paneel op <http://localhost:3002>. (Let op: de naam is `ADMIN_PASSWORD`, niet `GOVCHAT_ADMIN_PASSWORD` zoals in de admin-README staat.) |
| `DATA_DIR` | `/data` | `/data` | Opslag van configuratie (volume `govchat-admin-data`). |
| `PUBLISH_DIR` | `/publish` | `/publish` | Moet dezelfde volume zijn als `STATIC_DIR` van Open WebUI (`govchat-static`). |
| `CORS_ORIGIN` | `http://localhost:3000` | `*` | Origin van Open WebUI. |
| `SCHRIJFASSISTENT_ALLOW_LOCAL_API` | `"1"` | leeg (uit) | **Alleen lokaal.** Laat de loader een `http://localhost` API-URL accepteren. Wordt alleen gepubliceerd als de variabele gezet is en door `loader.js` alleen gehonoreerd als de pagina op localhost draait. Nooit in de pipeline/Terraform App Settings. |
| `SCHRIJFASSISTENT_LOCAL_API_BASE_URL` | `http://localhost:8011` | leeg | Backend van `run-local-dev.sh`. |

Optionele variabelen (niet nodig voor Schrijfassistent lokaal), uit `admin/server.js`:

| Variabele | Default | Doel |
|---|---|---|
| `PORT` | `3002` | Luisterpoort. |
| `GOVCHAT_REPUBLISH_INTERVAL_SEC` | `60` | Interval herpubliceren overlay; `0` schakelt uit. |
| `IMAGE_JOBS_ENABLED`, `IMAGE_JOBS_TOKEN`, `IMAGE_JOBS_WEBHOOK_URL`, `IMAGE_JOBS_WEBHOOK_TOKEN`, `IMAGE_JOBS_CONCURRENCY`, `IMAGE_JOBS_TTL_HOURS` | `false` / n8n-URL | Image-generatie via n8n. |
| `N8N_WEBHOOK_TOKEN` | leeg | Fallback-token voor meerdere n8n-webhooks. |
| `CRAWLER_N8N_WEBHOOK_URL`, `CRAWLER_N8N_WEBHOOK_TOKEN`, `CRAWLER_INTERNAL_TOKEN`, `CRAWLER_RUNS_LIMIT`, `CRAWLER_EMBEDDING_MODEL` | n8n-URL | Crawler. |
| `REALTIME_STT_PROVIDER`, `REALTIME_STT_TOKEN`, `LITELLM_URL`, `LITELLM_REALTIME_URL`, `LITELLM_REALTIME_MODEL`, `LITELLM_REALTIME_API_KEY`, `AZURE_OPENAI_REALTIME_*` | `litellm` | Realtime spraak-naar-tekst. |
| `BELEIDSKOMPAS_N8N_BASE_URL`, `BELEIDSKOMPAS_N8N_WEBHOOK_TOKEN` | n8n-URL | Beleidskompas. |
| `LIBRECHAT_INTERNAL_URL`, `JWT_REFRESH_SECRET` / `JWT_SECRET`, `TRANSCRIPT_AUTH_DEBUG` | | Transcript-auth. |

## 3. Schrijfassistent backend

Draait op de host (niet in compose) via:

```bash
# eenmalig: venv aanmaken (idempotent; vereist `uv`)
bash schrijfassistent/dev/make-venv.sh schrijfassistent/backend/.venv schrijfassistent/backend
bash schrijfassistent/dev/run-local-dev.sh        # start (idempotent), backend op http://localhost:8011
bash schrijfassistent/dev/run-local-dev.sh stop   # stoppen
```

> **De backend moet vanuit Linux of macOS gestart worden.** Het script is bash en gebruikt o.a. `/dev/tcp`, `nohup`, `pkill` en de venv-map `.venv/bin/python`. Op Windows draai je alles (venv aanmaken en het script) dus vanuit **WSL**, niet vanuit PowerShell of Git Bash. Houd de repository bij voorkeur in het WSL-bestandssysteem (`~/...`) of gebruik `/mnt/c/...`; Docker Desktop bereikt de backend op `localhost:8011` doordat WSL poorten naar Windows doorstuurt.
>
> Shell-scripts (`*.sh`) moeten LF-regeleindes hebben; `.gitattributes` dwingt dat af. Zie je `\r: command not found`, dan heeft het bestand CRLF: `git add --renormalize .` en check het bestand opnieuw uit.

### Azure-login en rollen (alleen voor echte AI)

De backend gebruikt lokaal `DefaultAzureCredential`, dus de identiteit van `az login`. Log in **binnen WSL** (de Azure CLI in Windows wordt niet gezien door WSL) met een **persoonlijk gebruikersaccount** dat in het juiste tenant/abonnement toegang heeft:

```bash
az login            # eventueel: az login --use-device-code --tenant <tenant-id>
az account set --subscription <subscription-id>
az account show     # controleer account en abonnement
```

Dit account heeft dezelfde rollen nodig als de managed identity van de backend in Azure (zie `schrijfassistent/OPERATIONS.md` en `backend/README.md`):

| Rol | Scope | Waarvoor |
|---|---|---|
| `Azure AI User` (of gelijkwaardig) | AI Foundry-project | Het project-endpoint (`PROJECT_ENDPOINT`) aanroepen. |
| `Cognitive Services OpenAI User` | Azure OpenAI / AI Services-resource achter het project | De `chat-agent`-deployment aanroepen. |

Vraag de rolwijziging aan bij de beheerder van het Foundry-project; een nieuwe roltoewijzing kan enkele minuten duren en vereist opnieuw inloggen (`az logout && az login`). Zonder deze rollen krijgt de backend een `401`/`403` bij AI-aanroepen. Voor echte opslag (`AZURE_STORAGE_CONNECTION_STRING`) is geen rol nodig; de connection string geeft toegang.

### Modi

| Situatie | Gedrag |
|---|---|
| Geen `schrijfassistent/backend/.env` | **Demo-modus**: opgenomen AI-antwoorden (alleen voor de geseede nota's) + lokale blob-emulator op `:10001`. |
| `.env` met `PROJECT_ENDPOINT`, zonder `AZURE_STORAGE_CONNECTION_STRING` | Echte AI (`az login` nodig), lokale blob-emulator met 3 fixture-nota's. |
| `.env` met `PROJECT_ENDPOINT` en `AZURE_STORAGE_CONNECTION_STRING` | Echte AI en echte Azure Storage (er wordt echt gelezen/geschreven!). |

### `schrijfassistent/backend/.env`

Kopieer `.env.example` naar `.env` (git-ignored). Environment variabelen winnen altijd van het bestand.

| Variabele | Voorbeeld / default | Toelichting |
|---|---|---|
| `PROJECT_ENDPOINT` | `https://<resource>.services.ai.azure.com/api/projects/<project>` | Azure AI Foundry project (deployment `chat-agent`). Credential via `az login` (DefaultAzureCredential). Wordt vervangen door LiteLLM (TODO in `.env.example`). |
| `AZURE_STORAGE_CONNECTION_STRING` | leeg | Leeg = lokale blob-emulator. |
| `AZURE_STORAGE_CONTAINER_NAME` | `schrijfassistentdocs` (code-default `govchat-docs`) | Blob-container voor nota's en configuraties. |
| `OPENWEBUI_INTERNAL_URL` | `http://localhost:3000` | **Verplicht**; de backend start niet zonder. Tokens worden hiertegen geverifieerd. |
| `OPENWEBUI_VERIFY_TIMEOUT_SEC` | `3.0` | Timeout van tokenverificatie. |
| `CORS_ALLOW_ORIGINS` | `http://localhost:3000,http://localhost:5174` | Komma-gescheiden origins. |
| `ROOT_PATH` | leeg | Bijv. `/apps/schrijfassistent` als de prefix niet door Front Door wordt gestript. |
| `MAX_BODY_BYTES_UPLOAD_CONFIGURATION` / `_NOTA` / `_DEFAULT` | 12 MiB / 10 MiB / 2 MiB | Request-limieten. |
| `SCHRIJFASSISTENT_ENV_FILE` | niet gezet | Ander `.env`-pad; leeg = bestand uitschakelen. |
| `SCHRIJFASSISTENT_IN_CONTAINER` | niet gezet | `1` = `.env` nooit lezen (containergebruik). |
| `WEB_CONCURRENCY` | `2` | Gunicorn-workers (alleen container). |

### Wat `run-local-dev.sh` zelf zet

Altijd: `OPENWEBUI_INTERNAL_URL=$OPENWEBUI_URL`, `OPENWEBUI_VERIFY_TIMEOUT_SEC=3`, `CORS_ALLOW_ORIGINS=http://localhost:3000`. In demo-modus ook `AI_MOCK_FIXTURES_DIR`, `AI_MOCK_LOG` en `PYTHONPATH=dev/mock`. Bij de emulator: `AZURE_STORAGE_CONNECTION_STRING` (Azurite-devstore) en `AZURE_STORAGE_CONTAINER_NAME=govchat-docs`.

Overrides voor het script zelf:

| Variabele | Default | Doel |
|---|---|---|
| `PY` | `schrijfassistent/backend/.venv/bin/python` | Python met backend-requirements. |
| `BACKEND_PORT` | `8011` | Backendpoort. Pas dan ook `SCHRIJFASSISTENT_LOCAL_API_BASE_URL` aan. |
| `BLOB_PORT` | `10001` | Blob-emulator. |
| `SEED_MOCK_PORT` | `8012` | Tijdelijke Open WebUI-stand-in voor het seeden. |
| `OPENWEBUI_URL` | `http://localhost:3000` | Open WebUI waartegen tokens worden geverifieerd. |

## 4. Schrijfassistent frontend

De frontend (Svelte/Vite) heeft **geen** build-time environment variabelen: `import.meta.env` is verboden in de bundle. De configuratie komt uitsluitend binnen als `config`-prop van `mount()`, ingevuld door `loader.js` uit `apps.json`:

| Config | Default | Lokaal |
|---|---|---|
| `api_base_url` | `/apps/schrijfassistent` | `http://localhost:8011` via `SCHRIJFASSISTENT_LOCAL_API_BASE_URL` van de admin. |
| `asset_base_url` | `/static/apps/schrijfassistent` | default. |
| `b1_metrics_doc_url` | leeg | optioneel (alleen `https:`/`mailto:`). |

Normale route: de bundle wordt in de `admin`-image gebouwd en via de overlay gepubliceerd; je hoeft niets te doen behalve `docker compose ... up --build`.

Losse frontend-ontwikkeling (zonder Open WebUI), in `schrijfassistent/frontend`:

```bash
npm ci
npm run build                 # vite build -> dist/
PORT=5175 node dev/serve.mjs  # of: npm run dev:harness
# open http://127.0.0.1:5175/?api=http://localhost:8011
```

| Variabele (harness) | Default | Doel |
|---|---|---|
| `PORT` | `5175` | Poort van de harness. |
| `HOST` | `127.0.0.1` | Bind-adres. |
| `OPENWEBUI_APP_CSS` | niet gezet | Pad naar een Open WebUI app-CSS voor stijlvergelijking. |

Overige scripts: `npm test`, `npm run check`.

## Veelvoorkomende problemen

- **Overlay/App Launcher ontbreekt**: herstart `govchat-admin` (zie volgorde hierboven).
- **CORS-fout in browser**: `CORS_ALLOW_ORIGINS` (backend) moet de origin bevatten waarop Open WebUI draait.
- **401 van de backend**: `OPENWEBUI_INTERNAL_URL` wijst niet naar de draaiende Open WebUI, of je bent niet ingelogd.
- **Backend bereikt Open WebUI niet vanuit een container**: gebruik `host.docker.internal` i.p.v. `localhost` waar de backend zelf in een container draait.
- **Backend start niet**: `OPENWEBUI_INTERNAL_URL` ontbreekt of `.venv` bestaat niet.
