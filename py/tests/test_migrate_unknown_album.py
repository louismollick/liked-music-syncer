from __future__ import annotations

import io
import subprocess
from pathlib import Path

import pytest
from PIL import Image

from liked_music_syncer.album_identity import UNKNOWN_ALBUM_NAME
from liked_music_syncer.media_tags import write_media_tags
from liked_music_syncer.migrate_unknown_album import MigrationConfig, run_migration
from liked_music_syncer.models import SyncItemState


def _make_m4a(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=44100:cl=stereo",
            "-t",
            "0.2",
            "-c:a",
            "aac",
            str(path),
        ],
        check=True,
        capture_output=True,
    )


def _cover_bytes() -> bytes:
    image = Image.new("RGB", (8, 8), (255, 0, 0))
    handle = io.BytesIO()
    image.save(handle, format="PNG")
    return handle.getvalue()


def _item(album: str = "_Singles") -> SyncItemState:
    return SyncItemState(
        id="item_123",
        source_video_id="liked123",
        title="Track Title",
        artist="Artist Name",
        album=album,
        album_artist="Album Artist",
        source_url="https://music.youtube.com/watch?v=liked123",
        cover_art_url=None,
        track_number=1,
    )


def _config(tmp_path: Path, *, apply: bool, skip_remote: bool) -> MigrationConfig:
    return MigrationConfig(
        output_directory=tmp_path,
        folder_template="{albumartist}/{album}",
        file_template="{track:02d} {title}",
        rclone_remote="remote",
        remote_music_root="/music",
        apply=apply,
        skip_remote=skip_remote,
    )


def test_migration_dry_run_reports_candidate_without_mutation(tmp_path: Path) -> None:
    audio_path = tmp_path / "Album Artist" / "_Singles" / "01 Track Title.m4a"
    _make_m4a(audio_path)
    write_media_tags(audio_path, _item(), _cover_bytes(), None)
    original_bytes = audio_path.read_bytes()

    result = run_migration(_config(tmp_path, apply=False, skip_remote=True))

    assert result["ok"] is True
    assert result["candidate_count"] == 1
    assert result["results"][0]["action"] == "dry-run"
    assert audio_path.exists()
    assert audio_path.read_bytes() == original_bytes


def test_migration_apply_moves_audio_and_sidecar_and_rewrites_tag(tmp_path: Path) -> None:
    audio_path = tmp_path / "Album Artist" / "_Singles" / "01 Track Title.m4a"
    lrc_path = audio_path.with_suffix(".lrc")
    _make_m4a(audio_path)
    write_media_tags(audio_path, _item(), _cover_bytes(), None)
    lrc_path.write_text("[00:01.00]line\n", encoding="utf-8")

    result = run_migration(_config(tmp_path, apply=True, skip_remote=True))
    migrated = tmp_path / "Album Artist" / UNKNOWN_ALBUM_NAME / "01 Track Title.m4a"

    assert result["ok"] is True
    assert migrated.exists()
    assert migrated.with_suffix(".lrc").exists()
    assert not audio_path.exists()
    assert not lrc_path.exists()


def test_migration_apply_syncs_remote_and_deletes_old_remote_paths(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    audio_path = tmp_path / "Album Artist" / "_Singles" / "01 Track Title.m4a"
    lrc_path = audio_path.with_suffix(".lrc")
    _make_m4a(audio_path)
    write_media_tags(audio_path, _item(), _cover_bytes(), None)
    lrc_path.write_text("[00:01.00]line\n", encoding="utf-8")
    copied: list[tuple[str, str]] = []
    deleted: list[str] = []

    monkeypatch.setattr(
        "liked_music_syncer.migrate_unknown_album._copy_remote_file",
        lambda local_path, remote_path: copied.append((str(local_path), remote_path)),
    )
    monkeypatch.setattr(
        "liked_music_syncer.migrate_unknown_album._delete_remote_file",
        deleted.append,
    )

    result = run_migration(_config(tmp_path, apply=True, skip_remote=False))

    assert result["ok"] is True
    assert any(UNKNOWN_ALBUM_NAME in remote_path for _, remote_path in copied)
    assert any("_Singles" in remote_path for remote_path in deleted)


def test_migration_skips_collision(tmp_path: Path) -> None:
    audio_path = tmp_path / "Album Artist" / "_Singles" / "01 Track Title.m4a"
    target_path = tmp_path / "Album Artist" / UNKNOWN_ALBUM_NAME / "01 Track Title.m4a"
    _make_m4a(audio_path)
    write_media_tags(audio_path, _item(), _cover_bytes(), None)
    _make_m4a(target_path)

    result = run_migration(_config(tmp_path, apply=True, skip_remote=True))

    assert result["ok"] is False
    assert result["failure_count"] == 1
    assert result["results"][0]["action"] == "collision"


def test_migration_rerun_is_idempotent(tmp_path: Path) -> None:
    audio_path = tmp_path / "Album Artist" / "_Singles" / "01 Track Title.m4a"
    _make_m4a(audio_path)
    write_media_tags(audio_path, _item(), _cover_bytes(), None)

    first = run_migration(_config(tmp_path, apply=True, skip_remote=True))
    second = run_migration(_config(tmp_path, apply=True, skip_remote=True))

    assert first["candidate_count"] == 1
    assert second["candidate_count"] == 0
