"""Identity anonymisation for Stage 2 peer review.

Naive ports of the council idea relabel responses as "Response A/B/C" and stop
there. That leaks badly: models routinely sign their work ("As Claude, I'd
argue...", "I'm ChatGPT, so..."), and a reviewer that can tell whose answer it
is stops judging on merit. So we do two things:

1. Assign stable neutral labels.
2. Scrub self-identifying text out of the body before any reviewer sees it.
"""
from __future__ import annotations

import re
from typing import Dict, List, Sequence, Tuple

LABELS = [
    "Response A",
    "Response B",
    "Response C",
    "Response D",
    "Response E",
    "Response F",
    "Response G",
    "Response H",
]

REDACTED = "[model identity redacted]"

# Vendor and family names that give the game away.
_IDENTITY_TERMS = [
    "openai",
    "chatgpt",
    "gpt-5.1",
    "gpt-5",
    "gpt-4o-mini",
    "gpt-4o",
    "gpt-4",
    "gpt-3.5",
    "gpt",
    "anthropic",
    "claude opus",
    "claude sonnet",
    "claude haiku",
    "claude",
    "google deepmind",
    "google",
    "gemini",
    "bard",
    "x-ai",
    "xai",
    "grok",
    "meta ai",
    "llama",
    "mistral",
    "mixtral",
    "deepseek",
    "qwen",
    "alibaba",
    "cohere",
    "command r",
    "perplexity",
    "microsoft copilot",
    "copilot",
]

# Phrases that announce authorship even without a brand name.
_SELF_REFERENCE_PATTERNS = [
    r"\bas an? (?:large )?language model(?: developed| created| trained| made)?"
    r"(?: by [\w\s\-]+)?\b",
    r"\bas an ai (?:assistant|model|developed by [\w\s\-]+)\b",
    r"\bi(?:'m| am) an? (?:ai|artificial intelligence|language model)\b"
    r"(?: (?:assistant|model))?(?: (?:developed|created|trained|built) by [\w\s\-]+)?",
    r"\bi(?:'m| am) (?:called|named) [\w\s\-]+\b",
    r"\bmy (?:knowledge|training) (?:cut[- ]?off|data) (?:is|was|ends)[^.\n]*",
    r"\btrained by [\w\s\-]+\b",
]


def _term_pattern(term: str) -> "re.Pattern[str]":
    # Escape, then allow the hyphen/space to be interchangeable so "gpt-4o"
    # also catches "gpt 4o".
    escaped = re.escape(term).replace(r"\-", "[-\\s]?").replace(r"\ ", "[-\\s]?")
    return re.compile(r"(?<![\w/])" + escaped + r"(?![\w])", re.IGNORECASE)


_TERM_PATTERNS = [_term_pattern(t) for t in _IDENTITY_TERMS]
_SELF_PATTERNS = [re.compile(p, re.IGNORECASE) for p in _SELF_REFERENCE_PATTERNS]

# Tokens that appear inside model ids but are ordinary English. Redacting these
# would mangle legitimate prose ("a mini version", "the pro plan").
_GENERIC_ID_TOKENS = {
    "mini",
    "nano",
    "micro",
    "small",
    "medium",
    "large",
    "base",
    "pro",
    "max",
    "plus",
    "lite",
    "turbo",
    "chat",
    "instruct",
    "preview",
    "latest",
    "beta",
    "alpha",
    "exp",
    "experimental",
    "thinking",
    "reasoning",
    "vision",
    "audio",
    "text",
    "code",
    "high",
    "low",
}


def _id_tokens(model_id: str) -> List[str]:
    """Split a model id into identifying word tokens.

    "moonshot/kimi-k2" -> ["moonshot", "kimi"]  (k2 is too short, and would be
    noise anyway). Generic and short tokens are dropped so scrubbing never eats
    ordinary prose.
    """
    pieces = re.split(r"[^A-Za-z0-9]+", str(model_id or "").lower())
    tokens = []
    for piece in pieces:
        if len(piece) < 4:
            continue
        if piece in _GENERIC_ID_TOKENS:
            continue
        if piece.isdigit():
            continue
        tokens.append(piece)
    return tokens


def scrub_identity(text: str, extra_terms: Sequence[str] = ()) -> str:
    """Remove self-identifying references from a response body.

    Also strips model *ids* (e.g. "anthropic/claude-sonnet-4.5") and any extra
    terms the caller knows about — usually the live council line-up.
    """
    if not text:
        return ""

    scrubbed = text

    # Model ids look like "vendor/model-name"; kill those first so the vendor
    # half does not survive as a bare word.
    scrubbed = re.sub(r"\b[\w.-]+/[\w.:-]+\b", REDACTED, scrubbed)

    for term in extra_terms:
        for piece in _id_tokens(term):
            scrubbed = _term_pattern(piece).sub(REDACTED, scrubbed)

    for pattern in _SELF_PATTERNS:
        scrubbed = pattern.sub(REDACTED, scrubbed)

    for pattern in _TERM_PATTERNS:
        scrubbed = pattern.sub(REDACTED, scrubbed)

    # Collapse runs of redactions and tidy whitespace left behind.
    scrubbed = re.sub(
        r"(?:{}[\s,;:]*)+".format(re.escape(REDACTED)), REDACTED + " ", scrubbed
    )
    scrubbed = re.sub(r"[ \t]{2,}", " ", scrubbed)
    return scrubbed.strip()


def anonymize(
    responses: Sequence[Tuple[str, str]]
) -> Tuple[List[Dict[str, str]], Dict[str, str]]:
    """Label and scrub a set of (model, content) pairs.

    Returns the anonymised entries and the label -> model mapping, which the
    server keeps private until Stage 2 results are aggregated.
    """
    if len(responses) > len(LABELS):
        raise ValueError(
            "Council is limited to {} members; got {}".format(
                len(LABELS), len(responses)
            )
        )

    all_models = [model for model, _ in responses]
    entries: List[Dict[str, str]] = []
    mapping: Dict[str, str] = {}

    for index, (model, content) in enumerate(responses):
        label = LABELS[index]
        mapping[label] = model
        entries.append(
            {"label": label, "content": scrub_identity(content, extra_terms=all_models)}
        )

    return entries, mapping


def format_for_review(entries: Sequence[Dict[str, str]]) -> str:
    """Render anonymised entries into a single reviewable block."""
    blocks = []
    for entry in entries:
        blocks.append(
            "### {label}\n{content}".format(
                label=entry["label"], content=entry["content"] or "(empty response)"
            )
        )
    return "\n\n---\n\n".join(blocks)


def leaks_identity(text: str, models: Sequence[str] = ()) -> bool:
    """True if `text` still contains an identifying reference.

    Used by the test suite as a guard, and by the orchestrator as a cheap
    assertion before Stage 2 prompts go out.
    """
    return scrub_identity(text, extra_terms=models) != (text or "").strip()
