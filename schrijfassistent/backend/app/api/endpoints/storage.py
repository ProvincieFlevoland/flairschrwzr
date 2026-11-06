from fastapi import APIRouter, Depends, HTTPException, Body, Header, Query, Response
from pydantic import BaseModel
from azure.core.exceptions import ResourceNotFoundError, ResourceModifiedError, ResourceExistsError

from app.services.azure_storage import azure_storage
from app.services.ai_agent import ai_agent
from app.core.security import get_current_user, require_beheerder
from app.core.blob_guard import check_segment, check_config_id, check_item_id, check_upload_configuration
from app.core.validator import validate_agent_response
from app.core.agent_defaults import DEFAULT_INSTRUCTIONS, resolve_instruction
from app.core.model_resolver import resolve_model, check_upload_models, TITLE_TASK, SUMMARY_TASK
from typing import Dict, Any, Optional
import json
import logging

logger = logging.getLogger(__name__)

# What a client gets for an unexpected storage failure: a fixed Dutch text. The exception text can carry the
# storage endpoint, a blob name or a connection detail; the log keeps the exception class.
STORAGE_ERROR_TEXT = "Opslaan of ophalen in de opslag is mislukt. Probeer het later opnieuw."


def _log_safe_error(e: Exception) -> str:
    """What may be logged about a failure on a route that handles nota text.

    The detail of an HTTPException on the agent route carries `raw_response`, the AI's raw answer, which quotes the
    author's chapter; an upstream error can echo its request. Neither goes to the log (Log Analytics in the container):
    only the exception class and, for an HTTPException, its status code. The client still receives the same response."""
    status = getattr(e, "status_code", None)
    if status is not None:
        return f"{type(e).__name__} status={status}"
    return type(e).__name__

# Every storage route depends on get_current_user: a request without a verified Open WebUI bearer token answers 401.
router = APIRouter(dependencies=[Depends(get_current_user)])


def _audit(action: str, user: Dict[str, Any], config_id: str, deleted: int, created: int) -> None:
    """One INFO line per configuration write: who, what, how many blobs. `%r` escapes control characters; never the body."""
    logger.info(
        "config-write action=%s auth=%s user_id=%s role=%r id=%r deleted=%d created=%d",
        action, user.get("auth"), user.get("id"), user.get("role"), config_id, deleted, created,
    )


class MetadataPatch(BaseModel):
    isActive: bool


@router.get("/configurations")
def list_configurations():
    """Endpoint to list all unique configurations (top-level folders)."""
    try:
        return {"configurations": azure_storage.list_configurations()}
    except Exception as e:
        logger.error(f"Failed to list configurations from Azure Storage: {e}")
        raise HTTPException(
            status_code=503, detail=f"Azure Storage is unreachable: {str(e)}"
        )


@router.get("/configurations/{config_id}/metadata")
def get_configuration_metadata(config_id: str):
    """Retrieve metadata.json (name, templateVersion, description, isActive, etc.)."""
    check_config_id(config_id)
    try:
        content = azure_storage.download_blob(f"{config_id}/metadata.json")
        return json.loads(content.decode("utf-8"))
    except Exception as e:
        logger.warning("No metadata found for %r: %s", config_id, e)
        raise HTTPException(status_code=404, detail=f"No metadata for '{config_id}'")


@router.patch("/configurations/{config_id}/metadata")
def patch_configuration_metadata(config_id: str, body: MetadataPatch, user: Dict[str, Any] = Depends(require_beheerder)):
    """Merge partial updates into metadata.json (e.g. isActive toggle without full re-upload)."""
    check_config_id(config_id)
    metadata_path = f"{config_id}/metadata.json"
    try:
        try:
            content = azure_storage.download_blob(metadata_path)
            metadata = json.loads(content.decode("utf-8"))
        except Exception:
            metadata = {}

        metadata["isActive"] = body.isActive
        azure_storage.upload_blob(
            metadata_path, json.dumps(metadata, indent=4).encode("utf-8")
        )
        _audit("patch", user, config_id, 0, 0)
        return {"status": "success", "metadata": metadata}
    except Exception as e:
        logger.error("Failed to patch metadata for %r: %s", config_id, _log_safe_error(e))
        raise HTTPException(status_code=500, detail=STORAGE_ERROR_TEXT)


@router.get("/configurations/{config_id}/subfolders")
def list_subfolders(config_id: str):
    """Endpoint to list subfolders (prefixes) for a specific configuration."""
    check_config_id(config_id)
    try:
        return {"subfolders": azure_storage.list_subfolders(config_id)}
    except Exception as e:
        logger.error("Failed to list subfolders for %r: %s", config_id, e)
        raise HTTPException(
            status_code=503, detail=f"Azure Storage is unreachable: {str(e)}"
        )


@router.get("/configurations/{config_id}/{subfolder}/data")
def get_subfolder_data(config_id: str, subfolder: str):
    """Endpoint to retrieve and aggregate JSON data from all files within a subfolder."""
    check_config_id(config_id)
    check_segment(subfolder, "mapnaam")
    try:
        return {"data": azure_storage.get_subfolder_data(config_id, subfolder)}
    except Exception as e:
        logger.error("Failed to get subfolder data for %r/%r: %s", config_id, subfolder, e)
        raise HTTPException(
            status_code=503, detail=f"Azure Storage is unreachable: {str(e)}"
        )


@router.get("/download/{blob_name}")
def download_blob(blob_name: str):
    """Endpoint to download a blob's content."""
    check_segment(blob_name, "blobnaam")
    try:
        content = azure_storage.download_blob(blob_name)
        return {"content": content.decode("utf-8")}
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/upload-configuration")
def upload_configuration(data: Dict[str, Any] = Body(...), user: Dict[str, Any] = Depends(require_beheerder)):
    """
    Endpoint to process a configuration JSON. If exists, delete all blobs under the prefix first,
    then rebuild everything.
    """
    # every key and id that becomes part of a blob name is checked before anything is deleted or written.
    check_upload_configuration(data)
    check_upload_models(data)
    try:
        if not data:
            raise HTTPException(status_code=400, detail="Empty JSON body")

        folder_name = list(data.keys())[0]
        config_data = data[folder_name]

        deleted_count = azure_storage.delete_blobs_with_prefix(f"{folder_name}/")

        metadata = {k: v for k, v in config_data.items() if k != "mappen"}
        metadata_path = f"{folder_name}/metadata.json"
        azure_storage.upload_blob(
            metadata_path, json.dumps(metadata, indent=4).encode("utf-8")
        )

        mappen = config_data.get("mappen", {})
        created_count = 0

        for subfolder_name, items in mappen.items():
            if not isinstance(items, list):
                continue

            for index, item in enumerate(items):
                item_id = item.get("id") if isinstance(item, dict) else None
                filename = f"{item_id}.json" if item_id else f"{index}.json"

                blob_path = f"{folder_name}/{subfolder_name}/{filename}"
                content = json.dumps(item, indent=4).encode("utf-8")

                azure_storage.upload_blob(blob_path, content)
                created_count += 1

        _audit("upload", user, folder_name, deleted_count, created_count + 1)
        return {
            "status": "success",
            "config_id": folder_name,
            "action": "rebuilt" if deleted_count > 0 else "created",
            "files_deleted": deleted_count,
            "files_created": created_count + 1,
            "message": f"Configuration '{folder_name}' fully synchronized (wiped {deleted_count} files, created {created_count + 1} files).",
        }
    except Exception as e:
        logger.error("Upload-configuration failed: %s", _log_safe_error(e))
        raise HTTPException(status_code=500, detail=STORAGE_ERROR_TEXT)


@router.delete("/configurations/{config_id}")
def delete_configuration(config_id: str, user: Dict[str, Any] = Depends(require_beheerder)):
    """Endpoint to delete an entire configuration (all blobs with the config_id prefix)."""
    check_config_id(config_id)
    try:
        count = azure_storage.delete_blobs_with_prefix(f"{config_id}/")
        _audit("delete", user, config_id, count, 0)
        return {
            "status": "success",
            "deleted_count": count,
            "message": f"Successfully deleted configuration '{config_id}' ({count} files).",
        }
    except Exception as e:
        logger.error("Delete configuration failed: %s", _log_safe_error(e))
        raise HTTPException(status_code=500, detail=STORAGE_ERROR_TEXT)


class AgentRequestBody(BaseModel):
    """JSON body of `POST /generate-agent-response`: the chapter text travels in the body, not in the URL."""
    user_message: str


@router.get("/agent-defaults")
def get_agent_defaults():
    """Standaardinstructies per opdracht, die `generate-agent-response` gebruikt als het veld van een hoofdstuk leeg is.

    Alleen-lezen; de beheeromgeving toont ze bij een leeg veld en kan ze overnemen."""
    return {"instructions": dict(DEFAULT_INSTRUCTIONS)}


def _config_metadata(config_id: Optional[str]) -> Dict[str, Any]:
    """metadata.json of a configuration, or {} when there is none (an AI call then uses AI_MODEL)."""
    if not config_id:
        return {}
    try:
        data = json.loads(azure_storage.download_blob(f"{config_id}/metadata.json").decode("utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _model_for(task: str, config_id: Optional[str], config: Dict[str, Any], chapter: Optional[Dict[str, Any]] = None,
               chapter_id: Optional[str] = None) -> Optional[str]:
    """The model the beheerder chose for this call (app/core/model_resolver.py), or None for AI_MODEL.

    Logs one line per AI call with the model and where the choice came from; never the nota text. Only LiteLLM offers
    a choice: with Foundry every call keeps AI_MODEL (the deployment), whatever a configuration holds."""
    if ai_agent.selectable:
        model, source = resolve_model(task, chapter, config, ai_agent.available_models())
    else:
        model, source = None, "standaard"
    logger.info(
        "ai-call task=%s model=%s source=%s config=%r chapter=%r",
        task, model or ai_agent.model, source, config_id, chapter_id,
    )
    return model


@router.get("/ai-models")
def get_ai_models(user: Dict[str, Any] = Depends(require_beheerder)):
    """De modellen die de beheerder per configuratie, kop en opdracht kan kiezen (alleen beheerder).

    Met LiteLLM is dat de lijst van `/v1/models` voor de key van deze backend; de key zelf komt nooit in de browser.
    `selectable` is false bij Foundry: dan is er alleen het standaardmodel. Is de AI-voorziening niet bereikbaar, dan
    antwoordt de route toch 200 met een lege lijst en een `error`, zodat de configurator bestaande keuzes kan tonen."""
    answer = {
        "provider": ai_agent.provider,
        "default": ai_agent.model,
        "selectable": bool(ai_agent.selectable),
        "models": [],
    }
    try:
        answer["models"] = ai_agent.list_models()
    except Exception as e:
        logger.warning("Listing AI models failed: %s", _log_safe_error(e))
        answer["error"] = "De lijst met modellen kon niet worden opgehaald bij de AI-voorziening. Probeer het later opnieuw."
    return answer


@router.post("/generate-agent-response")
def generate_agent_response(
    config_id: str = Query(...),
    chapter_id: str = Query(...),
    assignment: str = Query(...),
    body: AgentRequestBody = Body(...),
):
    """
    Process a specific assignment by combining its instruction from storage
    with a user message and sending it to the AI Agent. The message is read from the JSON body
    (`{"user_message": ...}`). The message is nota text and is never logged.
    """
    user_message = body.user_message
    check_config_id(config_id)
    check_segment(chapter_id, "hoofdstuk-id")
    try:
        # 1. Load the specific chapter data from storage
        chapter_data = {}
        try:
            content_bytes = azure_storage.download_blob(
                f"{config_id}/hoofdstukken/{chapter_id}.json"
            )
            chapter_data = json.loads(content_bytes.decode("utf-8"))
        except Exception:
            # If the blob doesn't exist or fails to load, try getting the list to be sure
            raise HTTPException(
                status_code=404,
                detail=f"Configuration '{config_id}' or chapter '{chapter_id}' not found.",
            )

        # 2. Extract the specific assignment value (instruction). An empty or missing instruction of an assignment
        #    with a default (agent_spelling_grammatica) falls back to that default, see app/core/agent_defaults.py.
        instruction = resolve_instruction(assignment, chapter_data)
        if instruction is None:
            raise HTTPException(
                status_code=404,
                detail=f"Assignment '{assignment}' not found in chapter '{chapter_id}'.",
            )

        # 3. Check for an optional validation template
        # Pattern: {assignment}_output_template
        template = chapter_data.get(f"{assignment}_output_template")

        # Assignment-specific output nudge (avoid contradicting B1's Suggesties-array schema)
        if assignment == "agent_b1":
            output_rules = (
                "ANTWOORDREGELS: Geef uitsluitend geldig JSON. Alleen de toplevel-sleutel 'Suggesties' "
                "(array van objecten met Origineel, Suggestie, Uitleg). Geen Analysis, Samenvatting of andere toplevel-velden. "
                "Geen markdown of uitleg buiten het JSON-object. "
                "Gebruik in waarden alleen rechte aanhalingstekens: voor citaten binnen een string gebruik enkele quotes ('...'). "
                "Nooit typografische dubbele quotes. "
                "Altijd return 'Suggestie'."
            )
        elif assignment == "agent_spelling_grammatica":
            # Only the answer format lives here; what the agent checks is the instruction (beheeromgeving, or
            # DEFAULT_SPELLING_INSTRUCTION when the chapter leaves it empty).
            output_rules = (
                "ANTWOORDREGELS: Geef uitsluitend geldig JSON. Alleen de toplevel-sleutel 'Suggesties' "
                "(array van objecten met Origineel, Suggestie, Uitleg). "
                "Voor elk item moet 'Uitleg' een duidelijke, niet-lege reden bevatten (regel, norm of categorie; geen lege of generieke vulling). "
                "Gebruik een lege Suggesties-array als er geen verbetering is. "
                "In Origineel: kopieer een aaneengesloten substring EXACT uit de tekst die verschijnt na 'GEBRUIKER INPUT:' hieronder. "
                "Letterlijk dezelfde woorden en leestekens in exacte volgorde zoals ze in die invoertekst staan, "
                "inclusief alle fouten (dubbele spaties, hoofdletters, spelfouten, grammaticafouten, punten, komma's, etc.). "
                "Origineel bevat de FOUTIEVE tekst zoals ingevoerd, niet de gecorrigeerde versie. "
                "Geen Analysis, Samenvatting of andere toplevel-velden. "
                "Geen markdown of uitleg buiten het JSON-object. "
                "Gebruik in waarden alleen rechte aanhalingstekens: voor citaten binnen een string gebruik enkele quotes ('...'). "
                "Nooit typografische dubbele quotes. "
                "Altijd return 'Suggestie'."
            )
        elif assignment == "agent_woordenlijst":
            output_rules = (
                "ANTWOORDREGELS: Geef uitsluitend geldig JSON. Alleen de toplevel-sleutel 'Suggesties' "
                "(array van objecten met Origineel, Categorie, Alternatieven). "
                "Origineel: exact één WOORD of één samenstelling zonder spaties uit de invoertekst (geen hele zinnen). "
                "Categorie: precies één van: niet-B1, vaag, jargon. "
                "Alternatieven: array met minimaal 2 objecten, elk met Tekst (vervangend woord, zelfde granulariteit) en Uitleg (1–2 zinnen). "
                "Beoordeel alleen woordniveau (B1-moeilijkheid, vaagheid, jargon); geen zins- of alinea-feedback. "
                "Geen Analysis, Samenvatting of andere toplevel-velden. "
                "Geen markdown of uitleg buiten het JSON-object. "
                "Gebruik in waarden alleen rechte aanhalingstekens; voor citaten binnen een string enkele quotes ('...'). "
                "Nooit typografische dubbele quotes."
            )
        else:
            output_rules = (
                "ANTWOORDREGELS: Geef uitsluitend geldig JSON volgens het formaat in de instructie. "
                "Altijd return 'Suggestie'. "
                "Geen markdown of tekst buiten het JSON-object. "
                "JSON gebruikt alleen rechte dubbele quotes als veldscheiding; binnen tekstwaarden geen typografische quotes. "
                "Voor citaten of nadruk binnen een waarde: gebruik enkele rechte quotes ('...')."
            )

        # 4. Call the AI Agent with the instruction and user message, on the model the beheerder chose for this
        #    kop and opdracht (or the configuration's choice, or AI_MODEL).
        if ai_agent.client:
            try:
                model = _model_for(assignment, config_id, _config_metadata(config_id), chapter_data, chapter_id)
                # We combine the instruction from storage with the user's message
                full_prompt = f"INSTRUCTION: {instruction}\n\n{output_rules}\n\nGEBRUIKER INPUT: {user_message}"
                ai_response_text = ai_agent.get_agent_response(full_prompt, model=model)

                # 5. If a template exists, validate the response
                if template:
                    try:
                        # If validation passes, it returns the parsed/validated dict
                        validated_response = validate_agent_response(
                            template, ai_response_text
                        )
                        return {"ai_response": validated_response, "validated": True}
                    except ValueError as ve:
                        err_msg = str(ve)
                        # If the template itself is broken (config issue), skip validation gracefully
                        if "validatie-template is geen geldige JSON" in err_msg:
                            logger.warning(
                                f"Template for {assignment} is invalid JSON, skipping validation: {err_msg}"
                            )
                            from app.core.validator import repair_json_str

                            try:
                                import json as _json

                                fallback = _json.loads(
                                    repair_json_str(ai_response_text)
                                )
                            except Exception:
                                fallback = ai_response_text
                            return {
                                "ai_response": fallback,
                                "validated": False,
                                "warning": "Template configuration error; validation skipped.",
                            }
                        # Validation failed due to AI response mismatch
                        logger.warning(
                            f"AI Response validation failed for {assignment}: {err_msg}"
                        )
                        # This HTTPException is raised inside the `try` whose `except Exception`
                        # below catches it, so the client receives 500 "Agent communication
                        # error: 422: {...}" with the detail dict stringified. The frontend relies on this answer.
                        raise HTTPException(
                            status_code=422,
                            detail={
                                "error": "AI Response did not match the required format.",
                                "details": err_msg,
                                "raw_response": ai_response_text,
                            },
                        )

                # Default behavior: return raw text if no template
                return {"ai_response": ai_response_text, "validated": False}

            except Exception as e:
                logger.error("AI Agent call failed: %s", _log_safe_error(e))
                raise HTTPException(
                    status_code=500, detail=f"Agent communication error: {str(e)}"
                )
        else:
            raise HTTPException(
                status_code=503,
                detail="AI Agent service is not initialized. Check server logs.",
            )

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Generate agent response failed: %s", _log_safe_error(e))
        raise HTTPException(status_code=500, detail=STORAGE_ERROR_TEXT)


NOTAS_PREFIX = "notas"

VALID_BLOCK_WORKFLOW_STATES = frozenset({"concept", "ai", "review", "done"})


def _validate_block_workflow_payload(nota: Dict[str, Any]) -> None:
    """Reject invalid per-chapter workflow keys (mirrors frontend `$lib/workflow.js`)."""
    bw = nota.get("blockWorkflow")
    if bw is None:
        return
    if not isinstance(bw, dict):
        raise HTTPException(
            status_code=400,
            detail="blockWorkflow moet een object zijn.",
        )
    for bid, val in bw.items():
        if val not in VALID_BLOCK_WORKFLOW_STATES:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Ongeldige blockWorkflow-waarde voor {bid!r}: {val!r}. "
                    f"Toegestaan: {', '.join(sorted(VALID_BLOCK_WORKFLOW_STATES))}."
                ),
            )


@router.get("/notas")
def list_notas():
    """Retrieve all notas stored in Azure Storage under the notas/ prefix."""
    try:
        notas = azure_storage.get_blobs_data(NOTAS_PREFIX)
        return {"notas": notas}
    except Exception as e:
        logger.error(f"Failed to list notas from Azure Storage: {e}")
        raise HTTPException(
            status_code=503, detail=f"Azure Storage is unreachable: {str(e)}"
        )


@router.get("/notas/{nota_id}")
def get_nota(nota_id: str, response: Response):
    """Laad één nota-json uit Azure Storage (`notas/{nota_id}.json`)."""
    check_segment(nota_id, "nota-id")
    try:
        blob_name = f"{NOTAS_PREFIX}/{nota_id}.json"
        raw, etag = azure_storage.download_blob_with_etag(blob_name)
        data = json.loads(raw.decode("utf-8"))
        if etag:
            response.headers["ETag"] = etag  # send back as `If-Match` on the next PUT
        if not isinstance(data, dict):
            raise HTTPException(
                status_code=500, detail="Ongeldige nota-json in storage."
            )
        return data
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to load nota %r: %s", nota_id, e)
        raise HTTPException(
            status_code=404,
            detail=f"Nota niet gevonden of storagefout: {nota_id}",
        )


# Blob metadata key that carries the nota's own `lastModified` next to the blob: the validator pair of a nota
# is (blob ETag, this value). It lets `PUT /notas/{id}` compare the client's `X-Nota-Base-Modified` after one
# properties request (HEAD, no body) and then write with `If-Match: <ETag>`.
NOTA_LAST_MODIFIED_META = "notalm"


def _meta_value(nota: Dict[str, Any]) -> Optional[Dict[str, str]]:
    """Metadata for the write of `nota`: its `lastModified` when that is a short printable ASCII string (Blob metadata
    values are HTTP header values); otherwise None and the reader falls back to the body."""
    value = nota.get("lastModified")
    if isinstance(value, str) and 0 < len(value) <= 200 and value.isascii() and value.isprintable():
        return {NOTA_LAST_MODIFIED_META: value}
    return None


def _last_modified_of(raw: bytes) -> Optional[str]:
    """`lastModified` of a stored nota body, or None when it is not a JSON object with a string `lastModified`."""
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception:
        return None
    value = data.get("lastModified") if isinstance(data, dict) else None
    return value if isinstance(value, str) else None


def _stored_last_modified(blob_name: str) -> Optional[str]:
    """Best-effort `lastModified` of the stored nota for the 409 answer after a refused write; None when unknown."""
    try:
        state = azure_storage.blob_state(blob_name)
        if state is None:
            return None
        known = state[1].get(NOTA_LAST_MODIFIED_META)
        return known if known is not None else _last_modified_of(azure_storage.download_blob(blob_name))
    except Exception:
        return None


def _conflict(nota_id: str, blob_name: str, base: Optional[str], stored: Optional[str]) -> HTTPException:
    logger.info("Conflict on nota %r: the stored version changed since it was loaded", nota_id)
    return HTTPException(
        status_code=409,
        detail={
            "error": "conflict",
            "stored_last_modified": stored if stored is not None else _stored_last_modified(blob_name),
            "base_last_modified": base,
            "message": "De nota is intussen door iemand anders opgeslagen. Laad de nota opnieuw.",
        },
    )


def _is_precondition_failure(e: Exception) -> bool:
    """Blob refused the conditional write: 412 (ETag changed or blob gone) or 409 BlobAlreadyExists (create-only write)."""
    if isinstance(e, (ResourceModifiedError, ResourceExistsError)):
        return True
    return getattr(e, "status_code", None) == 412


@router.put("/notas/{nota_id}")
def save_nota(
    nota_id: str,
    response: Response,
    nota: Dict[str, Any] = Body(...),
    base_modified: Optional[str] = Header(default=None, alias="X-Nota-Base-Modified"),
    if_match: Optional[str] = Header(default=None, alias="If-Match"),
):
    """Save or update a nota in Azure Storage as notas/{nota_id}.json.

    Optimistic concurrency. The write itself is conditional on the
    blob ETag, so Blob decides a race atomically and refuses the loser with 412, which this route answers as the
    same 409 as before:
    - `If-Match: <ETag>` (the ETag header of `GET /notas/{id}` and of this route's own answer): written only when the
      blob still has that ETag.
    - `X-Nota-Base-Modified: <lastModified>` (what the embedded app sends): compared with the `lastModified` of the
      stored nota, read from the blob metadata with one properties request (the nota is not downloaded; a nota stored
      before has no metadata and is read once), then written with `If-Match` of the ETag that comparison saw.
    - neither header: last-write-wins.
    A first save (no stored blob) is accepted and written create-only. The answer carries the new `ETag`."""
    check_segment(nota_id, "nota-id")
    _validate_block_workflow_payload(nota)
    try:
        blob_name = f"{NOTAS_PREFIX}/{nota_id}.json"
        data = json.dumps(nota, ensure_ascii=False).encode("utf-8")
        metadata = _meta_value(nota)
        new_etag = None
        if if_match is not None:
            # The client holds the validator itself: no read at all. A weak prefix is tolerated.
            etag = if_match.strip()
            if etag.startswith("W/"):
                etag = etag[2:]
            try:
                new_etag = azure_storage.upload_blob_if(blob_name, data, etag=etag, metadata=metadata)
            except Exception as e:
                if _is_precondition_failure(e):
                    raise _conflict(nota_id, blob_name, base_modified, None)
                raise
        elif base_modified is not None:
            state = azure_storage.blob_state(blob_name)
            etag = state[0] if state is not None else None
            stored_last_modified = state[1].get(NOTA_LAST_MODIFIED_META) if state is not None else None
            if state is not None and stored_last_modified is None:
                # Stored before (or without comparable metadata): one read; its ETag guards the write below.
                try:
                    raw, etag = azure_storage.download_blob_with_etag(blob_name)
                    stored_last_modified = _last_modified_of(raw)
                except ResourceNotFoundError:
                    etag = None  # deleted in between: a first save
            # A first save (no stored nota, or none with a comparable lastModified) is accepted.
            if stored_last_modified is not None:
                if base_modified is not None and base_modified != stored_last_modified:
                    raise _conflict(nota_id, blob_name, base_modified, stored_last_modified)
            try:
                new_etag = azure_storage.upload_blob_if(blob_name, data, etag=etag, metadata=metadata)
            except Exception as e:
                if _is_precondition_failure(e):
                    raise _conflict(nota_id, blob_name, base_modified, None)
                raise
        else:
            azure_storage.upload_blob(blob_name, data, metadata=metadata)
        if new_etag:
            response.headers["ETag"] = new_etag
        return {"status": "ok", "blob": blob_name}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to save nota %r: %s", nota_id, _log_safe_error(e))
        raise HTTPException(status_code=500, detail=STORAGE_ERROR_TEXT)


@router.delete("/notas/{nota_id}")
def delete_nota_blob(nota_id: str):
    """Delete a nota blob from Azure Storage."""
    check_segment(nota_id, "nota-id")
    try:
        blob_name = f"{NOTAS_PREFIX}/{nota_id}.json"
        azure_storage.delete_blob(blob_name)
        return {"status": "ok", "deleted": blob_name}
    except Exception as e:
        logger.error("Storage route failed: %s", _log_safe_error(e))
        raise HTTPException(status_code=500, detail=STORAGE_ERROR_TEXT)


def _optional_config_id(body: Dict[str, Any]) -> Optional[str]:
    """The optional `config_id` of a nota-wide AI call (title, summary): the configuration whose model choice applies."""
    config_id = body.get("config_id")
    if config_id is None or config_id == "":
        return None
    if not isinstance(config_id, str):
        raise HTTPException(status_code=400, detail="config_id moet tekst zijn.")
    check_config_id(config_id)
    return config_id


@router.post("/generate-nota-title")
def generate_nota_title(body: Dict[str, Any] = Body(...)):
    """
    Generates a short Dutch GS-nota title from the supplied chapters.
    Body: { "chapters": [{ "title": str, "content": str }, ...], "config_id": str (optional, for the model choice) }
    """
    config_id = _optional_config_id(body)
    chapters = body.get("chapters", [])
    if not chapters:
        raise HTTPException(status_code=400, detail="Geen hoofdstukken aangeleverd.")

    if not ai_agent.client:
        raise HTTPException(
            status_code=503, detail="AI Agent service is niet geïnitialiseerd."
        )

    nota_text = "\n\n".join(
        f"## {ch.get('title', '')}\n{ch.get('content', '')}" for ch in chapters
    )

    prompt = (
        "Je bent een assistent voor GS-nota's van een Nederlandse provincie. "
        "Geef alleen één korte, professionele notatitel in het Nederlands. "
        "Maximaal 5 woorden — geen ondertitel, geen lange zinsdelen, geen komma's. "
        "GS-nota stijl: zakelijk en bondig. "
        "Geen aanhalingstekens, geen punt aan het einde, geen uitleg of markdown.\n\n"
        f"{nota_text}"
    )

    def _clamp_title(text: str, max_words: int = 5) -> str:
        # ( fixed): a quote pair is stripped whether it is the same character on both sides or an
        # opening/closing pair (“ ”, „ ”, « »), so no quote stays on the title.
        line = (text or "").strip().splitlines()[0].strip()
        pairs = {'"': '"', "'": "'", "«": "»", "“": "”", "”": "”", "„": "”"}
        for opening, closing in pairs.items():
            if len(line) > 2 and line.startswith(opening) and line.endswith(closing):
                line = line[1:-1].strip()
        line = line.rstrip(".!?;:")
        words = line.split()
        if len(words) > max_words:
            words = words[:max_words]
        return " ".join(words)

    try:
        raw = ai_agent.get_agent_response(prompt, model=_model_for(TITLE_TASK, config_id, _config_metadata(config_id)))
        title = _clamp_title(raw)
        if not title:
            raise HTTPException(status_code=500, detail="Lege titel ontvangen van AI.")
        return {"title": title}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Generate nota title failed: %s", _log_safe_error(e))
        raise HTTPException(status_code=500, detail=f"Titel genereren mislukt: {str(e)}")


@router.post("/summarize-nota")
def summarize_nota(body: Dict[str, Any] = Body(...)):
    """
    Generates a short summary of a GS-nota (government note) from the supplied chapters.
    Body: { "chapters": [{ "title": str, "content": str }, ...], "config_id": str (optional, for the model choice) }
    """
    config_id = _optional_config_id(body)
    chapters = body.get("chapters", [])
    if not chapters:
        raise HTTPException(status_code=400, detail="Geen hoofdstukken aangeleverd.")

    if not ai_agent.client:
        raise HTTPException(
            status_code=503, detail="AI Agent service is niet geïnitialiseerd."
        )

    nota_text = "\n\n".join(
        f"## {ch.get('title', '')}\n{ch.get('content', '')}" for ch in chapters
    )

    prompt = (
        "Geef één regel: een korte samenvatting van de inhoud. Alleen die zin, Nederlands.\n\n"
        f"{nota_text}"
    )

    def _clamp_three_lines(text: str) -> str:
        lines = [ln.strip() for ln in (text or "").strip().splitlines() if ln.strip()]
        return "\n".join(lines[:3])

    try:
        raw = ai_agent.get_agent_response(prompt, model=_model_for(SUMMARY_TASK, config_id, _config_metadata(config_id)))
        summary = _clamp_three_lines(raw)
        return {"summary": summary}
    except Exception as e:
        logger.error("Summarize nota failed: %s", _log_safe_error(e))
        raise HTTPException(status_code=500, detail=f"Samenvatting mislukt: {str(e)}")
