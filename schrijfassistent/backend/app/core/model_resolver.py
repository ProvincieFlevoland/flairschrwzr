"""Welk taalmodel een AI-aanroep gebruikt: de keuze van de beheerder per configuratie, per kop en per opdracht.

De beheerder kan in de configurator op twee plekken een model kiezen, in dezelfde vorm:

  * in de configuratie (`<config>/metadata.json`) en
  * in een kop (`<config>/hoofdstukken/<kop>.json`):

    "aiModellen": {
        "standaard": "<model of leeg>",
        "opdrachten": {"agent_spelling_grammatica": "<model>", "titel": "<model>", ...}
    }

Leeg of ontbrekend betekent "overnemen van het niveau erboven". De meest specifieke keuze wint:

  1. kop -> opdrachten -> <opdracht>
  2. kop -> standaard
  3. configuratie -> opdrachten -> <opdracht>
  4. configuratie -> standaard
  5. AI_MODEL (de systeemstandaard; `resolve_model` geeft dan None)

Titel en samenvatting gelden voor de hele nota en kennen alleen de stappen 3 t/m 5.

Is de lijst van beschikbare modellen bekend (LiteLLM `/v1/models`), dan wordt een gekozen model dat er niet in staat
overgeslagen met een waarschuwing in de log: de schrijver merkt er niets van, de beheerder ziet het in de log en in de
configurator.
"""
import logging
from typing import Any, Dict, Iterable, Optional, Tuple

from fastapi import HTTPException

logger = logging.getLogger(__name__)

MODELS_KEY = "aiModellen"
DEFAULT_KEY = "standaard"
TASKS_KEY = "opdrachten"

# Opdrachten die voor de hele nota gelden (geen kop).
TITLE_TASK = "titel"
SUMMARY_TASK = "samenvatting"

# Bovengrens van een modelnaam; LiteLLM-namen zijn kort (bijv. "gpt-5.6-terra", "azure/gpt-4o-mini").
MAX_MODEL_NAME_LENGTH = 200


def _choice(value: Any) -> Optional[str]:
    """Een ingevulde modelkeuze, of None voor leeg/ontbrekend/geen tekst."""
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _levels(task: str, chapter: Optional[Dict[str, Any]], config: Optional[Dict[str, Any]]):
    """De kandidaten van specifiek naar algemeen, als (bron, model)."""
    for scope, data in (("kop", chapter), ("configuratie", config)):
        block = data.get(MODELS_KEY) if isinstance(data, dict) else None
        if not isinstance(block, dict):
            continue
        tasks = block.get(TASKS_KEY)
        if isinstance(tasks, dict):
            yield f"{scope}-opdracht", _choice(tasks.get(task))
        yield scope, _choice(block.get(DEFAULT_KEY))


def resolve_model(
    task: str,
    chapter: Optional[Dict[str, Any]] = None,
    config: Optional[Dict[str, Any]] = None,
    available: Optional[Iterable[str]] = None,
) -> Tuple[Optional[str], str]:
    """Het model voor `task`, met de bron ("kop-opdracht", "kop", "configuratie-opdracht", "configuratie").

    Geeft (None, "standaard") als nergens een (beschikbaar) model gekozen is: de aanroeper gebruikt dan AI_MODEL.
    `available` is de lijst van LiteLLM, of None als die onbekend is (dan wordt elke keuze vertrouwd).
    """
    allowed = set(available) if available is not None else None
    for source, model in _levels(task, chapter, config):
        if not model:
            continue
        if allowed is not None and model not in allowed:
            logger.warning(
                "AI-model %r (%s, opdracht %s) staat niet in de lijst van de AI-voorziening; terugval op het volgende niveau.",
                model, source, task,
            )
            continue
        return model, source
    return None, "standaard"


def check_models_block(value: Any, where: str) -> None:
    """Controleert de vorm van een `aiModellen`-blok bij het opslaan van een configuratie (400 bij een fout)."""
    if value is None:
        return
    if not isinstance(value, dict):
        raise HTTPException(status_code=400, detail=f"Ongeldige configuratie: '{MODELS_KEY}' van {where} is geen JSON-object.")
    _check_name(value.get(DEFAULT_KEY), where)
    tasks = value.get(TASKS_KEY)
    if tasks is None:
        return
    if not isinstance(tasks, dict):
        raise HTTPException(status_code=400, detail=f"Ongeldige configuratie: '{MODELS_KEY}.{TASKS_KEY}' van {where} is geen JSON-object.")
    for model in tasks.values():
        _check_name(model, where)


def _check_name(model: Any, where: str) -> None:
    if model is None:
        return
    if not isinstance(model, str) or len(model) > MAX_MODEL_NAME_LENGTH or any(ord(c) < 32 for c in model):
        raise HTTPException(status_code=400, detail=f"Ongeldige configuratie: een modelnaam in '{MODELS_KEY}' van {where} is ongeldig.")


def check_upload_models(data: Any) -> None:
    """Controleert de `aiModellen`-blokken van een hele configuratie (POST /upload-configuration), vóór er iets wordt
    verwijderd of geschreven. De rest van de vorm controleert app/core/blob_guard.check_upload_configuration."""
    if not isinstance(data, dict) or not data:
        return
    config_data = next(iter(data.values()))
    if not isinstance(config_data, dict):
        return
    check_models_block(config_data.get(MODELS_KEY), "de configuratie")
    mappen = config_data.get("mappen")
    chapters = mappen.get("hoofdstukken") if isinstance(mappen, dict) else None
    if not isinstance(chapters, list):
        return
    for chapter in chapters:
        if isinstance(chapter, dict):
            check_models_block(chapter.get(MODELS_KEY), f"kop {chapter.get('id', '?')!s:.40}")
