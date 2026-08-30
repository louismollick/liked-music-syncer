#!/usr/bin/env python3
"""Delete only duplicate VPS paths approved by the drift inventory."""

from __future__ import annotations

import csv
import subprocess
import tempfile
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath


REPO_ROOT = Path(__file__).resolve().parents[1]
INVENTORY = REPO_ROOT / "reports" / "music-drift-2026-08-29.csv"
AUDIT_LOG = REPO_ROOT / "reports" / "music-drift-cleanup-2026-08-29.csv"
REMOTE_ROOT = "vps:/home/ubuntu/louismollick-server/music"
DELETE_STATUSES = {
    "remote_only_duplicate_by_id",
    "remote_only_duplicate_by_metadata",
}


def remote_target(relative_path: str) -> str:
    path = PurePosixPath(relative_path)
    if path.is_absolute() or ".." in path.parts or path.suffix.lower() not in {".m4a", ".lrc"}:
        raise ValueError(f"Unsafe inventory path: {relative_path!r}")
    return f"{REMOTE_ROOT}/{path.as_posix()}"


def main() -> None:
    with INVENTORY.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))

    candidates = [row for row in rows if row["status"] in DELETE_STATUSES]
    paths = sorted({row["remote_path"] for row in candidates})
    if len(paths) != 943:
        raise RuntimeError(f"Expected 943 approved audio paths, found {len(paths)}")
    if any(row["remote_path"] == row["local_path"] for row in candidates):
        raise RuntimeError("Inventory contains a canonical local path in the deletion set")

    listed = subprocess.run(
        ["rclone", "lsf", REMOTE_ROOT, "--recursive", "--files-only"],
        check=True,
        capture_output=True,
        text=True,
    )
    existing = set(listed.stdout.splitlines())
    requested: list[tuple[str, str]] = []
    for audio_path in paths:
        requested.append(("audio", audio_path))
        requested.append(("sidecar", str(PurePosixPath(audio_path).with_suffix(".lrc"))))
    for _, relative_path in requested:
        remote_target(relative_path)

    present = [relative_path for _, relative_path in requested if relative_path in existing]
    with tempfile.NamedTemporaryFile("w", encoding="utf-8") as allowlist:
        allowlist.write("\n".join(present) + "\n")
        allowlist.flush()
        subprocess.run(
            ["rclone", "delete", REMOTE_ROOT, "--files-from", allowlist.name],
            check=True,
        )

    deleted = set(present)
    timestamp = datetime.now(tz=UTC).isoformat()
    audit = [
        {
            "timestamp_utc": timestamp,
            "kind": kind,
            "relative_path": relative_path,
            "outcome": "deleted" if relative_path in deleted else "not_present",
        }
        for kind, relative_path in requested
    ]

    with AUDIT_LOG.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(audit[0]))
        writer.writeheader()
        writer.writerows(audit)
    print(f"Processed {len(paths)} duplicate audio paths")
    print(f"Audit log: {AUDIT_LOG}")


if __name__ == "__main__":
    main()
