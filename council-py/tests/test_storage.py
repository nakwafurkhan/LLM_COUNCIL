"""Conversation persistence."""
from __future__ import annotations

import pytest

from backend import storage


def test_new_conversation_is_saved_and_loadable():
    created = storage.new_conversation(title="First run")
    loaded = storage.load(created["id"])
    assert loaded is not None
    assert loaded["title"] == "First run"
    assert loaded["turns"] == []


def test_append_turn_records_everything():
    created = storage.new_conversation()
    storage.append_turn(
        created["id"],
        query="q1",
        final="a1",
        stage1=[{"model": "m", "content": "c"}],
        leaderboard=[{"position": 1, "model": "m"}],
        totals={"calls": 3},
        reveal={"Response A": "m"},
    )
    loaded = storage.load(created["id"])
    turn = loaded["turns"][0]
    assert turn["query"] == "q1"
    assert turn["final"] == "a1"
    assert turn["totals"]["calls"] == 3
    assert turn["reveal"] == {"Response A": "m"}


def test_untitled_conversation_takes_its_first_query_as_title():
    created = storage.new_conversation()
    assert created["title"] == "Untitled"
    storage.append_turn(
        created["id"], query="How do I index this?", final="a",
        stage1=[], leaderboard=[], totals={},
    )
    assert storage.load(created["id"])["title"] == "How do I index this?"


def test_append_turn_on_missing_conversation_returns_none():
    assert storage.append_turn(
        "deadbeef", query="q", final="a", stage1=[], leaderboard=[], totals={}
    ) is None


def test_list_is_newest_first():
    first = storage.new_conversation(title="older")
    second = storage.new_conversation(title="newer")
    storage.append_turn(
        second["id"], query="q", final="a", stage1=[], leaderboard=[], totals={}
    )
    listed = storage.list_conversations()
    # `second` was touched most recently, so it leads.
    assert [item["id"] for item in listed] == [second["id"], first["id"]]
    assert listed[0]["turns"] == 1


def test_history_messages_alternate_roles():
    created = storage.new_conversation()
    for i in range(3):
        storage.append_turn(
            created["id"], query="q{}".format(i), final="a{}".format(i),
            stage1=[], leaderboard=[], totals={},
        )
    history = storage.history_messages(created["id"])
    assert [m["role"] for m in history] == ["user", "assistant"] * 3
    assert history[0]["content"] == "q0"


def test_history_is_capped():
    created = storage.new_conversation()
    for i in range(10):
        storage.append_turn(
            created["id"], query="q{}".format(i), final="a{}".format(i),
            stage1=[], leaderboard=[], totals={},
        )
    assert len(storage.history_messages(created["id"], max_turns=2)) == 4


def test_history_of_unknown_conversation_is_empty():
    assert storage.history_messages("nope") == []


@pytest.mark.parametrize("bad_id", ["", "../../etc/passwd", "///", "!!!"])
def test_traversal_ids_are_refused(bad_id):
    with pytest.raises(ValueError):
        storage.load(bad_id)


def test_delete_removes_the_file():
    created = storage.new_conversation()
    assert storage.delete(created["id"]) is True
    assert storage.load(created["id"]) is None
    assert storage.delete(created["id"]) is False


def test_corrupt_file_is_skipped_not_fatal():
    created = storage.new_conversation(title="fine")
    from backend import config

    (config.DATA_DIR / "corrupt.json").write_text("{not json", encoding="utf-8")

    listed = storage.list_conversations()
    assert [item["id"] for item in listed] == [created["id"]]
