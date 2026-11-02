from pydantic import create_model, ConfigDict, ValidationError
from typing import Optional, Dict, Any, Union
import json
import logging

import json_repair

logger = logging.getLogger(__name__)

import re

def sanitize_json_str(s: str) -> str:
    """
    Normalizes typographic quotation marks for JSON that uses ASCII double quotes
    as string delimiters.

    Typographic *double* quotes inside JSON values (common in Dutch “citaten”) are
    mapped to ASCII single quotes, so they do not prematurely close the JSON string.

    Typographic single quotes become ASCII apostrophe.
    """
    sq = "'"
    for ch in ("\u201c", "\u201d", "\u201e", "\u201f"):  # “ ” „ ‟
        s = s.replace(ch, sq)
    s = s.replace("\u00ab", sq).replace("\u00bb", sq)  # « »
    s = s.replace("\u2018", sq).replace("\u2019", sq)  # ‘ ’
    return s

def repair_json_str(s: str) -> str:
    """
    Attempts to repair common AI JSON errors before parsing.

    Steps include: strip fences; normalize typographic quotes; NBSP/BOM/zero-width
    cleanup; extract {...} slice; strip trailing commas.
    """
    if not s:
        return s

    # 1. Strip markdown code fences (```json ... ``` or ``` ... ```)
    s = re.sub(r'^```[a-zA-Z]*\n?', '', s.strip())
    s = re.sub(r'\n?```$', '', s.strip())
    s = s.lstrip("\ufeff")
    for _zw in ("\u200b", "\u200c", "\u200d"):
        s = s.replace(_zw, "")

    # 2. Sanitize quotes (smart double quotes → ASCII ' so JSON \" delimiters stay valid)
    s = sanitize_json_str(s)
    s = s.replace("\u00a0", " ")

    # 3. Unescape \' which is invalid in JSON (AI sometimes uses it inside strings)
    s = s.replace("\\'", "'")

    # 4. Extract JSON block if surrounded by text (AI often adds preamble)
    start = s.find('{')
    end = s.rfind('}')
    if start != -1 and end != -1:
        s = s[start:end+1]

    # 5. Remove trailing commas: ,} -> } and ,] -> ]
    s = re.sub(r',\s*}', '}', s)
    s = re.sub(r',\s*\]', ']', s)

    return s


def normalize_json_like_text(response_str: str) -> str:
    """Second-pass repair: invisible chars and NBSP stripped after standard repair."""
    s = repair_json_str(response_str)
    s = s.replace("\u00a0", " ").lstrip("\ufeff")
    for _zw in ("\u200b", "\u200c", "\u200d", "\ufeff"):
        s = s.replace(_zw, "")
    s = re.sub(r',\s*}', '}', s)
    s = re.sub(r',\s*\]', ']', s)
    return s


def validate_agent_response(template: Union[Dict[str, Any], str], response_str: str) -> Dict[str, Any]:
    """
    Validates a JSON string response against a template using a dynamic Pydantic model.

    The validation process includes:
    1. Ensuring the template is a dictionary (parsing it if it's a JSON string).
    2. Repairing and parsing the AI response string into a dictionary.
    3. Creating a Pydantic model dynamically where all template fields are optional.
    4. Forbidding any extra keys not defined in the template.
    5. Validating the response data and returning a cleaned dictionary.

    Args:
        template (Union[Dict[str, Any], str]): The JSON template defining expected keys and types.
        response_str (str): The raw string response from the AI agent.

    Returns:
        Dict[str, Any]: A dictionary containing the validated and parsed response data.

    Raises:
        ValueError: If JSON parsing fails or if the response does not adhere to the template.
    """
    try:
        # 1. Ensure template is a dict
        if isinstance(template, str):
            try:
                template = json.loads(repair_json_str(template))
            except json.JSONDecodeError as e:
                logger.error(f"Failed to parse template as JSON: {template}")
                raise ValueError(f"Het validatie-template is geen geldige JSON: {str(e)}")

        if not isinstance(template, dict):
             raise ValueError(f"Validatie-template moet een JSON object zijn, maar kreeg {type(template).__name__}")

        # 2. Parse Response JSON (retry once with stricter invisible-char / NBSP cleanup)
        try:
            repaired_response = repair_json_str(response_str)
            response_data = json.loads(repaired_response)
        except json.JSONDecodeError as first_err:
            try:
                response_data = json.loads(normalize_json_like_text(response_str))
                logger.info("Agent JSON parsed on second pass after normalize_json_like_text")
            except json.JSONDecodeError:
                try:
                    repaired_response = repair_json_str(response_str)
                    response_data = json_repair.loads(repaired_response)
                    logger.warning(
                        "Agent JSON parsed via json_repair fallback (model output was malformed)"
                    )
                except Exception:
                    # The answer quotes the author's chapter: log its length, never its text.
                    logger.error("Failed to parse agent response as JSON (%d characters)", len(response_str))
                    err_msg = str(first_err)
                    if "Expecting ',' delimiter" in err_msg:
                        friendly = (
                            "Er ontbreekt waarschijnlijk een komma tussen twee velden, "
                            "of er staat een ongepaste aanhalingsteken in de tekst."
                        )
                    elif "Expecting property name enclosed in double quotes" in err_msg:
                        friendly = (
                            "De JSON structuur is beschadigd; controleer of alle veldnamen "
                            "tussen dubbele aanhalingstekens staan."
                        )
                    else:
                        friendly = err_msg

                    raise ValueError(
                        f"AI antwoord is geen geldige JSON (syntax fout): {friendly}"
                    ) from first_err

        if not isinstance(response_data, dict):
            raise ValueError(
                f"AI antwoord moet een JSON object zijn voor validatie, maar kreeg {type(response_data).__name__}"
            )

        # 2. Map template types for dynamic model
        # We use Optional[type(val)] and default to None to allow partial matches
        fields = {}
        for key, value in template.items():
            field_type = type(value)
            # If value is another dict, we could recurse, but for simplicity we'll use Any or Dict
            if isinstance(value, dict):
                fields[key] = (Optional[Dict[str, Any]], None)
            elif isinstance(value, list):
                fields[key] = (Optional[list], None)
            else:
                fields[key] = (Optional[field_type], None)

        # 3. Create dynamic model with extra="forbid"
        DynamicModel = create_model(
            "DynamicAgentResponse",
            __config__=ConfigDict(extra="forbid"),
            **fields
        )

        # 4. Validate
        try:
            validated_data = DynamicModel.model_validate(response_data)
            return validated_data.model_dump(exclude_unset=True)
        except ValidationError as e:
            # The pydantic message quotes `input_value`, i.e. text of the answer: log the error types only.
            logger.error("Validation failed for agent response: %d error(s): %s", len(e.errors()), [str(x.get("type")) for x in e.errors()])
            
            # Enhanced Dutch translation that knows about the model
            errors = e.errors()
            translated_msgs = []
            allowed_fields = ", ".join([f"'{k}'" for k in DynamicModel.model_fields.keys()])
            
            for err in errors:
                loc = [str(l) for l in err['loc'] if l not in ('__root__',)]
                field = " -> ".join(loc)
                type_code = err['type']
                
                if type_code == 'extra_forbidden':
                    msg = f"Veld '{field}' is niet toegestaan in het template. Toegestane velden zijn: {allowed_fields}."
                elif type_code == 'missing':
                    msg = f"Verplicht veld '{field}' ontbreekt in het antwoord van de AI."
                elif type_code.startswith('type_error') or type_code.endswith('_type'):
                     expected = type_code.replace('_type', '').replace('type_error.', '')
                     msg = f"Veld '{field}' heeft het verkeerde type (verwacht: {expected})."
                else:
                    msg = f"Fout bij veld '{field}': {err['msg']}"
                
                translated_msgs.append(msg)
            
            raise ValueError(" | ".join(translated_msgs))

    except Exception as e:
        if isinstance(e, ValueError):
            raise
        logger.error("Unexpected error during validation: %s", type(e).__name__)
        raise ValueError(f"Onverwachte validatie-fout: {str(e)}")
