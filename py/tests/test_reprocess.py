from __future__ import annotations

import subprocess
from pathlib import Path

import liked_music_syncer.reprocess as reprocess_module


def _config_payload(tmp_path: Path) -> dict[str, object]:
    return {
        "job_id": "job_1",
        "output_directory": str(tmp_path / "out"),
        "remote_copy_enabled": False,
        "rclone_remote": "",
        "remote_music_root": "",
        "ytmusic_browser_auth": "auth",
        "yt_dlp_cookies_browser": "firefox",
        "folder_template": "{albumartist}/{album}",
        "file_template": "{track:02d} {title}",
        "embed_unsynced_lyrics": True,
        "write_lrc_sidecar": True,
        "lyrics_api_base_url": "",
        "spotify_match_enabled": False,
        "ffmpeg_path": "ffmpeg",
        "yt_dlp_plugin_dir": "",
        "yt_dlp_po_token_base_url": "",
    }


def _apply_payload(tmp_path: Path, *, same_video: bool) -> dict[str, object]:
    current_output = tmp_path / "current" / "01 Song.m4a"
    current_output.parent.mkdir(parents=True, exist_ok=True)
    current_output.write_bytes(b"old-audio")

    return {
        **_config_payload(tmp_path),
        "payload": {
            "item": {
                "id": "track_1",
                "youtube_music_track_id": "liked123",
                "resolved_youtube_music_track_id": "resolved123"
                if same_video
                else "resolved999",
                "title": "Song",
                "artist": "Artist",
                "album": "Album",
                "album_artist": "Artist",
                "source_url": "https://music.youtube.com/watch?v=liked123",
                "lyrics_status": "missing",
            },
            "lyrics_text": None,
            "current_output_path": str(current_output),
            "current_lrc_path": None,
            "target_output_path": str(tmp_path / "out" / "Artist" / "Album" / "01 Song.m4a"),
            "target_lrc_path": None,
            "same_video": same_video,
        },
    }


def test_apply_reprocess_same_video_skips_download(tmp_path: Path, monkeypatch) -> None:
    payload = _apply_payload(tmp_path, same_video=True)
    calls = {"download": 0, "tag": 0}

    def fail_download(*args: object, **kwargs: object) -> None:
        calls["download"] += 1
        raise AssertionError("_download_audio should not run for same-video updates")

    monkeypatch.setattr(reprocess_module, "_download_audio", fail_download)
    monkeypatch.setattr(
        reprocess_module,
        "write_media_tags",
        lambda *args, **kwargs: calls.__setitem__("tag", calls["tag"] + 1),
    )
    monkeypatch.setattr(reprocess_module, "_sync_remote_artifacts", lambda *args: None)

    result = reprocess_module.apply_reprocess(payload)

    assert result["ok"] is True
    assert result["replaced"] is False
    assert calls["download"] == 0
    assert calls["tag"] == 1


def test_apply_reprocess_changed_video_downloads_audio(tmp_path: Path, monkeypatch) -> None:
    payload = _apply_payload(tmp_path, same_video=False)
    calls = {"download": 0}

    def fake_download(config: object, item: object, temp_dir: Path) -> tuple[Path, dict[str, str]]:
        calls["download"] += 1
        downloaded = temp_dir / "downloaded.m4a"
        downloaded.write_bytes(b"new-audio")
        return downloaded, {"acodec": "aac"}

    def fake_normalize(
        downloaded_path: Path, output_path: Path, ffmpeg_path: str, audio_codec: str | None
    ) -> None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(downloaded_path.read_bytes())

    monkeypatch.setattr(reprocess_module, "_download_audio", fake_download)
    monkeypatch.setattr(reprocess_module, "_normalize_audio", fake_normalize)
    monkeypatch.setattr(reprocess_module, "write_media_tags", lambda *args, **kwargs: None)
    monkeypatch.setattr(reprocess_module, "_sync_remote_artifacts", lambda *args: None)

    result = reprocess_module.apply_reprocess(payload)

    assert result["ok"] is True
    assert result["replaced"] is True
    assert calls["download"] == 1
    assert Path(result["output_path"]).exists()


def test_run_reprocess_stream_noop_emits_completed_without_writes(
    tmp_path: Path, monkeypatch
) -> None:
    events: list[dict[str, object]] = []
    calls = {"download": 0, "tag": 0}

    monkeypatch.setattr(reprocess_module, "_build_ytmusic_client", lambda auth: object())
    monkeypatch.setattr(
        reprocess_module,
        "_preview_one",
        lambda config, ytmusic, candidate, index: {
            "track_work_id": "track_1",
            "library_track_id": "library_track_1",
            "same_video": True,
            "action_kind": "noop",
            "diff": {},
            "before": {},
            "after": {},
            "album_art_diff": None,
            "payload": {
                "item": {
                    "id": "track_1",
                    "youtube_music_track_id": "liked123",
                    "resolved_youtube_music_track_id": "resolved123",
                    "title": "Song",
                    "artist": "Artist",
                    "album": "Album",
                    "album_artist": "Artist",
                    "source_url": "https://music.youtube.com/watch?v=liked123",
                    "lyrics_status": "missing",
                },
                "current_output_path": str(tmp_path / "existing.m4a"),
                "current_lrc_path": None,
                "target_output_path": str(tmp_path / "existing.m4a"),
                "target_lrc_path": None,
                "same_video": True,
            },
        },
    )
    monkeypatch.setattr(
        reprocess_module,
        "emit_event",
        lambda payload: events.append(payload),
    )
    monkeypatch.setattr(
        reprocess_module,
        "_download_audio",
        lambda *args, **kwargs: calls.__setitem__("download", calls["download"] + 1),
    )
    monkeypatch.setattr(
        reprocess_module,
        "write_media_tags",
        lambda *args, **kwargs: calls.__setitem__("tag", calls["tag"] + 1),
    )

    reprocess_module.run_reprocess_stream(
        {
            **_config_payload(tmp_path),
            "items": [
                {
                    "track_work_id": "track_1",
                    "youtube_music_track_id": "liked123",
                    "resolved_youtube_music_track_id": "resolved123",
                    "title": "Song",
                    "artist": "Artist",
                    "album": "Album",
                    "album_artist": "Artist",
                    "lyrics_status": "missing",
                }
            ],
        }
    )


def test_delete_remote_file_ignores_rclone_not_found(monkeypatch) -> None:
    def raise_not_found(*args: object, **kwargs: object) -> None:
        raise subprocess.CalledProcessError(4, ["rclone", "deletefile", "remote:path"])

    monkeypatch.setattr(reprocess_module.subprocess, "run", raise_not_found)

    reprocess_module._delete_remote_file("remote:path")


def test_delete_remote_file_rethrows_other_rclone_errors(monkeypatch) -> None:
    def raise_other(*args: object, **kwargs: object) -> None:
        raise subprocess.CalledProcessError(3, ["rclone", "deletefile", "remote:path"])

    monkeypatch.setattr(reprocess_module.subprocess, "run", raise_other)

    try:
        reprocess_module._delete_remote_file("remote:path")
    except subprocess.CalledProcessError as exc:
        assert exc.returncode == 3
    else:
        raise AssertionError("Expected non-4 rclone delete errors to be re-raised")

    track_events = [event for event in events if event["type"] == "track"]
    assert [event["event"] for event in events if event["type"] == "job"] == [
        "started",
        "completed",
    ]
    assert len(track_events) == 2
    final_item = track_events[-1]["item"]
    assert isinstance(final_item, dict)
    assert final_item["status"] == "completed"
    assert final_item["reason_code"] == "reprocess_no_changes"
    assert calls["download"] == 0
    assert calls["tag"] == 0
