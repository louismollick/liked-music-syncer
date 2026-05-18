from __future__ import annotations

import json
import sys
from dataclasses import asdict, is_dataclass
from typing import Any, cast


def read_stdin_json() -> dict[str, Any]:
    raw = sys.stdin.read().strip()
    return json.loads(raw) if raw else {}


def write_json(payload: Any) -> None:
    if is_dataclass(payload) and not isinstance(payload, type):
        payload = asdict(cast(Any, payload))
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def emit_event(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()
