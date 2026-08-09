#!/usr/bin/env python3
"""Copy this file, fill the configuration and condition_is_met(), then register it with CodeLark."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from typing import Any


INTERVAL_SECONDS = 300
TIMEOUT_SECONDS = 60

OWNER_TARGET = "replace-with-owner-target"
OWNER_HOME = "replace-with-owner-codelark-home"
TARGET = "replace-with-target"
TARGET_HOME = "replace-with-target-codelark-home"

# "agent" sends ordinary input to an Agent lane. "message" sends a visible
# Feishu message using official msg_type + content.
DELIVERY_KIND = "message"

SOURCE_TARGET = OWNER_TARGET
SOURCE_HOME = OWNER_HOME
AGENT_TEXT = "The monitored condition is now satisfied."

MESSAGE_TYPE = "interactive"
MESSAGE_CONTENT: dict[str, Any] = {
    "schema": "2.0",
    "header": {
        "template": "green",
        "title": {"tag": "plain_text", "content": "Condition satisfied"},
    },
    "body": {
        "elements": [{"tag": "markdown", "content": "The monitored condition is now satisfied."}],
    },
}

# Empty means no @ mention. When populated, MESSAGE_CONTENT must contain each
# user ID using the official representation for MESSAGE_TYPE.
MENTION_USER_IDS: list[str] = []


def condition_is_met() -> bool:
    """Perform only read-only checks and return the exact condition assertion."""
    raise NotImplementedError("Replace with a read-only condition check")


def validate_configuration() -> None:
    assert isinstance(INTERVAL_SECONDS, int) and INTERVAL_SECONDS > 0
    assert isinstance(TIMEOUT_SECONDS, int) and TIMEOUT_SECONDS > 0
    assert OWNER_TARGET and OWNER_HOME and TARGET and TARGET_HOME
    assert DELIVERY_KIND in {"agent", "message"}
    if DELIVERY_KIND == "agent":
        assert SOURCE_TARGET and SOURCE_HOME and AGENT_TEXT
    else:
        assert MESSAGE_TYPE and isinstance(MESSAGE_CONTENT, dict)
        rendered = json.dumps(MESSAGE_CONTENT, ensure_ascii=False)
        assert all(user_id and user_id in rendered for user_id in MENTION_USER_IDS), (
            "Add every MENTION_USER_IDS entry using the official Feishu representation in MESSAGE_CONTENT"
        )


def build_codelark_command(arguments: list[str], platform_name: str | None = None) -> list[str]:
    platform_name = platform_name or os.name
    default_executable = "codelark.cmd" if platform_name == "nt" else "codelark"
    executable = os.environ.get("CODELARK_BIN", default_executable)
    command = [executable, *arguments]
    if platform_name == "nt" and executable.lower().endswith((".cmd", ".bat")):
        command_interpreter = os.environ.get("COMSPEC", "cmd.exe")
        return [command_interpreter, "/d", "/s", "/c", subprocess.list2cmdline(command)]
    return command


def send_notification() -> None:
    monitor_id = os.environ.get("CODELARK_MONITOR_ID", "").strip()
    if not monitor_id:
        raise RuntimeError("CODELARK_MONITOR_ID is required for idempotent delivery")
    if DELIVERY_KIND == "agent":
        arguments = [
            "send", "agent",
            "--source", SOURCE_TARGET, "--source-home", SOURCE_HOME,
            "--target", TARGET, "--home", TARGET_HOME,
            "--text", AGENT_TEXT,
            "--idempotency-key", monitor_id,
        ]
    else:
        arguments = [
            "send", "message",
            "--target", TARGET, "--home", TARGET_HOME,
            "--msg-type", MESSAGE_TYPE,
            "--content", json.dumps(MESSAGE_CONTENT, ensure_ascii=False, separators=(",", ":")),
            "--idempotency-key", monitor_id,
        ]
    command = build_codelark_command(arguments)
    result = subprocess.run(command, check=False, capture_output=True, text=True)
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit={result.returncode}"
        raise RuntimeError(f"codelark send failed: {detail}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--describe", action="store_true")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--tick", action="store_true")
    args = parser.parse_args()
    validate_configuration()
    if args.describe:
        print(json.dumps({
            "interval_seconds": INTERVAL_SECONDS,
            "timeout_seconds": TIMEOUT_SECONDS,
        }, separators=(",", ":")))
        return 0
    if not (args.check or args.tick):
        parser.error("choose --describe, --check, or --tick")
    met = bool(condition_is_met())
    if not met:
        return 1
    if args.tick:
        send_notification()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
