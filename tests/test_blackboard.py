import pytest
from parliament.blackboard import Blackboard


def test_add_turn_appends():
    bb = Blackboard(topic="test topic")
    bb.add_turn("Proposer", "advocate", "AI should have rights.")
    assert len(bb.turns) == 1
    assert bb.turns[0]["agent"] == "Proposer"
    assert bb.turns[0]["content"] == "AI should have rights."


def test_last_n_turns_returns_correct_slice():
    bb = Blackboard(topic="test")
    for i in range(5):
        bb.add_turn(f"Agent{i}", "type", f"content {i}")
    last = bb.last_n_turns(3)
    assert len(last) == 3
    assert last[0]["agent"] == "Agent2"
    assert last[-1]["agent"] == "Agent4"


def test_last_n_turns_fewer_than_n():
    bb = Blackboard(topic="test")
    bb.add_turn("A", "x", "hello")
    assert len(bb.last_n_turns(10)) == 1


def test_detect_echo_loop_true():
    bb = Blackboard(topic="test")
    bb.add_turn("Proposer", "advocate", "position a")
    bb.add_turn("Skeptic", "critic", "counter b")
    bb.add_turn("Proposer", "advocate", "position a again")
    bb.add_turn("Skeptic", "critic", "counter b again")
    assert bb.detect_echo_loop() is True


def test_detect_echo_loop_false_no_pattern():
    bb = Blackboard(topic="test")
    bb.add_turn("Proposer", "advocate", "a")
    bb.add_turn("Skeptic", "critic", "b")
    bb.add_turn("Synthesizer", "integrator", "c")
    bb.add_turn("Proposer", "advocate", "d")
    assert bb.detect_echo_loop() is False


def test_detect_echo_loop_insufficient_turns():
    bb = Blackboard(topic="test")
    bb.add_turn("Proposer", "advocate", "a")
    bb.add_turn("Skeptic", "critic", "b")
    assert bb.detect_echo_loop() is False


def test_initial_state():
    bb = Blackboard(topic="foo")
    assert bb.resolved is False
    assert bb.residue is None
    assert bb.conflicts == []
    assert bb.turns == []


def test_timestamp_present():
    bb = Blackboard(topic="test")
    bb.add_turn("Proposer", "advocate", "content")
    assert bb.turns[0]["timestamp"] != ""
