from __future__ import annotations

import argparse
import fnmatch
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from mediafile import MediaFile

from .lyrics import is_zero_timestamp_only_lrc, strip_lrc_to_plain_text
from .media_tags import read_legacy_youtube_track_id, register_lms_mediafile_fields

DEFAULT_GLOB = "*.m4a"


@dataclass(slots=True)
class FixUnsyncedLrcConfig:
    root: Path
    apply: bool
    glob: str
    json_output: bool
    include_non_lms: bool


@dataclass(slots=True)
class RepairItemResult:
    path: Path
    action: str
    ok: bool
    message: str
    lrc_path: Path | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "path": str(self.path),
            "lrc_path": str(self.lrc_path) if self.lrc_path else None,
            "action": self.action,
            "ok": self.ok,
            "message": self.message,
        }


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Repair bogus all-zero-timestamp LRC lyrics in place."
    )
    parser.add_argument("--root", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--glob", default=DEFAULT_GLOB)
    parser.add_argument("--json", action="store_true", dest="json_output")
    parser.add_argument("--include-non-lms", action="store_true")
    return parser


def _config_from_args(args: argparse.Namespace) -> FixUnsyncedLrcConfig:
    return FixUnsyncedLrcConfig(
        root=Path(str(args.root)).expanduser(),
        apply=bool(args.apply),
        glob=str(args.glob),
        json_output=bool(args.json_output),
        include_non_lms=bool(args.include_non_lms),
    )


def _audio_candidates(root: Path, pattern: str) -> list[Path]:
    return sorted(
        path for path in root.rglob("*") if path.is_file() and fnmatch.fnmatch(path.name, pattern)
    )


def _is_lms_managed(media: MediaFile, path: Path) -> bool:
    if getattr(media, "lms_tag_schema_version", None):
        return True
    for field_name in (
        "lms_youtube_music_track_id",
        "lms_resolved_youtube_music_track_id",
        "lms_spotify_track_id",
        "lms_soundcloud_track_id",
    ):
        if getattr(media, field_name, None):
            return True
    return read_legacy_youtube_track_id(path) is not None


def _usable_plain_lyrics(text: str | None) -> str | None:
    stripped = strip_lrc_to_plain_text(text)
    return stripped if stripped and stripped.strip() else None


def _repair_file(
    path: Path,
    *,
    apply: bool,
    include_non_lms: bool,
) -> tuple[RepairItemResult, dict[str, int]]:
    register_lms_mediafile_fields()
    media = MediaFile(str(path))
    if not include_non_lms and not _is_lms_managed(media, path):
        return (
            RepairItemResult(path=path, lrc_path=path.with_suffix(".lrc"), action="skipped", ok=True, message="Unmanaged file."),
            {"eligible": 0, "repaired": 0, "deleted_lrc_only": 0, "skipped": 1, "failed": 0},
        )

    lrc_path = path.with_suffix(".lrc")
    embedded_text = media.lyrics if isinstance(media.lyrics, str) else None
    sidecar_text = lrc_path.read_text(encoding="utf-8") if lrc_path.exists() else None
    broken_embedded = is_zero_timestamp_only_lrc(embedded_text)
    broken_sidecar = is_zero_timestamp_only_lrc(sidecar_text)
    if not broken_embedded and not broken_sidecar:
        return (
            RepairItemResult(path=path, lrc_path=lrc_path if lrc_path.exists() else None, action="skipped", ok=True, message="No bogus all-zero LRC found."),
            {"eligible": 0, "repaired": 0, "deleted_lrc_only": 0, "skipped": 1, "failed": 0},
        )

    source_text = sidecar_text if sidecar_text else embedded_text
    plain_text = _usable_plain_lyrics(source_text)
    if plain_text is None:
        return (
            RepairItemResult(path=path, lrc_path=lrc_path if lrc_path.exists() else None, action="skipped", ok=True, message="No usable plain lyrics after stripping timestamps."),
            {"eligible": 1, "repaired": 0, "deleted_lrc_only": 0, "skipped": 1, "failed": 0},
        )

    if not apply:
        action = "repair" if broken_embedded else "delete_lrc_only"
        message = (
            "Would rewrite embedded lyrics to plain text and delete sidecar."
            if action == "repair"
            else "Would delete bogus sidecar; embedded plain lyrics already usable."
        )
        return (
            RepairItemResult(path=path, lrc_path=lrc_path if lrc_path.exists() else None, action=action, ok=True, message=message),
            {"eligible": 1, "repaired": 0, "deleted_lrc_only": 0, "skipped": 0, "failed": 0},
        )

    try:
        deleted_lrc = False
        if broken_embedded:
            media.lyrics = plain_text
            media.save()
        elif isinstance(embedded_text, str) and embedded_text.strip():
            plain_existing = _usable_plain_lyrics(embedded_text)
            if plain_existing is not None:
                plain_text = plain_existing
        if lrc_path.exists():
            lrc_path.unlink()
            deleted_lrc = True
    except OSError as exc:
        return (
            RepairItemResult(path=path, lrc_path=lrc_path if lrc_path.exists() else None, action="failed", ok=False, message=str(exc)),
            {"eligible": 1, "repaired": 0, "deleted_lrc_only": 0, "skipped": 0, "failed": 1},
        )

    if broken_embedded:
        return (
            RepairItemResult(path=path, lrc_path=lrc_path if deleted_lrc else None, action="repaired", ok=True, message="Embedded lyrics rewritten to plain text; sidecar deleted." if deleted_lrc else "Embedded lyrics rewritten to plain text."),
            {"eligible": 1, "repaired": 1, "deleted_lrc_only": 0, "skipped": 0, "failed": 0},
        )
    return (
        RepairItemResult(path=path, lrc_path=lrc_path if deleted_lrc else None, action="deleted_lrc_only", ok=True, message="Bogus sidecar deleted; embedded plain lyrics preserved."),
        {"eligible": 1, "repaired": 0, "deleted_lrc_only": 1, "skipped": 0, "failed": 0},
    )


def run_fix(config: FixUnsyncedLrcConfig) -> dict[str, Any]:
    if not config.root.is_dir():
        raise FileNotFoundError(f"Root directory not found: {config.root}")

    summary = {
        "scanned": 0,
        "eligible": 0,
        "repaired": 0,
        "deleted_lrc_only": 0,
        "skipped": 0,
        "failed": 0,
    }
    results: list[RepairItemResult] = []

    for path in _audio_candidates(config.root, config.glob):
        summary["scanned"] += 1
        result, counts = _repair_file(
            path,
            apply=config.apply,
            include_non_lms=config.include_non_lms,
        )
        results.append(result)
        for key, value in counts.items():
            summary[key] += value

    return {
        "ok": summary["failed"] == 0,
        "apply": config.apply,
        "root": str(config.root),
        "glob": config.glob,
        "include_non_lms": config.include_non_lms,
        **summary,
        "results": [result.as_dict() for result in results],
    }


def _print_result(result: dict[str, Any]) -> None:
    for item in result["results"]:
        status = "OK" if item["ok"] else "FAIL"
        print(f"{status} {item['action']} {item['path']}")
        print(f"  {item['message']}")
    print(
        "Scanned: {scanned} Eligible: {eligible} Repaired: {repaired} "
        "DeletedLrcOnly: {deleted_lrc_only} Skipped: {skipped} Failed: {failed} Apply: {apply}".format(
            **result
        )
    )


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    result = run_fix(_config_from_args(args))
    if args.json_output:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        _print_result(result)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
