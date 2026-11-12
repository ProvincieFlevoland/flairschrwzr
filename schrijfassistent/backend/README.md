# Schrijfassistent-backend

FastAPI-service voor de Schrijfassistent in GovChat. De backend slaat nota's en configuraties op in Azure Blob Storage, roept een taalmodel aan via Azure AI Foundry of via LiteLLM (instelbaar met `AI_PROVIDER`, zie [AI-voorziening](#ai-voorziening)) en controleert bij elke aanvraag het Open WebUI-token van de gebruiker. Alleen de API zit in dit image; de frontend-bundle komt via het admin-image.

## In het kort

| | |
|---|---|
| Image | `schrijfassistent-api`, gebouwd uit deze map (`Dockerfile`, Python 3.12, non-root user `app`, uid 10001) |
| Poort | **8000** (gunicorn, `gunicorn.conf.py`) |
| Health | `GET /health` (ook `/api/health`) geeft `{"status":"healthy","version":"1.1"}`. Gebruik dit voor liveness-, readiness- en startup-probes. |
| API | `/api/v1/storage/...`, elke route vraagt `Authorization: Bearer <Open WebUI-token>` |
| Afhankelijkheden | Open WebUI (tokencontrole), Azure Blob Storage, en een AI-voorziening: Azure AI Foundry-project of LiteLLM |
| Resources | 0,5 vCPU / 1 GiB is genoeg, met `WEB_CONCURRENCY=2` |

## Omgevingsvariabelen

Bron: `app/core/config.py` en `main.py`. In de container wordt alleen de omgeving gelezen (het image zet `SCHRIJFASSISTENT_IN_CONTAINER=1`). Lokaal leest de backend ook `backend/.env`; een omgevingsvariabele gaat altijd voor op het bestand.

### Nodig

| Variabele | Secret | Standaard | Wat |
|---|---|---|---|
| `OPENWEBUI_INTERNAL_URL` | nee | geen | Basis-URL van Open WebUI zoals de backend die bereikt (in Azure de interne URL van de Open WebUI Container App). **Verplicht: zonder deze waarde start de backend niet.** Per token roept de backend `GET {url}/api/v1/auths/` aan. |
| `AI_PROVIDER` | nee | `foundry` | Welke AI-voorziening de backend aanroept: `foundry` of `litellm`. Zie [AI-voorziening](#ai-voorziening). |
| `AI_MODEL` | nee | Foundry: `chat-agent`; LiteLLM: geen | Naam van het model: bij Foundry de deployment-naam, bij LiteLLM de modelnaam zoals die in LiteLLM staat. **Bij `litellm` verplicht.** Hiermee hernoem je het model zonder codewijziging. |
| `PROJECT_ENDPOINT` | **ja** | leeg | Alleen bij `AI_PROVIDER=foundry`. Project-endpoint van Azure AI Foundry, bijv. `https://<resource>.services.ai.azure.com/api/projects/<project>`. Het project moet een deployment met de naam uit `AI_MODEL` hebben. Zonder deze waarde start de app wel, maar de AI-routes werken niet (503 of fout). |
| `LITELLM_URL` | nee | leeg | Alleen bij `AI_PROVIDER=litellm`. Basis-URL van de LiteLLM-proxy, met of zonder `/v1`. Op dev: `http://aca-flair-litellm-dev-schrwzr/v1` (interne naam in de Container Apps-omgeving). |
| `LITELLM_API_KEY` | **ja** | leeg | Alleen bij `AI_PROVIDER=litellm`. Virtual key van LiteLLM voor deze backend. Nooit in code of `.env.example` zetten. |
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

De secrets (`AZURE_STORAGE_CONNECTION_STRING`, en `PROJECT_ENDPOINT` of `LITELLM_API_KEY` afhankelijk van `AI_PROVIDER`) horen als Container App-secret te staan, met de env var als `secretref`.

## AI-voorziening

Alle AI-aanroepen lopen via `app/services/ai_agent.py`. De routes (suggesties, titel, samenvatting) merken niet welke voorziening gebruikt wordt.

| `AI_PROVIDER` | Nodig | Inloggen |
|---|---|---|
| `foundry` (standaard) | `PROJECT_ENDPOINT`, optioneel `AI_MODEL` (standaard `chat-agent`) | `DefaultAzureCredential`: managed identity in Azure, `az login` lokaal. Vraagt de Foundry-rollen hieronder. |
| `litellm` | `LITELLM_URL`, `LITELLM_API_KEY`, `AI_MODEL` | De virtual key. Geen Azure-rol voor AI nodig. |

Overstappen naar LiteLLM op de Container App:

```bash
# 1. de virtual key als Container App-secret (de waarde niet in een script of pipeline opslaan)
az containerapp secret set -n <app> -g <resource group> --secrets litellm-api-key=<virtual key>
#    of als Key Vault-referentie, zoals de andere secrets:
#    --secrets litellm-api-key=keyvaultref:<key vault secret-URI>,identityref:<resource-id van de user-assigned identity>
# 2. de env vars
az containerapp update -n <app> -g <resource group> --set-env-vars \
  AI_PROVIDER=litellm \
  LITELLM_URL=http://aca-flair-litellm-dev-schrwzr/v1 \
  AI_MODEL=<modelnaam in LiteLLM> \
  LITELLM_API_KEY=secretref:litellm-api-key
```

Terug naar Foundry: `AI_PROVIDER=foundry` (of de variabele weghalen). `PROJECT_ENDPOINT` kan daarvoor blijven staan.

In de log staat bij het opstarten `AI provider <foundry|litellm> initialized (model <naam>)`. Ontbreekt er iets, dan staat er een waarschuwing en geven de AI-routes 503.

### Model kiezen per configuratie, kop en opdracht

Met `AI_PROVIDER=litellm` kan een beheerder in de configurator een ander model kiezen dan `AI_MODEL`: bovenaan elk onderdeel dat AI gebruikt (Hoofdstukken: structuur en spelling; B1-parameters: Direct Duidelijk; Woordenlijst; Eigenschappen: standaardmodel, titel en samenvatting) en per kop met de schakelaar **Eigen AI-model voor deze kop**. Terminologie, Regels en de B1-meters gebruiken geen AI, bijvoorbeeld een snel, goedkoop model voor spelling en woordenlijst en een slim model voor structuur en samenvatting. De keuze staat in de configuratie in Storage, in `metadata.json` en in de JSON van een kop, in dezelfde vorm:

```json
"aiModellen": { "standaard": "<model>", "opdrachten": { "agent_spelling_grammatica": "<model>", "titel": "<model>" } }
```

De meest specifieke keuze wint (`app/core/model_resolver.py`): kop + opdracht, kop, configuratie + opdracht, configuratie, en anders `AI_MODEL`. Titel en samenvatting (`titel`, `samenvatting`) kies je alleen op de configuratie; de frontend stuurt daarvoor `config_id` mee. Zonder `aiModellen` werkt een configuratie zoals voorheen.

- De keuzelijst komt uit `GET /api/v1/storage/ai-models` (alleen beheerder). Die vraagt LiteLLM `/v1/models` met de key van de backend, dus de lijst bevat alleen de modellen die die key mag gebruiken. De key komt niet in de browser. De lijst wordt 5 minuten bewaard.
- Welke modellen beschikbaar zijn, regel je dus in LiteLLM op de key van de Schrijfassistent. Tip: gebruik aliassen met een betekenis (bijv. `schrwzr-snel`, `schrwzr-slim`), dan hoeft geen configuratie aangepast te worden als het onderliggende model wisselt.
- Staat een gekozen model niet (meer) in de lijst, of weigert LiteLLM het, dan valt de backend terug op het volgende niveau (uiteindelijk `AI_MODEL`) en zet een waarschuwing in de log. De schrijver merkt er niets van.
- Met `AI_PROVIDER=foundry` is er geen keuze: alle aanroepen gebruiken `AI_MODEL`, ook als een configuratie `aiModellen` heeft.

### Tellen gebeurt in code, niet door de AI

Een taalmodel kan woorden en zinnen niet betrouwbaar tellen. Daarom telt de backend de tekst van een kop zelf (`app/core/text_count.py`) en geeft de telling mee in de prompt van de structuurcontrole (`agent_structuur`) en Direct Duidelijk (`agent_b1`), tussen de antwoordregels en de invoer. De AI hoeft dan niet meer te tellen, alleen te formuleren.

- **Woord**: alles tussen spaties met minstens één letter of cijfer. Losse leestekens (`-`, `–`, `•`, `€`) tellen niet, en een leesteken splitst geen woord (`GS-voorstel`, `4-5`, `50.000` zijn één woord). Nummering aan het begin van een regel (`1.`, `1.1`, `a)`) telt niet.
- **Zin**: eindigt op `.`, `!`, `?` of `…`, en aan het eind van een regel. Niet na een afkorting (`bijv.`, `o.a.`, `art.`, `d.w.z.`) of een initiaal (`J.`).
- **Alinea**: elke regel (Enter in de editor), zoals in Word.
- **Lengteregels**: staat in de instructie een regel die alleen een limiet is (`• Maximaal 5 woorden`, `• Maximaal 15 woorden per zin`, `• Hooguit drie zinnen`, `• Maximaal 80 woorden per alinea`), dan controleert de backend die zelf en zet de uitkomst ("voldoet" / "voldoet NIET", met de aantallen) in de prompt. Een regel over een deel van de tekst (`Toelichting in maximaal twee zinnen ...`) en `Maximaal N regels` (gedrukte regels) blijven bij de AI, die wel de telling per zin en per alinea krijgt.
- De B1-meters in de frontend tellen met dezelfde regels (`frontend/src/lib/utils/textCount.js`). `dev/fixtures/text-count-cases.json` bevat de gedeelde testgevallen die beide testsuites controleren.

## Azure-rechten

De code gebruikt twee manieren van inloggen:

- **AI Foundry** (bij `AI_PROVIDER=foundry`) via `DefaultAzureCredential` (`app/services/ai_agent.py`). In Azure is dat de managed identity van de Container App; lokaal je `az login`. Bij `AI_PROVIDER=litellm` is de virtual key genoeg en zijn de AI-rollen hieronder niet nodig.
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
- Uitgaand naar het storage-account en de AI-voorziening (het AI Foundry-endpoint, of LiteLLM binnen dezelfde Container Apps-omgeving).
- AI-aanroepen kunnen lang duren: gunicorn staat 230 s toe. Zet de origin-timeout van Front Door op 240 s (standaard 60 s geeft 504).
- `upload-configuration` kan groter zijn dan de standaard WAF-limiet (128 KB); verhoog die voor alleen die route naar 12 MiB.

## Lokaal draaien

Vereist: Python 3.12, Azure CLI (voor echte AI via Foundry) en een draaiende Open WebUI (standaard `http://localhost:3000`).

Foundry en LiteLLM zijn allebei alleen bereikbaar vanuit het Azure-netwerk. Kan je machine daar niet bij, start dan zonder `.env` met `schrijfassistent/dev/run-local-dev.sh`: die gebruikt opgenomen AI-antwoorden.

```bash
cd schrijfassistent/backend
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env      # en vul in: OPENWEBUI_INTERNAL_URL, AZURE_STORAGE_* en de AI-voorziening
az login                  # alleen bij AI_PROVIDER=foundry (DefaultAzureCredential)

uvicorn main:app --reload --port 8000
curl http://localhost:8000/health
```

`python main.py` start ook, maar dan op poort 8001.

Met Docker:

```bash
docker build -t schrijfassistent-api schrijfassistent/backend
docker run --rm -p 8000:8000 \
  -e OPENWEBUI_INTERNAL_URL=http://host.docker.internal:3000 \
  -e AI_PROVIDER=litellm -e LITELLM_URL=... -e LITELLM_API_KEY=... -e AI_MODEL=... \
  -e AZURE_STORAGE_CONNECTION_STRING=... \
  -e AZURE_STORAGE_CONTAINER_NAME=govchat-docs \
  schrijfassistent-api
```

Met Foundry in plaats van LiteLLM zet je `-e PROJECT_ENDPOINT=...`. In de container werkt `az login` niet; voor Foundry heb je dan een service principal nodig (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_SECRET`, die `DefaultAzureCredential` oppakt) of je test de AI-routes buiten Docker.

Unittests (geen netwerk of storage nodig):

```bash
pip install pytest
pytest tests
```

## Logging

Eén regel per AI-aanroep: `ai-call task=<opdracht> model=<model> source=<kop-opdracht|kop|configuratie-opdracht|configuratie|standaard> config=<id> chapter=<kop>`, zonder notatekst.

Eén regel per aanvraag: `auth=<openwebui|denied> route=<methode pad>`. Het token en de inhoud van nota's worden nooit gelogd; de gunicorn access log staat in de container uit. Andere regels om op te letten: `role-check=denied` (niet-beheerder probeert configuratie te wijzigen) en `Conflict on nota` (409 bij opslaan).
