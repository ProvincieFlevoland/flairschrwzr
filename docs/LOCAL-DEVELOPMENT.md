# Lokale ontwikkelomgeving met Docker

## Starten

Nodig: Docker Desktop (Linux-containers) of Docker Engine met Compose **2.24+**
en BuildKit. Zorg dat poorten **3000**, **3002** en **8011** vrij zijn.

Voer vanuit de repository-root uit, bijvoorbeeld in PowerShell:

```powershell
docker compose -f docker-compose.local.yaml up --build -d
```

Compose bouwt de images en start de omgeving. De eerste start kan enkele minuten duren.

| Onderdeel | Adres |
|---|---|
| Open WebUI | <http://localhost:3000> |
| Admin-paneel | <http://localhost:3002> (wachtwoord: `lokaal123`) |
| Backend-healthcheck | <http://localhost:8011/health> |

Maak bij het eerste bezoek aan Open WebUI een account aan. Open daarna
**App Launcher → Schrijfassistent**. Een admin kan via **Als auteur werken**
naar de auteursweergave.

## Wat draait er?

Alles staat in `docker-compose.local.yaml`:

| Service | Functie |
|---|---|
| `open-webui` | Chatomgeving en gebruikerslogin. |
| `govchat-admin` | Admin-paneel en publicatie van de frontend in Open WebUI. |
| `schrijfassistent-backend-base` | Bouwt de backendbasis met de productie-Dockerfile; de helpercontainer sluit direct af. |
| `schrijfassistent-backend` | API op poort 8011, met lokale ontwikkelhulpmiddelen. |
| `schrijfassistent-blobstorage-emulator` | Lokale opslag voor nota's en configuraties; geen hostpoort nodig. |

Compose bouwt `schrijfassistent-api-dev:local` met
`schrijfassistent/dev/Dockerfile.backend`, boven op de backendbasis.
Backend en emulator gebruiken ditzelfde image met verschillende startopdrachten.
De frontend wordt apart gebouwd via `admin/Dockerfile`.
Productie-Dockerfiles en productiecontainers worden niet aangepast; er wordt
niets naar een registry gepusht.

Bij iedere backendstart worden ontbrekende fixtures geladen: de GS-nota
v5-configuratie en drie voorbeeldnota's. Bestaande blobs worden niet overschreven.
Daarna start de API. Deze initialisatie is uitsluitend toegestaan op de lokale
emulator. Gebruikerslogin blijft via de echte lokale Open WebUI lopen.

## AI: voorbeeldantwoorden of LiteLLM

Standaard gebruikt de backend **opgenomen voorbeeldantwoorden** (`AI_MOCK=1`).
Er wordt geen AI-service aangeroepen. Dit werkt het best met de voorbeeldnota's.

Voor echte LiteLLM-aanroepen stel je vóór het starten in PowerShell in:

```powershell
$env:SCHRIJFASSISTENT_AI_MOCK = "0"
$env:SCHRIJFASSISTENT_LITELLM_URL = "http://host.docker.internal:4000/v1"
$env:SCHRIJFASSISTENT_LITELLM_API_KEY = "<virtual-key>"
$env:SCHRIJFASSISTENT_AI_MODEL = "<modelnaam>"
docker compose -f docker-compose.local.yaml up --build -d
```

Vervang de URL door een proxy die vanuit Docker bereikbaar is.
`host.docker.internal` verwijst bij Docker Desktop naar je eigen machine.
Een interne Azure-hostnaam is niet automatisch lokaal bereikbaar.
Ook met LiteLLM blijft de opslag lokaal. **`az login` is niet nodig.**

Compose leest optioneel `schrijfassistent/backend/.env`. De expliciete
`environment`-waarden in Compose gaan voor, ook als ze leeg zijn. Gebruik voor
AI daarom de bovenstaande `SCHRIJFASSISTENT_*`-variabelen, niet de AI-waarden
in dat bestand. Sla echte API-keys niet op in Git.

## Stoppen en wijzigingen toepassen

Stoppen met behoud van gegevens:

```powershell
docker compose -f docker-compose.local.yaml down
```

Na code- of configuratiewijzigingen opnieuw bouwen en starten:

```powershell
docker compose -f docker-compose.local.yaml up --build -d
```

Gegevens blijven in Docker-volumes bewaard. **Gebruik niet zomaar `down -v`:**
dat verwijdert ook accounts, admin-instellingen en nota's.
Gebruik uitsluitend testdata; mocklogs kunnen tekstfragmenten bevatten.

## Problemen oplossen

Bekijk de status en backendlogs:

```powershell
docker compose -f docker-compose.local.yaml ps -a
docker compose -f docker-compose.local.yaml logs --tail 100 schrijfassistent-backend
```

| Probleem | Controle / oplossing |
|---|---|
| Poort bezet | Stop de toepassing die poort 3000, 3002 of 8011 gebruikt. |
| App Launcher ontbreekt | Wacht circa 15 seconden; herstart zo nodig met `docker compose -f docker-compose.local.yaml restart govchat-admin`. |
| Backend geeft 401 | Log opnieuw in bij Open WebUI en controleer of `open-webui` draait. |
| Backend start niet | Bekijk de backend- en emulatorlogs. Fixture-initialisatie moet slagen voordat de API start. |
| LiteLLM werkt niet | Controleer bereikbaarheid vanuit Docker, API-key, modelnaam en `SCHRIJFASSISTENT_AI_MOCK=0`. |

Een succesvolle `/health`-aanvraag bevestigt alleen dat de API draait,
niet dat Open WebUI of LiteLLM bereikbaar is.
