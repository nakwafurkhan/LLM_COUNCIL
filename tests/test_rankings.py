"""Reviewers return messy JSON. The parser must be forgiving but never invent."""
from __future__ import annotations

from backend import rankings

LABELS = ["Response A", "Response B", "Response C"]


def test_parses_clean_json():
    text = '{"rankings": [{"label": "Response A", "rank": 2}, {"label": "Response B", "rank": 1}]}'
    parsed = rankings.parse_review(text, LABELS)
    assert parsed["parsed"] is True
    assert parsed["ranks"] == {"Response A": 2, "Response B": 1}


def test_parses_fenced_json_with_surrounding_prose():
    text = (
        "Here is my assessment.\n\n"
        "```json\n"
        '{"rankings": [{"label": "Response C", "rank": 1, "reason": "most rigorous"}]}\n'
        "```\n"
        "Happy to elaborate."
    )
    parsed = rankings.parse_review(text, LABELS)
    assert parsed["parsed"] is True
    assert parsed["ranks"] == {"Response C": 1}
    assert parsed["notes"]["Response C"] == "most rigorous"


def test_parses_bare_letter_labels():
    text = '[{"label": "A", "rank": 1}, {"label": "B", "rank": 2}]'
    parsed = rankings.parse_review(text, LABELS)
    assert parsed["ranks"] == {"Response A": 1, "Response B": 2}


def test_accepts_alternate_key_names():
    text = '{"results": [{"response": "Response B", "position": 1, "rationale": "tight"}]}'
    parsed = rankings.parse_review(text, LABELS)
    assert parsed["ranks"] == {"Response B": 1}
    assert parsed["notes"]["Response B"] == "tight"


def test_unparseable_review_is_reported_not_faked():
    parsed = rankings.parse_review("I refuse to rank these.", LABELS)
    assert parsed["parsed"] is False
    assert parsed["ranks"] == {}


def test_ignores_unknown_labels():
    text = '{"rankings": [{"label": "Response Z", "rank": 1}, {"label": "Response A", "rank": 2}]}'
    parsed = rankings.parse_review(text, LABELS)
    assert parsed["ranks"] == {"Response A": 2}


def test_ignores_non_numeric_ranks():
    text = '{"rankings": [{"label": "Response A", "rank": "best"}]}'
    assert rankings.parse_review(text, LABELS)["parsed"] is False


def test_aggregate_uses_borda_points():
    reviews = [
        {"ranks": {"Response A": 1, "Response B": 2, "Response C": 3}},
        {"ranks": {"Response A": 1, "Response B": 3, "Response C": 2}},
    ]
    table = rankings.aggregate(reviews, LABELS)
    assert [row["label"] for row in table] == ["Response A", "Response B", "Response C"]
    # rank 1 of 3 scores 3 points; A won twice.
    assert table[0]["points"] == 6
    assert table[0]["position"] == 1
    assert table[0]["average_rank"] == 1.0


def test_aggregate_breaks_ties_deterministically():
    reviews = [{"ranks": {"Response A": 1, "Response B": 1, "Response C": 3}}]
    table = rankings.aggregate(reviews, LABELS)
    assert [row["label"] for row in table][:2] == ["Response A", "Response B"]


def test_aggregate_handles_no_valid_reviews():
    table = rankings.aggregate([{"ranks": {}}], LABELS)
    assert all(row["points"] == 0 for row in table)
    assert all(row["average_rank"] is None for row in table)
    assert [row["position"] for row in table] == [1, 2, 3]


def test_aggregate_ignores_out_of_range_ranks():
    table = rankings.aggregate([{"ranks": {"Response A": 99, "Response B": 0}}], LABELS)
    assert all(row["points"] == 0 for row in table)


def test_attach_models_reveals_authors():
    table = rankings.aggregate([{"ranks": {"Response A": 1}}], LABELS)
    revealed = rankings.attach_models(table, {"Response A": "openai/gpt-4o"})
    winner = [row for row in revealed if row["label"] == "Response A"][0]
    assert winner["model"] == "openai/gpt-4o"
    assert revealed[0]["model"] in ("openai/gpt-4o", "unknown")


def test_attach_models_marks_missing_mapping():
    table = rankings.aggregate([{"ranks": {"Response B": 1}}], LABELS)
    revealed = rankings.attach_models(table, {})
    assert revealed[0]["model"] == "unknown"
