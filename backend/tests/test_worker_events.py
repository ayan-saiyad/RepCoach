"""Contract tests for Kafka payload validation and bounded retry metadata."""

import json

import pytest

from worker.consumer import decode_event


def valid_event() -> bytes:
    return json.dumps(
        {
            "event_version": 1,
            "rep_id": "rep-1",
            "session_id": "session-1",
            "features": {"minimum_knee_angle": 95},
        }
    ).encode()


def test_decode_event_accepts_versioned_contract() -> None:
    assert decode_event(valid_event())["rep_id"] == "rep-1"


def test_decode_event_rejects_unknown_versions() -> None:
    event = json.loads(valid_event())
    event["event_version"] = 2

    with pytest.raises(ValueError, match="unsupported"):
        decode_event(json.dumps(event).encode())


def test_decode_event_rejects_incomplete_payloads() -> None:
    with pytest.raises(ValueError, match="missing fields"):
        decode_event(b'{"event_version": 1}')
