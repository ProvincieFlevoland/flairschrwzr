# Schrijfassistent backend: HTTP API

This file describes the HTTP API of the Schrijfassistent backend (`schrijfassistent/backend`) and the JSON shapes it stores. The frontend calls it through `frontend/src/lib/apiClient.js`.

## 1. Base URL and transport

| Item | Value |
|---|---|
| API prefix | `{api_base_url}/api/v1`. The launcher card sets `api_base_url`; the default is `/apps/schrijfassistent`, a path on the Open WebUI host. |
| Path rule | A Front Door rule strips the prefix `/apps/schrijfassistent`, so the backend receives `/api/v1/...`. If the rule cannot strip the prefix, set `ROOT_PATH=/apps/schrijfassistent` and the backend answers under that prefix as well. |
| Health | `GET /health` and `GET /api/health` return `{"status": "healthy", "version": "1.1"}`. Both need no token. |
| Content type | JSON request and response bodies, UTF-8. |
| CORS | An allow-list of origins (`CORS_ALLOW_ORIGINS`), the methods GET, POST, PUT, PATCH, DELETE and OPTIONS, the request headers `Authorization`, `X-Nota-Base-Modified`, `If-Match` and `Content-Type`, no credentials. The response header `ETag` is exposed. |
| Errors | FastAPI's default `{detail: string | object}`. |

The backend serves the API only. The frontend ships as a bundle through the admin image.

## 2. Authentication and roles

Every route under `/api/v1/storage` needs a verified Open WebUI user. The only accepted credential is the Open WebUI token as `Authorization: Bearer <token>`. The `token` cookie is not accepted.

The backend verifies the token with `GET {OPENWEBUI_INTERNAL_URL}/api/v1/auths/` and gets `{id, email, name, role}` back.

| Case | Answer | Log line |
|---|---|---|
| Open WebUI accepts the token | the request goes on | `auth=openwebui user_id=<id> route=<METHOD path template>` |
| No token, an unknown token, or Open WebUI is unreachable | 401 `{detail: "Niet ingelogd."}` | `auth=denied route=...` |

A positive answer is cached for 60 seconds per worker, keyed by the hash of the token. A token that Open WebUI revokes can therefore keep working for up to 60 seconds. A refused or unverifiable token is cached for 8 seconds, so an unreachable Open WebUI costs one round trip per token per 8 seconds. The backend never logs a token, a header value, an email address or a request body.

Roles. Open WebUI `role === 'admin'` is the `beheerder`; every other role is an `auteur`. The routes that change a configuration need a beheerder: `PATCH /configurations/{id}/metadata`, `POST /upload-configuration` and `DELETE /configurations/{id}`. For anyone else they answer 403 `{detail: "Alleen een beheerder mag configuraties wijzigen."}` and log `role-check=denied auth=.. user_id=.. role=.. route=..`. Reading configurations and all nota routes are open to every verified user, because an auteur needs the configurations to write a nota. Any auteur may write any nota.

Every successful configuration write logs one line: `config-write action=<patch|upload|delete> auth=openwebui user_id=<id> role=<role> id=<config id> deleted=<n> created=<n>`.

## 3. Storage and AI routes

All paths are relative to `{api_base_url}/api/v1/storage`. "Natural-sorted" means `app/core/utils.py` `natural_sort_key`.

Errors that the tables do not list:

- 400 for a value that cannot be part of a blob name (section 3.1) or for an invalid `blockWorkflow`.
- 413 when the body is larger than the route allows (section 3.2).
- 422 when FastAPI cannot validate the request.
- 500 `{detail: "Opslaan of ophalen in de opslag is mislukt. Probeer het later opnieuw."}` for an unexpected exception in a storage route. The text is fixed; the exception text goes to the log only. The AI routes keep their own 500 texts.
- 503 `{detail: "Azure Storage is unreachable: ..."}` when a read route cannot reach storage.

### 3.1 Configurations

| Method and path | Request | Response | Notes |
|---|---|---|---|
| `GET /configurations` | none | `{configurations: string[]}` | top-level blob prefixes except `notas`, natural-sorted |
| `GET /configurations/{config_id}/metadata` | none | the `metadata.json` object (section 5.2); 404 when missing | |
| `PATCH /configurations/{config_id}/metadata` | `{isActive: bool}` | `{status: "success", metadata: object}` | beheerder; reads `metadata.json`, merges, writes |
| `GET /configurations/{config_id}/subfolders` | none | `{subfolders: string[]}` | |
| `GET /configurations/{config_id}/{subfolder}/data` | none | `{data: object[]}` | every `*.json` under the prefix, natural-sorted by blob name |
| `POST /upload-configuration` | `{[folder: string]: {...metadata, mappen: {[sub: string]: object[]}}}` | `{status, config_id, action: "rebuilt" or "created", files_deleted, files_created, message}` | beheerder; deletes the `{folder}/` prefix, writes `metadata.json` (everything except `mappen`), then `{folder}/{sub}/{item.id or index}.json` per item |
| `DELETE /configurations/{config_id}` | none | `{status, deleted_count, message}` | beheerder; deletes the prefix |

Blob names. One guard (`app/core/blob_guard.py`) checks every request value that becomes part of a blob name before any blob is touched, and answers 400 `{detail: "..."}` for a value it refuses. The checks run before the `try:` of the route, so a refusal is never turned into a 500. They cover the configuration id in every path, the `subfolder`, the folder key of `POST /upload-configuration`, the subfolder names (`mappen` keys) and item ids in it, the nota id, `blob_name`, and the `config_id` and `chapter_id` of `POST /generate-agent-response`.

A value is accepted when it is one segment of letters (Unicode letters are allowed), digits, underscore, space, dot and hyphen, with at most 128 characters. It must not have a leading or trailing space or dot, and must not contain `..`, a slash, a backslash, `?`, `#`, `%` or a control character. The configuration id `notas` (any case) is reserved. An item id may also be a plain integer; an item without an id is filed under its index. A malformed upload (content that is not an object, `mappen` that is not an object, a subfolder that is not a list) is a 400 as well. An empty body of `POST /upload-configuration` is a 400 `Empty JSON body`.

### 3.2 Request body limits

`app/core/body_limit.py` is an ASGI middleware that sits in front of the routes and inside the CORS middleware, so a 413 carries the CORS headers.

| Route | Limit | Setting |
|---|---|---|
| `POST /upload-configuration` | 12 MiB | `MAX_BODY_BYTES_UPLOAD_CONFIGURATION` |
| `PUT /notas/{id}`, `POST /summarize-nota`, `POST /generate-nota-title` | 10 MiB | `MAX_BODY_BYTES_NOTA` |
| every other route | 2 MiB | `MAX_BODY_BYTES_DEFAULT` |

The frontend refuses a configuration import above 10 MiB; the v5 configuration is 135,647 bytes. A declared `Content-Length` above the limit is refused before the body is read. A body without a declared length (chunked) is counted while it streams. The answer is 413 `{detail: "De aanvraag is te groot (maximaal N MB voor deze route)"}`.

### 3.3 Raw blob helper

| Method and path | Request | Response | Notes |
|---|---|---|---|
| `GET /download/{blob_name}` | none | `{content: string}` | the UI does not use it; `blob_name` must be one safe segment, so `notas/n1.json` and `../x` are 400 |

### 3.4 AI

| Method and path | Request | Response | Notes |
|---|---|---|---|
| `POST /generate-agent-response?config_id=&chapter_id=&assignment=` | the three query parameters and a JSON body `{"user_message": "..."}` | `{ai_response: object or string, validated: bool, warning?: string}` | The nota text travels in the body and is never logged. A missing body is 422. 404 when the configuration, chapter or assignment is missing (except `agent_spelling_grammatica`, which falls back to its default instruction). 422 `{detail: {error, details, raw_response}}` is raised when the answer does not match the template, and the route answers it as a 500 `Agent communication error: ...`. 500 on an agent error. 503 when the AI client is not initialised. |
| `GET /agent-defaults` | none | `{instructions: {agent_spelling_grammatica: string}}` | The default instructions per assignment that `generate-agent-response` uses when the chapter's field is empty or missing. Read-only, any signed-in user; the configurator shows them next to an empty field. |
| `POST /generate-nota-title` | `{chapters: [{title: string, content: string}]}` | `{title: string}` | at most 5 words; quotes (a pair of the same character, or an opening and closing pair such as `“ ”`, `„ ”`, `« »`) and trailing punctuation are stripped; 400 without chapters |
| `POST /summarize-nota` | `{chapters: [{title: string, content: string}]}` | `{summary: string}` | at most 3 lines; 400 without chapters |

`generate-agent-response` loads `{config_id}/hoofdstukken/{chapter_id}.json`, uses `chapter[assignment]` as instruction (for `agent_spelling_grammatica` an empty or missing value is replaced by the default from `app/core/agent_defaults.py`) and `chapter[assignment + "_output_template"]` as the optional template, adds assignment-specific Dutch answer rules, and validates the answer with `validate_agent_response`. The answer rules only describe the answer format (JSON shape, `Origineel` copied verbatim from the text) that the bundle needs to read the answer; what an agent checks lives in the instruction, so a beheerder changes it in the configurator without a release.

### 3.5 Notas

| Method and path | Request | Response | Notes |
|---|---|---|---|
| `GET /notas` | none | `{notas: object[]}` | all `notas/*.json`; 503 on a storage error |
| `GET /notas/{nota_id}` | none | the nota object (section 5.1) | 404 when missing or on a storage error; 500 when the stored JSON is not an object; the answer carries the blob `ETag` header |
| `PUT /notas/{nota_id}` | the full nota JSON | `{status: "ok", blob: "notas/{nota_id}.json"}` | conditional write, see section 4; 400 when `blockWorkflow` is not an object or holds a value outside `concept`, `ai`, `review` and `done`; the answer carries the new `ETag` header |
| `DELETE /notas/{nota_id}` | none | `{status: "ok", deleted: "notas/{nota_id}.json"}` | |

## 4. Concurrent saves of a nota

`PUT /notas/{nota_id}` is a conditional write. Blob decides a race atomically, so two saves with the same base cannot both succeed.

| Request | Behaviour |
|---|---|
| `X-Nota-Base-Modified: <ISO 8601 lastModified>` (what the frontend sends) | The backend compares the value with the `lastModified` of the stored nota. The stored value is kept in the blob metadata `notalm`, so the comparison needs one properties request and no download; a nota stored without that metadata is read once. A mismatch is a 409. Otherwise the nota is written with `If-Match` of the ETag the comparison saw, and Blob refuses a lost race with 412, which the route answers as the same 409. |
| `If-Match: <ETag>` (from the `ETag` header of `GET /notas/{id}` or of the previous `PUT`) | The nota is written only when the blob still has that ETag. No read happens. A weak prefix `W/` is accepted. `If-Match` wins when both headers are present. |
| neither header | Last write wins. |

A first save (no stored blob, or a stored nota without a comparable `lastModified`) is accepted and written create-only.

The 409 answer is `{detail: {error: "conflict", stored_last_modified: string | null, base_last_modified: string | null, message: "De nota is intussen door iemand anders opgeslagen. Laad de nota opnieuw."}}`. The log line is `Conflict on nota '<id>': the stored version changed since it was loaded`.

How the frontend uses it:

- On a 409 it shows a conflict toast and keeps a warning in the header until the nota is loaded again. It does not retry a nota in conflict and keeps the local text as a copy.
- When an earlier `PUT` of the nota got no response (timeout, dropped connection, 5xx) and the 409 carries a `stored_last_modified` equal to the `lastModified` of that earlier body, the 409 is the client's own write. The frontend then takes `stored_last_modified` as the base and sends the nota once more.
- The `lastModified` in the body cannot serve as the base, because the editor overwrites it with the current time on every edit before the save.

## 5. JSON shapes

### 5.1 Nota (`notas/{id}.json`; the same object lives in `localStorage` under `gs_nota_db`)

```
id: string                    "n" + Date.now()
title: string
titleManuallySet: boolean
status: "WIP" | "Final-draft" | "Final"
lastModified: string          ISO 8601
configId: string
configName: string
templateVersion: string
toneOfVoice: string
allowedWords: string[]
authors: string[]             display-only name list
reviewers: string[]           display-only name list
content: string               HTML: a sequence of <h2 class="dynamic-chapter" data-chapter-id="hN">...</h2>
                              each followed by body HTML (p, br, strong, em, i, b, u, ul, ol, li,
                              span.reviewer-highlight[data-note-id] with inline style,
                              span.highlight-*)
notes: [{ id, reviewerName, text, type: "Opmerking" | "Correctie" | "Vraag", timestamp, resolved }]
shortSummary: string          at most 3 lines
blockWorkflow: { "block-hN": "concept" | "review" | "done" }    "ai" is accepted as well
chapterFeedbacks:            { "hN": <raw ai_response object | string | {FOUT, RAW}> }
chapterFeedbacksB1:          same shape
chapterFeedbacksSpelling:    same shape
chapterFeedbacksWoordenlijst: same shape
```

Session-only, never stored: `dismissedSuggestionIds`, `acceptedSuggestions`, `lastSuggestions`.

The frontend passes nota HTML through a safety filter (`frontend/src/lib/utils/safetyFilter.js`) whenever it turns stored HTML into DOM. The filter removes `script`, `style`, `iframe`, `object`, `embed`, every `on*` attribute and every URL attribute, and keeps what the list above names. A nota that is already clean is returned unchanged, so loading does not rewrite the stored JSON. The backend stores the JSON as it receives it.

### 5.2 Configuration blob layout

```
{configId}/metadata.json
{configId}/hoofdstukken/{hN}.json
{configId}/terminologie/{ruleId}.json
{configId}/regels/{ruleId}.json
{configId}/woordenlijst/{index}.json      items are plain strings, so the files are 0.json, 1.json, ...
notas/{notaId}.json
```

`metadata.json`:

```
{ name, templateVersion, description, toneOfVoice, isActive: boolean, b1Guidelines? }
```

A chapter (`hoofdstukken/hN.json`); the GS-nota configurations have 15 chapters, h1 to h15:

```
id, titel, doel, vereisten: string[], voorbeelden: string[], fout_voorbeelden: string[], instructie,
agent_structuur, agent_b1, agent_spelling_grammatica, agent_woordenlijst,
agent_digitale_toegankelijkheid, agent_open_overheid,
and for each agent_* key a matching <key>_output_template (JSON as a string)
```

A rule (`terminologie/` and `regels/`; the configurator splits them on save by `category === 'Terminologie'`):

```
{ id, category: "Terminologie" | "B1 Taal" | ..., severity: "yellow" | ..., triggerWords: string[], alternatives: string[], explanation }
```

`b1Guidelines` (inside `metadata.json`):

```
{
  presetLabel, sourceNote,
  globalSources: [{ label, url?, note? }],
  metrics: { <key>: { label?, hint?, target?, good: [a, b], warn: [a, b], direction, howComputed?, sources? } }
}
keys: avgWordsPerSentence, passiveSentencePercent, jargonProxyPer1000, formalWordPer1000,
      longWordPer1000, avgWordsPerParagraph, cohesionSignalHits
```

`POST /upload-configuration` takes `{[folder]: {...metadata, mappen: {hoofdstukken: [...], terminologie: [...], regels: [...], woordenlijst: [...]}}}`. The configurator also imports the flat export format of `exportConfigToJson`; the frontend converts it before it uploads.

## 6. Runtime configuration of the bundle

This is not an HTTP interface, but `apiClient.js` depends on it. `loader.js` reads the `schrijfassistent` card from `apps.json` and calls

```
window.SchrijfassistentApp.mount(container, { getToken, user, config, onClose })
```

- `getToken()` returns `localStorage.token` of the Open WebUI page, read again on every call, so a refreshed session keeps working. The bundle keeps the token nowhere else.
- `user` is `{id, email, name, role}` from `GET /api/v1/auths/` on the Open WebUI origin. Without a user the loader opens nothing.
- `config` is `{ api_base_url, asset_base_url, b1_metrics_doc_url }`, taken from the card. `api_base_url` is a path on the same host or an https URL (default `/apps/schrijfassistent`). `asset_base_url` is a path on the same host (default `/static/apps/schrijfassistent`). `b1_metrics_doc_url` is the link of the Direct Duidelijk metrics panel; the bundle only shows it when it is https or mailto.
- `onClose` is called after the app finished its own close sequence; the loader then removes the container.

## 7. Logging and threading

The backend logs no nota text and no AI answer. An error path logs the exception class, a status code, an id or a length (`storage.py` `_log_safe_error`, `validator.py`). The `raw_response` field of the 422 detail of `generate-agent-response` goes back to the caller but not to the log.

Routes that call the synchronous Azure SDK or the AI client are plain `def` functions, so Starlette runs them in its thread pool and the event loop stays free.

In the container the gunicorn access log is off, because an access line carries the request path and query string.
