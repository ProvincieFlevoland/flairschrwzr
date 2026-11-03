# Schrijfassistent-backend

FastAPI-service voor de Schrijfassistent in GovChat. De backend slaat nota's en configuraties op in Azure Blob Storage, roept een Azure AI Foundry-agent aan (deployment `chat-agent`) en controleert bij elke aanvraag het Open WebUI-token van de gebruiker. Alleen de API zit in dit image; de frontend-bundle komt via het admin-image.

## In het kort

| | |
|---|---|
| Image | `schrijfassistent-api`, gebouwd uit deze map (`Dockerfile`, Python 3.12, non-root user `app`, uid 10001) |
| Poort | **8000** (gunicorn, `gunicorn.conf.py`) |
| Health | `GET /health` (ook `/api/health`) geeft `{"status":"healthy","version":"1.1"}`. Gebruik dit voor liveness-, readiness- en startup-probes. |
| API | `/api/v1/storage/...`, elke route vraagt `Authorization: Bearer <Open WebUI-token>` |
| Afhankelijkheden | Open WebUI (tokencontrole), Azure Blob Storage, Azure AI Foundry-project |
| Resources | 0,5 vCPU / 1 GiB is genoeg, met `WEB_CONCURRENCY=2` |

## Omgevingsvariabelen

Bron: `app/core/config.py` en `main.py`. In de container wordt alleen de omgeving gelezen (het image zet `SCHRIJFASSISTENT_IN_CONTAINER=1`). Lokaal leest de backend ook `backend/.env`; een omgevingsvariabele gaat altijd voor op het bestand.

### Nodig

| Variabele | Secret | Standaard | Wat |
|---|---|---|---|
| `OPENWEBUI_INTERNAL_URL` | nee | geen | Basis-URL van Open WebUI zoals de backend die bereikt (in Azure de interne URL van de Open WebUI Container App). **Verplicht: zonder deze waarde start de backend niet.** Per token roept de backend `GET {url}/api/v1/auths/` aan. |
| `PROJECT_ENDPOINT` | **ja** | leeg | Project-endpoint van Azure AI Foundry, bijv. `https://<resource>.services.ai.azure.com/api/projects/<project>`. Het project moet een deployment `chat-agent` hebben. Zonder deze waarde start de app wel, maar de AI-routes werken niet (503 of fout). |
| `AZURE_STORAGE_CONNECTION_STRING` | **ja** | leeg | Connection string van het storage-account. Zonder deze waarde werkt opslaan en lezen van nota's en configuraties niet. |
| `AZURE_STORAGE_CONTAINER_NAME` | nee | `govchat-docs` | Naam van de blob-container. Let op: `.env.example` vult `schrijfassistentdocs` in; kies er één per omgeving. |
| `CORS_ALLOW_ORIGINS` | nee | `http://localhost:3000,http://localhost:5174` | Origins die de API vanuit de browser mogen aanroepen, kommagescheiden. Zet hier de GovChat-origin (bijv. `https://flair-dev.ai.flevoland.nl`). Niet nodig als browser en backend via Front Door dezelfde origin delen. |

### Optioneel

| Variabele | Standaard | Wat |
|---|---|---|
| `AZURE_CLIENT_ID` | geen | Client-id van een user-assigned managed identity, zodat `DefaultAzureCredential` die kiest. Niet nodig bij een system-assigned identity. |
| `OPENWEBUI_VERIFY_TIMEOUT_SEC` | `3` | Timeout van de tokencontrole bij Open WebUI |
| `ROOT_PATH` | leeg | Alleen `/apps/schrijfassistent` invullen als Front Door het pad-prefix niet kan weghalen |
| `WEB_CONCURRENCY` | `2` (gezet in image) | Aantal gunicorn-workers. Niet op CPU-aantal zetten. |
| `SOFTWARE_VERSION_TAG` | imageversie | Alleen informatief |
| `MAX_BODY_BYTES_UPLOAD_CONFIGURATION` | 12 MiB | Maximale body van `upload-configuration` (groter geeft 413) |
| `MAX_BODY_BYTES_NOTA` | 10 MiB | Maximale body van nota-, titel- en samenvattingsroutes |
| `MAX_BODY_BYTES_DEFAULT` | 2 MiB | Maximale body van alle andere routes |
| `API_V1_STR`, `PROJECT_NAME`, `SCM_DO_BUILD_DURING_DEPLOYMENT` | | Bestaan in de code; laten zoals ze zijn |
| `SCHRIJFASSISTENT_ENV_FILE` | | Lokaal: pad naar een ander `.env`-bestand, of leeg om geen bestand te lezen |

De twee secrets (`PROJECT_ENDPOINT`, `AZURE_STORAGE_CONNECTION_STRING`) horen als Container App-secret te staan, met de env var als `secretref`.

## Azure-rechten

De code gebruikt twee manieren van inloggen:

- **AI Foundry** via `DefaultAzureCredential` (`app/services/ai_agent.py`). In Azure is dat de managed identity van de Container App; lokaal je `az login`.
- **Storage** via de connection string (`app/services/azure_storage.py`). De managed identity heeft daarvoor dus **geen** storage-rol nodig; de sleutel zit in de connection string.

| Wie | Rol | Scope | Waarom |
|---|---|---|---|
| Managed identity van de Container App | `Azure AI User` (of gelijkwaardig) | AI Foundry-project | het project-endpoint aanroepen |
| Managed identity van de Container App | `Cognitive Services OpenAI User` | Azure OpenAI / AI Services-resource achter het project | de `chat-agent`-deployment aanroepen |
| Container App | pull-rechten | registry waar het image staat (ghcr of ACR, bijv. `AcrPull`) | image ophalen |
| Ontwikkelaar (lokaal) | dezelfde AI-rollen als hierboven | AI Foundry-project | lokaal testen met echte AI |

Gebruik je een user-assigned identity, zet dan ook `AZURE_CLIENT_ID`.

## Netwerk

- De backend moet `OPENWEBUI_INTERNAL_URL` kunnen bereiken. Kan dat niet, dan krijgt elke aanvraag 401 (log: `auth=denied`). Het TLS-certificaat van die URL moet geldig zijn voor de standaard trust store van Python.
- Uitgaand naar het storage-account en het AI Foundry-endpoint.
- AI-aanroepen kunnen lang duren: gunicorn staat 230 s toe. Zet de origin-timeout van Front Door op 240 s (standaard 60 s geeft 504).
- `upload-configuration` kan groter zijn dan de standaard WAF-limiet (128 KB); verhoog die voor alleen die route naar 12 MiB.

## Lokaal draaien

Vereist: Python 3.12, Azure CLI (voor echte AI) en een draaiende Open WebUI (standaard `http://localhost:3000`).

```bash
cd schrijfassistent/backend
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env      # en vul in: OPENWEBUI_INTERNAL_URL, PROJECT_ENDPOINT, AZURE_STORAGE_*
az login                  # voor PROJECT_ENDPOINT (DefaultAzureCredential)

uvicorn main:app --reload --port 8000
curl http://localhost:8000/health
```

`python main.py` start ook, maar dan op poort 8001.

Met Docker:

```bash
docker build -t schrijfassistent-api schrijfassistent/backend
docker run --rm -p 8000:8000 \
  -e OPENWEBUI_INTERNAL_URL=http://host.docker.internal:3000 \
  -e PROJECT_ENDPOINT=... \
  -e AZURE_STORAGE_CONNECTION_STRING=... \
  -e AZURE_STORAGE_CONTAINER_NAME=govchat-docs \
  schrijfassistent-api
```

In de container werkt `az login` niet; voor de AI-routes heb je dan een service principal nodig (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_SECRET`, die `DefaultAzureCredential` oppakt) of je test de AI-routes buiten Docker.

Unittests (geen netwerk of storage nodig):

```bash
pip install pytest
pytest tests
```

## Logging

Eén regel per aanvraag: `auth=<openwebui|denied> route=<methode pad>`. Het token en de inhoud van nota's worden nooit gelogd; de gunicorn access log staat in de container uit. Andere regels om op te letten: `role-check=denied` (niet-beheerder probeert configuratie te wijzigen) en `Conflict on nota` (409 bij opslaan).
