from __future__ import annotations

from pathlib import Path

import liked_music_syncer.fix_unsynced_lrc as fix_module


class FakeMediaFile:
    store: dict[str, dict[str, object]] = {}

    def __init__(self, path: str) -> None:
        self.path = path
        data = self.store.setdefault(path, {})
        self.lyrics = data.get("lyrics")
        self.lms_tag_schema_version = data.get("lms_tag_schema_version")
        self.lms_youtube_music_track_id = data.get("lms_youtube_music_track_id")
        self.lms_resolved_youtube_music_track_id = data.get(
            "lms_resolved_youtube_music_track_id"
        )
        self.lms_spotify_track_id = data.get("lms_spotify_track_id")
        self.lms_soundcloud_track_id = data.get("lms_soundcloud_track_id")
        self.save_calls = 0

    def save(self) -> None:
        self.save_calls += 1
        self.store[self.path]["lyrics"] = self.lyrics


def _audio_file(tmp_path: Path, name: str = "track.m4a") -> Path:
    path = tmp_path / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"audio")
    return path


def _install_fake_media(monkeypatch, path: Path, *, lyrics: str | None, managed: bool = True) -> None:
    FakeMediaFile.store[str(path)] = {
        "lyrics": lyrics,
        "lms_tag_schema_version": "2" if managed else None,
        "lms_youtube_music_track_id": "yt_1" if managed else None,
        "lms_resolved_youtube_music_track_id": None,
        "lms_spotify_track_id": None,
        "lms_soundcloud_track_id": None,
    }
    monkeypatch.setattr(fix_module, "MediaFile", FakeMediaFile)
    monkeypatch.setattr(fix_module, "register_lms_mediafile_fields", lambda: None)
    monkeypatch.setattr(fix_module, "read_legacy_youtube_track_id", lambda _path: None)


def test_repair_broken_sidecar_and_embedded_rewrites_embedded_and_deletes_lrc(
    tmp_path: Path, monkeypatch
) -> None:
    path = _audio_file(tmp_path)
    path.with_suffix(".lrc").write_text("[00:00.00]line one\n[00:00.00]line two\n", encoding="utf-8")
    _install_fake_media(
        monkeypatch,
        path,
        lyrics="[00:00.00]line one\n[00:00.00]line two\n",
    )

    result = fix_module.run_fix(
        fix_module.FixUnsyncedLrcConfig(
            root=tmp_path,
            apply=True,
            glob="*.m4a",
            json_output=False,
            include_non_lms=False,
        )
    )

    assert result["repaired"] == 1
    assert not path.with_suffix(".lrc").exists()
    assert FakeMediaFile.store[str(path)]["lyrics"] == "line one\nline two\n"


def test_repair_broken_sidecar_preserves_good_plain_embedded_and_deletes_lrc(
    tmp_path: Path, monkeypatch
) -> None:
    path = _audio_file(tmp_path)
    path.with_suffix(".lrc").write_text("[00:00.00]line one\n", encoding="utf-8")
    _install_fake_media(monkeypatch, path, lyrics="line one\n")

    result = fix_module.run_fix(
        fix_module.FixUnsyncedLrcConfig(
            root=tmp_path,
            apply=True,
            glob="*.m4a",
            json_output=False,
            include_non_lms=False,
        )
    )

    assert result["deleted_lrc_only"] == 1
    assert not path.with_suffix(".lrc").exists()
    assert FakeMediaFile.store[str(path)]["lyrics"] == "line one\n"


def test_repair_valid_synced_sidecar_is_untouched(tmp_path: Path, monkeypatch) -> None:
    path = _audio_file(tmp_path)
    path.with_suffix(".lrc").write_text("[00:01.00]line one\n", encoding="utf-8")
    _install_fake_media(monkeypatch, path, lyrics="[00:01.00]line one\n")

    result = fix_module.run_fix(
        fix_module.FixUnsyncedLrcConfig(
            root=tmp_path,
            apply=True,
            glob="*.m4a",
            json_output=False,
            include_non_lms=False,
        )
    )

    assert result["eligible"] == 0
    assert result["skipped"] == 1
    assert path.with_suffix(".lrc").exists()


def test_repair_dry_run_makes_no_changes(tmp_path: Path, monkeypatch) -> None:
    path = _audio_file(tmp_path)
    path.with_suffix(".lrc").write_text("[00:00.00]line one\n", encoding="utf-8")
    _install_fake_media(monkeypatch, path, lyrics="[00:00.00]line one\n")

    result = fix_module.run_fix(
        fix_module.FixUnsyncedLrcConfig(
            root=tmp_path,
            apply=False,
            glob="*.m4a",
            json_output=False,
            include_non_lms=False,
        )
    )

    assert result["eligible"] == 1
    assert result["repaired"] == 0
    assert path.with_suffix(".lrc").exists()
    assert FakeMediaFile.store[str(path)]["lyrics"] == "[00:00.00]line one\n"


def test_repair_unmanaged_file_skipped_by_default(tmp_path: Path, monkeypatch) -> None:
    path = _audio_file(tmp_path)
    path.with_suffix(".lrc").write_text("[00:00.00]line one\n", encoding="utf-8")
    _install_fake_media(monkeypatch, path, lyrics="[00:00.00]line one\n", managed=False)

    result = fix_module.run_fix(
        fix_module.FixUnsyncedLrcConfig(
            root=tmp_path,
            apply=True,
            glob="*.m4a",
            json_output=False,
            include_non_lms=False,
        )
    )

    assert result["eligible"] == 0
    assert result["skipped"] == 1
    assert path.with_suffix(".lrc").exists()


def test_repair_include_non_lms_allows_fixing_unmanaged_file(
    tmp_path: Path, monkeypatch
) -> None:
    path = _audio_file(tmp_path)
    path.with_suffix(".lrc").write_text("[00:00.00]line one\n", encoding="utf-8")
    _install_fake_media(monkeypatch, path, lyrics="[00:00.00]line one\n", managed=False)

    result = fix_module.run_fix(
        fix_module.FixUnsyncedLrcConfig(
            root=tmp_path,
            apply=True,
            glob="*.m4a",
            json_output=False,
            include_non_lms=True,
        )
    )

    assert result["repaired"] == 1
    assert not path.with_suffix(".lrc").exists()


def test_repair_empty_stripped_lyrics_skips_without_overwrite(
    tmp_path: Path, monkeypatch
) -> None:
    path = _audio_file(tmp_path)
    path.with_suffix(".lrc").write_text("[00:00.00]\n[00:00.00]\n", encoding="utf-8")
    _install_fake_media(monkeypatch, path, lyrics="[00:00.00]\n[00:00.00]\n")

    result = fix_module.run_fix(
        fix_module.FixUnsyncedLrcConfig(
            root=tmp_path,
            apply=True,
            glob="*.m4a",
            json_output=False,
            include_non_lms=False,
        )
    )

    assert result["eligible"] == 1
    assert result["repaired"] == 0
    assert result["skipped"] == 1
    assert path.with_suffix(".lrc").exists()
    assert FakeMediaFile.store[str(path)]["lyrics"] == "[00:00.00]\n[00:00.00]\n"
