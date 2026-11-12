"""Counting words, sentences and paragraphs in code instead of by the language model.

A language model cannot count reliably: a title of four words is reported as "more than five words", or a sentence of
twenty-five words passes as short. Rules about length ("Maximaal 5 woorden", "Maximaal 15 woorden per zin") are
therefore counted here, and the outcome goes into the prompt as a fixed fact (`count_block`). The frontend has the
same rules in `frontend/src/lib/utils/textCount.js`; `tests/fixtures/text-count-cases.json` holds the shared cases
both test suites check, so the two stay the same.

The rules:
  * A word is a run of characters between spaces that holds at least one letter or digit. Punctuation never counts
    on its own ("-", "–", "•", "&", "€") and never splits a word ("GS-voorstel", "e-Docs", "4-5", "50.000",
    "parkeergarage," are one word each).
  * A list marker at the start of a line ("1.", "1.1", "2)", "a)", "a.") is not a word.
  * A paragraph (alinea) is a non-empty line: each Enter in the editor starts a new one, as in Word.
  * A sentence ends at ".", "!", "?" or "…" followed by a space or the end of the text, and at the end of a line unless
    the next line goes on with a lower-case letter. A full stop after a known abbreviation ("bijv.", "o.a.", "art.",
    "d.w.z."), an initial ("J.") or a list marker does not end a sentence; "enz." and "etc." do only when a capital
    follows.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import List, Optional

# Abbreviations after which a full stop never ends the sentence (lower case, without the final full stop).
ABBREVIATIONS = frozenset(
    {
        "a.s", "afd", "art", "artt", "b.v", "bijl", "bijv", "blz", "bv", "ca", "d.d", "d.m.v", "d.w.z", "dhr", "dr",
        "drs", "excl", "evt", "fig", "gem", "hfst", "i.c", "i.o.m", "i.p.v", "i.s.m", "i.v.m", "incl", "ing", "ir",
        "jl", "j.l", "jr", "m.b.t", "m.i.v", "m.u.v", "max", "mevr", "min", "mr", "mw", "n.a.v", "n.v.t", "nr", "nrs",
        "o.a", "o.b.v", "o.i.d", "p", "pag", "par", "prof", "resp", "sr", "t.a.v", "t.b.v", "t.g.v", "t.o.v", "t.w",
        "t.z.t", "tel", "vgl", "vs", "w.o", "z.s.m", "zgn",
    }
)

# Abbreviations that often close a sentence: the full stop ends it only when a capital follows.
SENTENCE_FINAL_ABBREVIATIONS = frozenset({"e.a", "e.d", "e.v", "enz", "etc"})

# Letters joined by full stops ("d.w.z", "t.a.v", "a.s.") read as an abbreviation even when they are not in the list.
_DOTTED_ABBREVIATION = re.compile(r"^(?:[^\W\d_]\.)+[^\W\d_]?$")

# A list marker at the start of a line: "1.", "1)", "(1)", "1.1", "1.1.", "a)", "(a)", "a.".
_LIST_MARKER = re.compile(r"^(?:\(?\d{1,3}[.)]|\d{1,3}(?:\.\d{1,3})+\.?|\(?[a-zA-Z]\)|[a-z]\.)$")

# Sentence-closing punctuation, optional closing quotes or brackets, then a space or the end of the line.
_TERMINATOR = re.compile(r"([.!?…]+)[\"'”’»)\]]*(?=\s|$)")

_OPENING_PUNCTUATION = "\"'“‘„«([{"


def is_word(token: str) -> bool:
    """True when the token holds at least one letter or digit."""
    return any(ch.isalnum() for ch in token)


def is_list_marker(token: str) -> bool:
    return bool(_LIST_MARKER.match(token))


def words_in(text: str, line_start: bool = False) -> List[str]:
    """The words of `text`. With `line_start`, a list marker as the first token is not counted."""
    tokens = text.split()
    if line_start and tokens and is_list_marker(tokens[0]):
        tokens = tokens[1:]
    return [t for t in tokens if is_word(t)]


def count_words(text: str) -> int:
    """Number of words in `text`, line by line so a list marker at the start of each line is left out."""
    return sum(len(words_in(line, line_start=True)) for line in split_paragraphs(text))


def split_paragraphs(text: str) -> List[str]:
    """Non-empty lines, each with its whitespace collapsed."""
    lines = (re.sub(r"\s+", " ", line).strip() for line in str(text or "").replace(" ", " ").splitlines())
    return [line for line in lines if line]


def _token_before(line: str, end: int) -> str:
    """The token that ends at `end` (exclusive), without opening quotes or brackets."""
    start = line.rfind(" ", 0, end) + 1
    return line[start:end].lstrip(_OPENING_PUNCTUATION)


def _next_char(line: str, pos: int) -> str:
    rest = line[pos:].lstrip()
    return rest[:1]


def _ends_sentence(line: str, match: "re.Match[str]") -> bool:
    punct = match.group(1)
    if "!" in punct or "?" in punct:
        return True
    nxt = _next_char(line, match.end())
    if not nxt:
        return True
    if "…" in punct or ".." in punct:
        # An ellipsis followed by a lower-case word goes on with the same sentence.
        return not nxt.islower()
    token = _token_before(line, match.start(1))
    key = token.lower()
    if not key:
        return True
    if match.start(1) - len(token) == 0 and is_list_marker(token + "."):
        return False  # "1. Een parkeergarage ...": the list marker at the start of the line
    if key in SENTENCE_FINAL_ABBREVIATIONS:
        return nxt.isupper()
    if key in ABBREVIATIONS or _DOTTED_ABBREVIATION.match(key + "."):
        return False
    if len(key) == 1 and key.isalpha():
        return False  # an initial: "J. Jansen"
    return True


def split_sentences(text: str) -> List[str]:
    """The sentences of `text`, each as one line of text (a sentence can run over a line break)."""
    sentences: List[str] = []
    current = ""
    paragraphs = split_paragraphs(text)
    for index, line in enumerate(paragraphs):
        start = 0
        for match in _TERMINATOR.finditer(line):
            if _ends_sentence(line, match):
                current = f"{current} {line[start:match.end()]}".strip()
                if words_in(current, line_start=True):
                    sentences.append(current)
                current = ""
                start = match.end()
        current = f"{current} {line[start:]}".strip()
        following = paragraphs[index + 1] if index + 1 < len(paragraphs) else ""
        first = following.split(" ", 1)[0]
        continues = bool(current) and following[:1].islower() and not is_list_marker(first)
        if not continues:
            if words_in(current, line_start=True):
                sentences.append(current)
            current = ""
    return sentences


@dataclass
class Paragraph:
    text: str
    words: int
    sentences: int


@dataclass
class Sentence:
    text: str
    words: int


@dataclass
class TextCount:
    words: int
    sentences: List[Sentence] = field(default_factory=list)
    paragraphs: List[Paragraph] = field(default_factory=list)


def count_text(text: str) -> TextCount:
    """Words, sentences (with their word counts) and paragraphs (with word and sentence counts) of `text`."""
    paragraphs = split_paragraphs(text)
    sentences = [Sentence(s, len(words_in(s, line_start=True))) for s in split_sentences(text)]
    paragraph_counts = [
        Paragraph(p, len(words_in(p, line_start=True)), len(split_sentences(p))) for p in paragraphs
    ]
    return TextCount(
        words=sum(p.words for p in paragraph_counts),
        sentences=sentences,
        paragraphs=paragraph_counts,
    )


def truncate_words(text: str, max_words: int) -> str:
    """`text` cut after `max_words` words; punctuation between the words stays and does not count."""
    out: List[str] = []
    seen = 0
    for token in str(text or "").split():
        if is_word(token):
            if seen == max_words:
                break
            seen += 1
        out.append(token)
    while out and not is_word(out[-1]):
        out.pop()
    return " ".join(out)


# --- Length rules in an instruction ------------------------------------------------------------------------------

_NUMBER_WORDS = {
    "een": 1, "één": 1, "eén": 1, "twee": 2, "drie": 3, "vier": 4, "vijf": 5, "zes": 6, "zeven": 7, "acht": 8,
    "negen": 9, "tien": 10, "elf": 11, "twaalf": 12, "dertien": 13, "veertien": 14, "vijftien": 15, "twintig": 20,
    "dertig": 30, "veertig": 40, "vijftig": 50, "honderd": 100,
}
_UNIT = r"woorden|woord|zinnen|zin|alinea['’]?s|alinea"
# A rule line that is only a limit: "• Maximaal 5 woorden", "- max. 15 woorden per zin", "Hooguit drie zinnen."
# A line with more around it ("Toelichting in maximaal twee zinnen waarom ...", "Elk argument in één zin") is about a
# part of the text the code cannot pick out, so it stays with the language model (which does get the counts).
_RULE_LINE = re.compile(
    r"^[\s•·▪◦‣*\-–—]*(?P<kw>maximaal|max\.?|hooguit|ten hoogste|niet meer dan)\s+"
    rf"(?P<n>\d+|[a-zéë]+)\s+(?P<unit>{_UNIT})"
    r"(?:\s+per\s+(?P<per>zin|alinea))?\s*[.;:]?\s*$",
    re.IGNORECASE,
)


@dataclass
class LengthRule:
    text: str  # the rule as written in the instruction
    limit: int
    unit: str  # "woorden" | "zinnen" | "alinea's"
    per: Optional[str] = None  # None (whole text) | "zin" | "alinea"


@dataclass
class RuleCheck:
    rule: LengthRule
    passes: bool
    actual: int
    detail: str


def _unit(raw: str) -> str:
    raw = raw.lower()
    if raw.startswith("woord"):
        return "woorden"
    if raw.startswith("zin"):
        return "zinnen"
    return "alinea's"


def find_length_rules(instruction: str) -> List[LengthRule]:
    """The length rules in `instruction` that the code can check on the whole input text."""
    rules: List[LengthRule] = []
    for line in str(instruction or "").splitlines():
        m = _RULE_LINE.match(line)
        if not m:
            continue
        n_raw = m.group("n").lower()
        limit = int(n_raw) if n_raw.isdigit() else _NUMBER_WORDS.get(n_raw)
        if not limit:
            continue
        unit = _unit(m.group("unit"))
        per = m.group("per").lower() if m.group("per") else None
        if per == "zin" and unit != "woorden":
            continue  # "zinnen per zin" means nothing
        if per == "alinea" and unit == "alinea's":
            continue
        rule_text = re.sub(r"^[\s•·▪◦‣*\-–—]+", "", line).strip()
        rules.append(LengthRule(text=rule_text, limit=limit, unit=unit, per=per))
    return rules


def _short(text: str, words: int = 6) -> str:
    """The first words of a sentence or paragraph, to say which one is meant."""
    clean = " ".join(text.replace('"', "'").split())
    head = truncate_words(clean, words)
    return head if head == clean else f"{head} …"


def check_length_rule(rule: LengthRule, counted: TextCount) -> RuleCheck:
    if rule.per is None:
        if rule.unit == "woorden":
            actual = counted.words
        elif rule.unit == "zinnen":
            actual = len(counted.sentences)
        else:
            actual = len(counted.paragraphs)
        passes = actual <= rule.limit
        detail = f"de tekst telt {actual} {rule.unit}, maximaal {rule.limit}"
        return RuleCheck(rule, passes, actual, detail)

    if rule.per == "zin":
        parts = [(s.text, s.words) for s in counted.sentences]
        label = "zin"
    else:
        attr = "words" if rule.unit == "woorden" else "sentences"
        parts = [(p.text, getattr(p, attr)) for p in counted.paragraphs]
        label = "alinea"
    over = [(i + 1, text, n) for i, (text, n) in enumerate(parts) if n > rule.limit]
    actual = max((n for _, n in parts), default=0)
    if not over:
        detail = f"elke {label} telt maximaal {rule.limit} {rule.unit} (hoogste: {actual})"
        return RuleCheck(rule, True, actual, detail)
    listed = "; ".join(f'{label} {i} ("{_short(text)}") telt {n}' for i, text, n in over[:10])
    more = f"; en nog {len(over) - 10} meer" if len(over) > 10 else ""
    detail = f"{listed}{more}; maximaal {rule.limit} {rule.unit} per {label}"
    return RuleCheck(rule, False, actual, detail)


# Bound on the lines per list in the prompt, so a long chapter does not blow up the prompt.
MAX_LISTED = 40


def count_block(user_text: str, instruction: str = "", include_paragraphs: bool = True) -> str:
    """The counting facts for the prompt: the counts, and the outcome of each length rule the code can check.

    `include_paragraphs` is False when the input arrives without line breaks (then the paragraph count says nothing).
    Returns "" for empty input."""
    counted = count_text(user_text)
    if counted.words == 0:
        return ""

    lines = [
        "TELLING (berekend door de applicatie, niet door jou; gebruik deze getallen en tel zelf niet):",
        f"- Woorden: {counted.words}",
        f"- Zinnen: {len(counted.sentences)}",
    ]
    if include_paragraphs:
        lines.append(f"- Alinea's: {len(counted.paragraphs)}")
    if counted.sentences:
        lines.append("- Woorden per zin:")
        for i, s in enumerate(counted.sentences[:MAX_LISTED], start=1):
            lines.append(f'  - zin {i} ("{_short(s.text)}"): {s.words}')
        if len(counted.sentences) > MAX_LISTED:
            lines.append(f"  - en nog {len(counted.sentences) - MAX_LISTED} zinnen")
    if include_paragraphs and len(counted.paragraphs) > 1:
        lines.append("- Per alinea (woorden, zinnen):")
        for i, p in enumerate(counted.paragraphs[:MAX_LISTED], start=1):
            lines.append(f'  - alinea {i} ("{_short(p.text)}"): {p.words} woorden, {p.sentences} zinnen')
        if len(counted.paragraphs) > MAX_LISTED:
            lines.append(f"  - en nog {len(counted.paragraphs) - MAX_LISTED} alinea's")
    lines.append(
        "Woorden zijn geteld zonder leestekens en zonder nummering of opsommingstekens aan het begin van een regel."
    )

    rules = [
        r
        for r in find_length_rules(instruction)
        if include_paragraphs or (r.unit != "alinea's" and r.per != "alinea")
    ]
    if rules:
        lines.append("")
        lines.append("LENGTEREGELS (gecontroleerd door de applicatie; deze uitkomst is definitief):")
        for check in (check_length_rule(r, counted) for r in rules):
            verdict = "voldoet" if check.passes else "voldoet NIET"
            lines.append(f'- "{check.rule.text}": {verdict} ({check.detail}).')

    lines.append("")
    lines.append(
        "Baseer elk oordeel over aantallen woorden, zinnen of alinea's uitsluitend op deze telling. "
        "Meld een lengteregel die voldoet niet als probleem; meld een lengteregel die NIET voldoet altijd. "
        "Een tekst die je zelf voorstelt, moet ook aan de lengteregels voldoen."
    )
    return "\n".join(lines)
