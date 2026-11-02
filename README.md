# GovChat-NL Overlay voor Open WebUI

> [!WARNING]
> **Status: niet productierijp / niet gegarandeerd werkend.**
> Deze repository wordt gedeeld als **inspiratie en referentie-implementatie** voor leveranciers en mede-overheden.
> Gebruik dit niet als kant-en-klare productieoplossing zonder eigen validatie, security review, hardening en acceptatietesten.

## Provincie Flevoland deployment (this repo)

This is Flevoland's own working copy of the codebase, migrated on 2026-09-28 from the
`BvO-Flevoland/GovChat-AdminOverlay` GitHub fork into this Azure Repos repository so the
docker-build pipeline in `tf-azure-ai-govchat` builds from an internal, access-controlled
source instead of a public GitHub fork. The rest of this README is the original upstream
GovChat-NL project documentation and still describes how the overlay itself works.

- **Live app**: https://flair-dev.ai.flevoland.nl (Open WebUI + this overlay)
- **Versimpelaar / n8n**: https://n8n-dev.ai.flevoland.nl (webhook + n8n UI, reachable via
  Front Door + Private Link; the underlying Container Apps environment is internal-only)
- The App Launcher here only exposes **Chat** and **Versimpelaar** — Beleidskompas and Live
  transcriptie were intentionally removed for this deployment.
- The App Launcher is a sidebar entry (next to Notes/Workspace), not a top-navbar button —
  a deliberate deviation from upstream to avoid colliding with Open WebUI's own sidebar toggle.

**To roll out a change:** push a release tag `vX.Y.Z` on `main` (see *Releases en
container-images* below). GitHub Actions builds the image once, publishes it to ghcr.io and then
notifies Azure DevOps, which points the TEST container app at that exact ghcr.io image.
Azure DevOps no longer builds the image, and no ACR is involved.

The GitHub fork (`BvO-Flevoland/GovChat-AdminOverlay`) is left in place for now as a historical
reference; this repo is what the pipeline actually builds from going forward.

### Releases en container-images

Elke versie levert precies één vast image op. De workflow staat in
`.github/workflows/build.yml`.

| Gebeurtenis | Wat er gebeurt |
|---|---|
| Pull request naar `main` (ook uit forks) | Image bouwen en scannen met Trivy. Geen login, geen secrets, niets gepubliceerd. |
| Handmatig: *Actions → Container images → Run workflow* op een branch | Hetzelfde als een pull request: bouwen en scannen, niets gepubliceerd. |
| Tag `vX.Y.Z` op een commit in `main` | Tag controleren, één keer bouwen en pushen naar ghcr.io. |

**Images**

| Image | Dockerfile | Build context |
|---|---|---|
| `ghcr.io/provincieflevoland/flairschrwzr-admin:vX.Y.Z` | `admin/Dockerfile` | `admin/` |

Het admin-image is `node:20-alpine`. Dependencies worden in een aparte stage geïnstalleerd met
`npm ci --omit=dev` (volgens `package-lock.json`). In het uiteindelijke image staan alleen node,
`node_modules`, `server.js`, `views/` en `defaults/`; npm, corepack en yarn zijn eruit gehaald.
De container luistert op poort 3002.
Een nieuw image voeg je toe als extra regel in de `matrix` van zowel `pr-build` als `release`.

**Buildstappen bij een versietag**

1. `verify-tag` controleert dat de tag de vorm `vX.Y.Z` heeft en dat de commit op `main` staat.
2. De build stopt als `vX.Y.Z` al op ghcr.io staat: een versie wordt nooit opnieuw gebouwd.
   Nieuwe wijziging betekent een nieuwe tag.
3. Het image wordt gebouwd met build-args `VERSION` en `GIT_COMMIT` en gepusht als `vX.Y.Z`.
   `latest` schuift alleen mee als dit de hoogste versie is (een hotfix op een oudere lijn
   verschuift `latest` dus niet).
4. Het digest staat in de samenvatting van de run. Omgevingen (dev/test/prod) krijgen
   precies dit image, op digest, en bouwen niet opnieuw.

**Uitrol naar Azure (dev/test)**

De uitrol loopt zonder ACR: de Container App haalt het image direct van ghcr.io.

1. Na een geslaagde push van alle images start de job `notify-ado` in
   `.github/workflows/build.yml`. Die stuurt `{"tag":"vX.Y.Z"}` naar de ADO-webhook
   `gh-schrijfassistent-webhook`, ondertekend met de header `X-Hub-Signature` (HMAC-SHA1 met het
   secret `ADO_WEBHOOK_SECRET`). Bestond de versie al, of is het een pull request, dan wordt ADO
   niet aangeroepen. Geeft ADO geen 2xx terug, dan faalt de GitHub-run.
2. De ADO-pipeline (Incoming WebHook-service connection `sc-schrijfassistent-webhook`) leest
   `tag` uit de payload en zet de Container App `aca-flair-admin-dev-schrwzr`
   (`rg-flairschrwzr-dev-001`) op `ghcr.io/provincieflevoland/flairschrwzr-admin:vX.Y.Z`.
3. ADO wacht tot de nieuwe revisie gezond is en doet een smoke test.

GitHub stuurt alleen versie-tags `vX.Y.Z`, nooit `latest`.

Benodigd:
- In GitHub het repository-secret `ADO_WEBHOOK_SECRET`, met dezelfde waarde als het secret in
  `sc-schrijfassistent-webhook`. Er is geen aparte GitHub-webhook voor *Registry packages* nodig;
  die zou ADO meerdere keren per release starten.
- Is het ghcr-package privé, dan heeft de Container App eenmalig een ghcr-login nodig (token met
  alleen `read:packages`):
  `az containerapp registry set -n aca-flair-admin-dev-schrwzr -g rg-flairschrwzr-dev-001 --server ghcr.io --username <github-user> --password <token>`

**Versienummers (semantic versioning)**

Versies hebben de vorm `vMAJOR.MINOR.PATCH`. Bij een nieuwe release verhoog je één deel:

| Deel | Wanneer verhogen | Voorbeeld |
|---|---|---|
| `MAJOR` | Wijziging die niet terugwaarts compatibel is (breaking), bijvoorbeeld een verwijderde of hernoemde configuratie-optie | `v1.4.2` → `v2.0.0` |
| `MINOR` | Nieuwe functionaliteit die bestaande installaties niet breekt | `v1.4.2` → `v1.5.0` |
| `PATCH` | Alleen bugfixes, geen nieuwe functionaliteit | `v1.4.2` → `v1.4.3` |

Verhoog je een deel, dan gaan de delen erachter terug naar 0. Een verloop kan er zo uitzien:
`v0.1.0` (eerste release) → `v0.1.1` (bugfix) → `v0.2.0` (nieuwe feature) → `v1.0.0`
(eerste stabiele versie, of een breaking change). Zolang de versie met `v0.` begint, geldt
de software als nog niet stabiel.

Tags zet je altijd op een commit in `main`; een tag op een andere branch wordt door
`verify-tag` geweigerd. `latest` schuift alleen mee bij de hoogste versie: een patch op een
oudere lijn (bijvoorbeeld `v1.4.3` terwijl `v2.0.0` al bestaat) verplaatst `latest` niet.

**Een release maken**

```bash
git checkout main && git pull
git tag v1.2.0
git push origin v1.2.0
```

Of via GitHub: *Releases → Draft a new release → Choose a tag → `v1.2.0`* op `main`.

**Lokaal dezelfde build draaien**

```bash
docker build -f admin/Dockerfile -t flairschrwzr-admin:dev admin
docker run --rm -p 3002:3002 flairschrwzr-admin:dev
```

---

## Doel van publicatie

- Inspiratie bieden voor leveranciersselectie en doorontwikkeling binnen overheidscontext.
- Transparant delen van architectuurkeuzes en implementatie-ideeën.
- Niet bedoeld als “direct deploybaar” standaardproduct.

Een configureerbare overlay die **help-button**, **app launcher** en **admin panel** toevoegt aan een standaard [Open WebUI](https://github.com/open-webui/open-webui) deployment — zonder fork, zonder codewijzigingen.

Ontwikkeld als onderdeel van [GovChat-NL](https://govchat-nl.nl), het open-source AI-chatplatform voor de Nederlandse overheid.

## Wat zit erin?

| Component | Omschrijving |
|---|---|
| **Help-button** | Floating "?" button rechtsonder met een complete handleiding-modal |
| **App Launcher** | Grid met apps rechtsboven in de navbar (Versimpelaar, externe tools, etc.) |
| **Admin Panel** | Webinterface om handleiding en apps te beheren — zonder herbouw van het Docker image |
| **Versimpelaar** | Ingebouwde tekstvereenvoudiger (B1/B2 taalniveau) via n8n webhook |

## Architectuur

Elke gemeente draait twee containers:

1. **`ghcr.io/open-webui/open-webui:<versie>`** — het officiële Open WebUI image, versie naar keuze
2. **`ghcr.io/.../govchat-overlay-admin:latest`** — publiceert alle overlay-bestanden

Communicatie verloopt via een **shared Docker volume**:

```
┌─────────────────────┐                        ┌──────────────────┐
│   Open WebUI         │  ← shared volume ──   │  govchat-admin   │
│   (officieel image)  │   /app/backend/static  │  (Node.js/Express)│
│                      │                        │                  │
│   Serveert:          │                        │  Publiceert:     │
│   loader.js          │                        │  loader.js       │
│   custom.css         │                        │  custom.css      │
│   help-content.json  │                        │  help-content.json│
│   apps.json          │                        │  apps.json       │
└─────────────────────┘                        └──────────────────┘
                                                       │
                                                ┌──────┴──────┐
                                                │  Beheerder   │
                                                │  :3002       │
                                                │  Admin UI    │
                                                └─────────────┘
```

**Startup-volgorde:**
1. Open WebUI start → kopieert eigen defaults naar STATIC_DIR
2. Admin container start → publiceert overlay-bestanden naar hetzelfde volume (overschrijft defaults)
3. Browsers laden de overlay via `/static/loader.js`

**Er is geen custom Docker image meer nodig.** Gemeentes kiezen zelf hun Open WebUI versie.

## Snel starten

```bash
# Clone de repository
git clone https://github.com/MarjoleinVerP/open-webui-govchat-overlay.git
cd open-webui-govchat-overlay

# Start met docker compose (productie-voorbeeld met alle services)
GOVCHAT_ADMIN_PASSWORD=mijnwachtwoord docker compose -f docker-compose.govchat.yaml up -d
```

Open daarna:
- **Open WebUI**: http://localhost:3000
- **Admin Panel**: http://localhost:3002

## Bestanden

```
open-webui-help-overlay/
├── loader.js                     # Injecteert help-button, app launcher, versimpelaar
├── custom.css                    # Alle styling (dark mode, responsive)
├── help-content.json             # Standaard handleiding (fallback)
├── apps.json                     # Standaard apps config (fallback)
├── docker-compose.yaml           # Basis compose (ontwikkeling)
├── docker-compose.govchat.yaml   # Productie config (volledig voorbeeld)
└── admin/
    ├── Dockerfile                # Admin panel image (node:20-alpine)
    ├── package.json
    ├── server.js                 # Express server met API + admin UI
    ├── views/
    │   ├── login.html            # Login pagina
    │   ├── dashboard.html        # Overzicht met snelkoppelingen
    │   ├── help-editor.html      # WYSIWYG handleiding-editor
    │   └── apps-editor.html      # Apps configuratie
    └── defaults/
        ├── help-content.json     # Standaard handleiding
        ├── apps.json             # Standaard apps config
        ├── loader.js             # Standaard overlay loader
        └── custom.css            # Standaard overlay styling
```

## Admin Panel

Het admin panel draait als aparte container en biedt:

- **Handleiding bewerken** — WYSIWYG editor met rich text toolbar, emoji picker, secties en subsecties toevoegen/verwijderen
- **Apps configureren** — Apps toevoegen, verwijderen, herschikken met emoji picker en target type (navigate/iframe/blank/versimpelaar)
- **App Launcher aan/uit** — Toggle om de app launcher knop te verbergen
- **Direct publishing** — Wijzigingen worden direct naar Open WebUI gepubliceerd via een shared Docker volume

Beveiligd met een wachtwoord via de `GOVCHAT_ADMIN_PASSWORD` environment variable.

## Features

- Floating "?" help-button rechtsonder
- Modal met sidebar-navigatie en collapsible secties
- App launcher knop rechtsboven in de navbar
- Versimpelaar voor tekstvereenvoudiging (B1/B2)
- Dark mode support (volgt Open WebUI theme)
- Print-functie en fullscreen toggle
- "Niet meer automatisch tonen" checkbox
- `{{APP_NAME}}` placeholder-support
- Configureerbaar via admin panel (geen herbouw nodig)

## Configuratie via environment variables

| Variable | Omschrijving | Voorbeeld |
|---|---|---|
| `GOVCHAT_ADMIN_PASSWORD` | Wachtwoord voor het admin panel | `geheim123` |
| `STATIC_DIR` | Open WebUI static directory (belangrijk!) | `/app/backend/static` |
| `CORS_ALLOW_ORIGIN` | Toegestane origin voor API calls | `https://chat.organisatie.nl` |
| `WEBUI_NAME` | Naam van de applicatie | `GovChat` |

**Let op**: `STATIC_DIR=/app/backend/static` is vereist in de Open WebUI container zodat de overlay-bestanden correct worden geserveerd.

## Updaten naar nieuwe Open WebUI versie

Pas de image tag aan in je `docker-compose.govchat.yaml`:

```yaml
open-webui:
  image: ghcr.io/open-webui/open-webui:v0.9.0   # nieuwe versie
```

Herstart:

```bash
docker compose -f docker-compose.govchat.yaml up -d
```

De overlay-bestanden worden automatisch opnieuw gepubliceerd door de admin container. Er hoeft geen image herbouwd te worden.

---

## GovChat-NL

Dit project is onderdeel van **[GovChat-NL](https://govchat-nl.nl)** — een initiatief dat AI-chattools toegankelijk en veilig maakt voor de Nederlandse overheid.

### Wat is GovChat-NL?

GovChat-NL is een open-source AI-chatplatform specifiek ontwikkeld voor Nederlandse overheidsorganisaties. Het biedt een veilige, privacy-vriendelijke omgeving waarin ambtenaren kunnen werken met grote taalmodellen (LLMs), zonder dat gevoelige gegevens naar externe partijen gaan.

### Wie werken eraan?

GovChat-NL is een samenwerkingsverband van Nederlandse overheidsorganisaties — gemeenten, provincies en andere publieke instellingen — die samen werken aan veilige en toegankelijke AI-tools.

### Meedoen of interesse?

GovChat-NL is open source en staat open voor deelname van alle Nederlandse overheidsorganisaties.

- **Website**: [govchat-nl.nl](https://govchat-nl.nl)
- **Contact**: Neem contact op via de website voor meer informatie over deelname
- **GitHub**: Bekijk de broncode, dien issues in of draag bij via pull requests
- **Licentie**: Open source — vrij te gebruiken en aan te passen

Of je nu een gemeente, provincie, waterschap of andere overheidsorganisatie bent: je bent welkom om GovChat-NL te gebruiken, te testen en mee te ontwikkelen.
