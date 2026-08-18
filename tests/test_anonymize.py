"""Stage 2 must not leak authorship. These tests are the guarantee."""
from __future__ import annotations

import pytest

from backend import anonymize


def test_labels_are_assigned_in_order():
    entries, mapping = anonymize.anonymize(
        [("openai/gpt-4o", "alpha"), ("anthropic/claude-sonnet-4.5", "beta")]
    )
    assert [e["label"] for e in entries] == ["Response A", "Response B"]
    assert mapping == {
        "Response A": "openai/gpt-4o",
        "Response B": "anthropic/claude-sonnet-4.5",
    }


@pytest.mark.parametrize(
    "text",
    [
        "As Claude, I would argue the opposite.",
        "I'm ChatGPT, developed by OpenAI, and here is my take.",
        "As a large language model trained by Google, I cannot be certain.",
        "Gemini here — the answer is 42.",
        "This is Grok's view on the matter.",
        "I am an AI assistant created by Anthropic.",
        "My knowledge cutoff is June 2024, so caveat that.",
    ],
)
def test_scrub_removes_self_identification(text):
    scrubbed = anonymize.scrub_identity(text)
    lowered = scrubbed.lower()
    for brand in ("claude", "chatgpt", "openai", "google", "gemini", "grok", "anthropic"):
        assert brand not in lowered, "leaked {!r} from {!r}".format(brand, text)


def test_scrub_removes_namespaced_model_ids():
    scrubbed = anonymize.scrub_identity("Routed via anthropic/claude-sonnet-4.5 today.")
    assert "claude" not in scrubbed.lower()
    assert "anthropic" not in scrubbed.lower()


def test_scrub_removes_extra_terms_from_live_lineup():
    scrubbed = anonymize.scrub_identity(
        "Kimi thinks otherwise.", extra_terms=["moonshot/kimi-k2"]
    )
    assert "kimi" not in scrubbed.lower()


def test_scrub_preserves_ordinary_content():
    text = "Use a weighted moving average and validate on a holdout split."
    assert anonymize.scrub_identity(text) == text


def test_scrub_does_not_mangle_unrelated_slashes():
    # "and/or" is not a model id.
    out = anonymize.scrub_identity("Pick one and/or both, then measure.")
    assert "measure" in out


def test_anonymize_scrubs_bodies_not_just_labels():
    entries, _ = anonymize.anonymize(
        [
            ("openai/gpt-4o", "As ChatGPT I recommend indexing the table."),
            ("anthropic/claude-sonnet-4.5", "Claude would add a covering index."),
        ]
    )
    joined = " ".join(e["content"] for e in entries).lower()
    assert "chatgpt" not in joined
    assert "claude" not in joined
    assert "index" in joined  # substance survives


def test_format_for_review_includes_every_label():
    entries, _ = anonymize.anonymize([("m1", "one"), ("m2", "two"), ("m3", "three")])
    block = anonymize.format_for_review(entries)
    for label in ("Response A", "Response B", "Response C"):
        assert label in block


def test_format_for_review_marks_empty_bodies():
    entries, _ = anonymize.anonymize([("m1", "")])
    assert "(empty response)" in anonymize.format_for_review(entries)


def test_leaks_identity_detects_and_clears():
    assert anonymize.leaks_identity("As Claude, hello") is True
    assert anonymize.leaks_identity("A neutral technical answer.") is False


def test_council_size_is_bounded():
    too_many = [("m{}".format(i), "x") for i in range(len(anonymize.LABELS) + 1)]
    with pytest.raises(ValueError):
        anonymize.anonymize(too_many)


def test_scrub_handles_empty_input():
    assert anonymize.scrub_identity("") == ""
    assert anonymize.scrub_identity(None) == ""
