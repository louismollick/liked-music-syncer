from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from mediafile import MediaFile

from .album_identity import LEGACY_UNKNOWN_ALBUM_NAME, UNKNOWN_ALBUM_NAME
from .media_tags import register_lms_mediafile_fields, read_legacy_youtube_track_id
from .templating import OutputLayout


@dataclass(slots=True)
class MigrationConfig:
    output_directory: Path
    folder_template: str
    file_template: str
    rclone_remote: str
    remote_music_root: str
    apply: bool
    skip_remote: bool


@dataclass(slots=True)
class MigrationItemResult:
    source_path: Path
    target_path: Path
    source_lrc_path: Path | None
    target_lrc_path: Path | None
    action: str
    ok: bool
    message: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "source_path": str(self.source_path),
            "target_path": str(self.target_path),
            "source_lrc_path": str(self.source_lrc_path) if self.source_lrc_path else None,
            "target_lrc_path": str(self.target_lrc_path) if self.target_lrc_path else None,
            "action": self.action,
            "ok": self.ok,
            "message": self.message,
        }


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Migrate LMS _Singles tags to Unknown Album.")
    parser.add_argument("--output-directory", required=True)
    parser.add_argument("--folder-template", required=True)
    parser.add_argument("--file-template", default="{track:02d} {title}")
    parser.add_argument("--rclone-remote", default="")
    parser.add_argument("--remote-music-root", default="")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--skip-remote", action="store_true")
    return parser


def _config_from_args(args: argparse.Namespace) -> MigrationConfig:
    return MigrationConfig(
        output_directory=Path(args.output_directory).expanduser(),
        folder_template=str(args.folder_template),
        file_template=str(args.file_template),
        rclone_remote=str(args.rclone_remote),
        remote_music_root=str(args.remote_music_root),
        apply=bool(args.apply),
        skip_remote=bool(args.skip_remote),
    )


def _config_from_payload(payload: dict[str, Any]) -> MigrationConfig:
    return MigrationConfig(
        output_directory=Path(str(payload["output_directory"])).expanduser(),
        folder_template=str(payload["folder_template"]),
        file_template=str(payload.get("file_template", "{track:02d} {title}")),
        rclone_remote=str(payload.get("rclone_remote", "")),
        remote_music_root=str(payload.get("remote_music_root", "")),
        apply=bool(payload.get("apply", False)),
        skip_remote=bool(payload.get("skip_remote", False)),
    )


def _ensure_remote_config(config: MigrationConfig) -> None:
    if config.skip_remote:
        return
    if not config.rclone_remote or not config.remote_music_root:
        raise ValueError(
            "Remote sync requires --rclone-remote and --remote-music-root, or pass --skip-remote."
        )


def _is_lms_identifiable(media: MediaFile, path: Path) -> bool:
    tag_schema_version = getattr(media, "lms_tag_schema_version", None)
    if tag_schema_version:
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


def _audio_candidates(root: Path) -> list[Path]:
    return sorted(path for path in root.rglob("*.m4a") if path.is_file())


def _target_paths(
    config: MigrationConfig,
    source_path: Path,
    media: MediaFile,
) -> tuple[Path, Path | None]:
    layout = OutputLayout(
        folder_template=config.folder_template,
        file_template=config.file_template,
    )
    context = {
        "albumartist": media.albumartist or media.artist or "Unknown Artist",
        "album": UNKNOWN_ALBUM_NAME,
        "track": media.track or 0,
        "title": media.title or source_path.stem,
        "artist": media.artist or "Unknown Artist",
    }
    target_path = layout.build_path(config.output_directory, context)
    source_lrc_path = source_path.with_suffix(".lrc")
    target_lrc_path = target_path.with_suffix(".lrc") if source_lrc_path.exists() else None
    return target_path, target_lrc_path


def _remote_target(config: MigrationConfig, local_path: Path) -> str:
    relative = local_path.relative_to(config.output_directory).as_posix()
    return f"{config.rclone_remote}:{config.remote_music_root.rstrip('/')}/{relative}"


def _copy_remote_file(local_path: Path, remote_path: str) -> None:
    subprocess.run(["rclone", "copyto", str(local_path), remote_path], check=True, capture_output=True)


def _delete_remote_file(remote_path: str) -> None:
    subprocess.run(["rclone", "deletefile", remote_path], check=True, capture_output=True)


def _migrate_file(config: MigrationConfig, source_path: Path) -> MigrationItemResult | None:
    register_lms_mediafile_fields()
    media = MediaFile(str(source_path))
    if media.album != LEGACY_UNKNOWN_ALBUM_NAME:
        return None
    if not _is_lms_identifiable(media, source_path):
        return None

    target_path, target_lrc_path = _target_paths(config, source_path, media)
    source_lrc_path = source_path.with_suffix(".lrc")
    had_source_lrc = source_lrc_path.exists()
    moved_audio = target_path.resolve() != source_path.resolve()
    moved_lrc = bool(
        had_source_lrc
        and target_lrc_path is not None
        and source_lrc_path.resolve() != target_lrc_path.resolve()
    )

    if target_path.exists() and moved_audio:
        return MigrationItemResult(
            source_path=source_path,
            target_path=target_path,
            source_lrc_path=source_lrc_path if had_source_lrc else None,
            target_lrc_path=target_lrc_path,
            action="collision",
            ok=False,
            message="Target path already exists.",
        )

    if not config.apply:
        return MigrationItemResult(
            source_path=source_path,
            target_path=target_path,
            source_lrc_path=source_lrc_path if had_source_lrc else None,
            target_lrc_path=target_lrc_path,
            action="dry-run",
            ok=True,
            message="Would rewrite album tag and move artifacts.",
        )

    media.album = UNKNOWN_ALBUM_NAME
    media.save()

    target_path.parent.mkdir(parents=True, exist_ok=True)
    final_source_path = source_path
    if moved_audio:
        shutil.move(str(source_path), str(target_path))
        final_source_path = target_path

    if moved_lrc and target_lrc_path is not None:
        target_lrc_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(source_lrc_path), str(target_lrc_path))

    if not config.skip_remote:
        _copy_remote_file(final_source_path, _remote_target(config, final_source_path))
        if target_lrc_path and target_lrc_path.exists():
            _copy_remote_file(target_lrc_path, _remote_target(config, target_lrc_path))
        if moved_audio:
            _delete_remote_file(_remote_target(config, source_path))
        if moved_lrc:
            _delete_remote_file(_remote_target(config, source_lrc_path))

    return MigrationItemResult(
        source_path=source_path,
        target_path=target_path,
        source_lrc_path=source_lrc_path if had_source_lrc else None,
        target_lrc_path=target_lrc_path,
        action="migrated",
        ok=True,
        message="Album tag rewritten to Unknown Album.",
    )


def run_migration(config: MigrationConfig) -> dict[str, Any]:
    _ensure_remote_config(config)
    if not config.output_directory.is_dir():
        raise FileNotFoundError(f"Output directory not found: {config.output_directory}")

    results: list[MigrationItemResult] = []
    for source_path in _audio_candidates(config.output_directory):
        result = _migrate_file(config, source_path)
        if result is not None:
            results.append(result)

    failures = [result for result in results if not result.ok]
    return {
        "ok": not failures,
        "apply": config.apply,
        "skip_remote": config.skip_remote,
        "candidate_count": len(results),
        "failure_count": len(failures),
        "results": [result.as_dict() for result in results],
    }


def migrate_unknown_album(payload: dict[str, Any]) -> dict[str, Any]:
    return run_migration(_config_from_payload(payload))


def _print_result(result: dict[str, Any]) -> None:
    for item in result["results"]:
        status = "OK" if item["ok"] else "FAIL"
        print(f"{status} {item['action']} {item['source_path']} -> {item['target_path']}")
        print(f"  {item['message']}")
    print(
        f"Candidates: {result['candidate_count']} Failures: {result['failure_count']} Apply: {result['apply']}"
    )


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        result = run_migration(_config_from_args(args))
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1
    _print_result(result)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
