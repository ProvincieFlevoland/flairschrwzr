"""Standaardinstructies van de AI-opdrachten die de beheerder per hoofdstuk kan aanpassen.

`generate-agent-response` bouwt een prompt uit twee delen:
  * de instructie (wat de AI beoordeelt): uit het hoofdstuk in de configuratie, bewerkbaar in de beheeromgeving;
  * de ANTWOORDREGELS (hoe het antwoord eruitziet): vast in de code, want de Schrijfassistent leest het antwoord
    als JSON en zoekt `Origineel` letterlijk op in de tekst.

Is de instructie van een opdracht hieronder leeg of ontbreekt ze in het hoofdstuk, dan gebruikt de backend deze
standaardtekst. De beheeromgeving toont dezelfde tekst (`GET /agent-defaults`), zodat de beheerder ziet wat er
gebruikt wordt en die tekst kan overnemen en aanpassen.
"""
from typing import Any, Dict

DEFAULT_SPELLING_INSTRUCTION = (
    "Jij bent een taalreviewagent voor de overheid. Controleer de tekst op spelling, grammatica en leestekens "
    "volgens de officiële Nederlandse norm (o.a. Groene Boekje en Taaladvies.net). "
    "Signaleer ook subtiele problemen: interpunctie (o.a. spatie vóór punt of komma, onjuiste spaties rond leestekens), "
    "dubbele of meerdere spaties tussen woorden, "
    "lichte grammatica en inconsistente schrijfwijze — niet alleen grove spelfouten. "
    "Gebruik een lege Suggesties-array alleen als er echt geen concrete verbetering is."
)

DEFAULT_INSTRUCTIONS: Dict[str, str] = {
    "agent_spelling_grammatica": DEFAULT_SPELLING_INSTRUCTION,
}


def resolve_instruction(assignment: str, chapter_data: Dict[str, Any]) -> Any:
    """De instructie voor `assignment` uit het hoofdstuk, of de standaardtekst als die leeg is of ontbreekt.

    Geeft None als de opdracht niet in het hoofdstuk staat en er geen standaardtekst voor is (de route antwoordt
    dan 404). Opdrachten zonder standaardtekst houden hun opgeslagen waarde, ook als die leeg is.
    """
    default = DEFAULT_INSTRUCTIONS.get(assignment)
    if assignment not in chapter_data:
        return default
    stored = chapter_data[assignment]
    if default is not None and (stored is None or (isinstance(stored, str) and not stored.strip())):
        return default
    return stored
