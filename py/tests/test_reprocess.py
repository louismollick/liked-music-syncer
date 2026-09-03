from __future__ import annotations

import subprocess
import unicodedata
from pathlib import Path

import pytest

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


def test_apply_reprocess_preserves_unicode_equivalent_same_video_file(
    tmp_path: Path, monkeypatch
) -> None:
    decomposed_name = unicodedata.normalize("NFD", "01 急げ.m4a")
    composed_name = unicodedata.normalize("NFC", "01 急げ.m4a")
    current_output = tmp_path / decomposed_name
    target_output = tmp_path / composed_name
    current_output.write_bytes(b"old-audio")
    if not target_output.exists():
        pytest.skip("Filesystem does not treat NFC and NFD paths as the same entry")

    payload = _apply_payload(tmp_path, same_video=True)
    payload["payload"]["current_output_path"] = str(current_output)
    payload["payload"]["target_output_path"] = str(target_output)
    monkeypatch.setattr(reprocess_module, "write_media_tags", lambda *args: None)
    monkeypatch.setattr(reprocess_module, "_sync_remote_artifacts", lambda *args: None)

    result = reprocess_module.apply_reprocess(payload)

    assert result["ok"] is True
    assert target_output.read_bytes() == b"old-audio"


def test_apply_reprocess_preserves_unicode_equivalent_sidecar(
    tmp_path: Path, monkeypatch
) -> None:
    payload = _apply_payload(tmp_path, same_video=True)
    decomposed_name = unicodedata.normalize("NFD", "01 急げ.lrc")
    composed_name = unicodedata.normalize("NFC", "01 急げ.lrc")
    current_lrc = tmp_path / decomposed_name
    target_lrc = tmp_path / composed_name
    current_lrc.write_text("[00:01.00]old\n", encoding="utf-8")
    if not target_lrc.exists():
        pytest.skip("Filesystem does not treat NFC and NFD paths as the same entry")

    payload["payload"]["item"]["lyrics_status"] = "synced"
    payload["payload"]["lyrics_text"] = "[00:02.00]new\n"
    payload["payload"]["current_lrc_path"] = str(current_lrc)
    payload["payload"]["target_lrc_path"] = str(target_lrc)
    monkeypatch.setattr(reprocess_module, "write_media_tags", lambda *args: None)
    monkeypatch.setattr(reprocess_module, "_sync_remote_artifacts", lambda *args: None)

    result = reprocess_module.apply_reprocess(payload)

    assert result["lrc_path"] == str(target_lrc)
    assert target_lrc.read_text(encoding="utf-8") == "[00:02.00]new\n"


def test_apply_reprocess_changed_video_downloads_audio(tmp_path: Path, monkeypatch) -> None:
    payload = _apply_payload(tmp_path, same_video=False)
    payload["payload"]["item"]["selected_source_url"] = (
        "https://music.youtube.com/watch?v=resolved999"
    )
    calls: dict[str, object] = {"download": 0, "selected_source_url": None}

    def fake_download(config: object, item: object, temp_dir: Path) -> tuple[Path, dict[str, str]]:
        calls["download"] = int(calls["download"]) + 1
        calls["selected_source_url"] = getattr(item, "selected_source_url")
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
    assert calls["selected_source_url"] == (
        "https://music.youtube.com/watch?v=resolved999"
    )
    assert Path(result["output_path"]).exists()


def test_apply_reprocess_preserves_unicode_equivalent_replacement_file(
    tmp_path: Path, monkeypatch
) -> None:
    decomposed_name = unicodedata.normalize("NFD", "01 急げ.m4a")
    composed_name = unicodedata.normalize("NFC", "01 急げ.m4a")
    current_output = tmp_path / decomposed_name
    target_output = tmp_path / composed_name
    current_output.write_bytes(b"old-audio")
    if not target_output.exists():
        pytest.skip("Filesystem does not treat NFC and NFD paths as the same entry")

    payload = _apply_payload(tmp_path, same_video=False)
    payload["payload"]["current_output_path"] = str(current_output)
    payload["payload"]["target_output_path"] = str(target_output)

    def fake_download(
        config: object, item: object, temp_dir: Path
    ) -> tuple[Path, dict[str, str]]:
        downloaded = temp_dir / "downloaded.m4a"
        downloaded.write_bytes(b"new-audio")
        return downloaded, {"acodec": "aac"}

    def fake_normalize(
        downloaded_path: Path,
        output_path: Path,
        ffmpeg_path: str,
        audio_codec: str | None,
    ) -> None:
        output_path.write_bytes(downloaded_path.read_bytes())

    monkeypatch.setattr(reprocess_module, "_download_audio", fake_download)
    monkeypatch.setattr(reprocess_module, "_normalize_audio", fake_normalize)
    monkeypatch.setattr(reprocess_module, "write_media_tags", lambda *args: None)
    monkeypatch.setattr(reprocess_module, "_sync_remote_artifacts", lambda *args: None)

    result = reprocess_module.apply_reprocess(payload)

    assert result["ok"] is True
    assert target_output.read_bytes() == b"new-audio"


def test_preview_reprocess_sets_target_lrc_path_none_for_plain_lyrics(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(reprocess_module, "_build_ytmusic_client", lambda auth: object())
    monkeypatch.setattr(reprocess_module, "_resolve_exact_catalog", lambda *args, **kwargs: None)
    monkeypatch.setattr(reprocess_module, "_should_run_musicbrainz", lambda item: False)
    monkeypatch.setattr(
        reprocess_module,
        "_resolve_best_lyrics",
        lambda *args, **kwargs: ("plain one\nplain two\n", "spotify"),
    )

    result = reprocess_module.preview_reprocess(
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
                    "source_url": "https://music.youtube.com/watch?v=liked123",
                    "lyrics_status": "missing",
                }
            ],
        }
    )

    preview = result["items"][0]
    assert preview["after"]["lyricsStatus"] == "plain"
    assert preview["after"]["lrcPath"] is None
    assert preview["payload"]["target_lrc_path"] is None


def test_preview_reprocess_refreshes_favorite_track_from_its_stored_release(
    tmp_path: Path, monkeypatch
) -> None:
    class FakeYTMusic:
        def get_album(self, browse_id: str) -> dict[str, object]:
            assert browse_id == "MPREb_Npjg6HxNrZ3"
            return {
                "title": "T H E",
                "artists": [{"name": "tricot"}],
                "tracks": [
                    {
                        "videoId": f"other{index}",
                        "title": f"Track {index}",
                        "artists": [{"name": "tricot"}],
                    }
                    for index in range(1, 9)
                ]
                + [
                    {
                        "videoId": "1zez30Rj82g",
                        "title": "99.974℃",
                        "artists": [{"name": "tricot"}],
                    }
                ],
            }

    monkeypatch.setattr(
        reprocess_module, "_build_ytmusic_client", lambda auth: FakeYTMusic()
    )
    monkeypatch.setattr(
        reprocess_module,
        "_resolve_exact_catalog",
        lambda *args, **kwargs: pytest.fail("generic catalog resolution must not run"),
    )
    monkeypatch.setattr(reprocess_module, "_should_run_musicbrainz", lambda item: False)
    monkeypatch.setattr(
        reprocess_module,
        "_resolve_best_lyrics",
        lambda *args, **kwargs: (None, None),
    )

    result = reprocess_module.preview_reprocess(
        {
            **_config_payload(tmp_path),
            "items": [
                {
                    "track_work_id": "track_the_9",
                    "library_track_id": "library_the_9",
                    "youtube_music_track_id": "1zez30Rj82g",
                    "resolved_youtube_music_track_id": "1zez30Rj82g",
                    "source_origin": "favorite_artist_release",
                    "catalog_release_browse_id": "MPREb_Npjg6HxNrZ3",
                    "catalog_release_title": "T H E",
                    "catalog_release_kind": "album",
                    "title": "99.974℃",
                    "artist": "tricot",
                    "album": "T H E",
                    "album_artist": "tricot",
                    "disc_number": 1,
                    "track_number": 9,
                    "current_output_path": str(
                        tmp_path / "out" / "tricot" / "T H E" / "09 99.974℃.m4a"
                    ),
                    "lyrics_status": "missing",
                }
            ],
        }
    )

    after = result["items"][0]["after"]
    assert after["album"] == "T H E"
    assert after["trackNumber"] == 9
    assert after["catalogReleaseBrowseId"] == "MPREb_Npjg6HxNrZ3"


def test_preview_reprocess_stops_when_stored_release_no_longer_matches(
    tmp_path: Path, monkeypatch
) -> None:
    class MissingReleaseYTMusic:
        def get_album(self, browse_id: str) -> None:
            return None

    monkeypatch.setattr(
        reprocess_module,
        "_build_ytmusic_client",
        lambda auth: MissingReleaseYTMusic(),
    )

    with pytest.raises(ValueError, match="release not found"):
        reprocess_module.preview_reprocess(
            {
                **_config_payload(tmp_path),
                "items": [
                    {
                        "track_work_id": "track_the_9",
                        "youtube_music_track_id": "1zez30Rj82g",
                        "source_origin": "favorite_artist_release",
                        "catalog_release_browse_id": "missing-release",
                        "catalog_release_title": "T H E",
                        "catalog_release_kind": "album",
                        "title": "99.974℃",
                        "artist": "tricot",
                        "album": "T H E",
                        "album_artist": "tricot",
                        "disc_number": 1,
                        "track_number": 9,
                        "lyrics_status": "missing",
                    }
                ],
            }
        )


@pytest.mark.parametrize(
    ("candidate_overrides", "expected_diff_key"),
    [
        ({"artist_credits": []}, "artistCredits"),
        ({"tag_schema_version": 3}, "tagSchemaVersion"),
        (
            {
                "tag_schema_version": 5,
                "mb_album_id": "old-album-id",
                "mb_releasegroup_id": "old-release-group-id",
            },
            "mbAlbumId",
        ),
    ],
)
def test_preview_reprocess_updates_same_video_for_managed_tag_changes(
    tmp_path: Path,
    monkeypatch,
    candidate_overrides: dict[str, object],
    expected_diff_key: str,
) -> None:
    monkeypatch.setattr(reprocess_module, "_build_ytmusic_client", lambda auth: object())

    def resolve_exact_catalog(_ytmusic: object, item: object) -> None:
        item.artist_credits = [
            {"name": "Artist", "channel_id": "trusted-channel-id"}
        ]
        item.resolved_youtube_music_track_id = "resolved123"
        return None

    monkeypatch.setattr(reprocess_module, "_resolve_exact_catalog", resolve_exact_catalog)
    monkeypatch.setattr(reprocess_module, "_should_run_musicbrainz", lambda item: False)
    monkeypatch.setattr(
        reprocess_module,
        "_resolve_best_lyrics",
        lambda *args, **kwargs: (None, None),
    )

    current_output = tmp_path / "out" / "Artist" / "Album" / "01 Song.m4a"
    candidate = {
        "track_work_id": "track_1",
        "youtube_music_track_id": "liked123",
        "resolved_youtube_music_track_id": "resolved123",
        "artist_credits": [
            {"name": "Artist", "channel_id": "trusted-channel-id"}
        ],
        "tag_schema_version": 4,
        "title": "Song",
        "artist": "Artist",
        "album": "Album",
        "album_artist": "Artist",
        "source_url": "https://music.youtube.com/watch?v=liked123",
        "lyrics_status": "missing",
        "current_output_path": str(current_output),
        "current_lrc_path": None,
        "cover_art_present": False,
        **candidate_overrides,
    }

    result = reprocess_module.preview_reprocess(
        {**_config_payload(tmp_path), "items": [candidate]}
    )

    preview = result["items"][0]
    assert preview["same_video"] is True
    assert preview["action_kind"] == "update"
    assert expected_diff_key in preview["diff"]
    if expected_diff_key == "mbAlbumId":
        assert preview["diff"]["mbAlbumId"]["after"] is None
        assert preview["diff"]["mbReleaseGroupId"]["after"] is None


def test_apply_reprocess_same_video_plain_lyrics_deletes_old_lrc(
    tmp_path: Path, monkeypatch
) -> None:
    payload = _apply_payload(tmp_path, same_video=True)
    target_output = Path(str(payload["payload"]["target_output_path"]))
    target_output.parent.mkdir(parents=True, exist_ok=True)
    current_output = Path(str(payload["payload"]["current_output_path"]))
    current_output.write_bytes(b"old-audio")
    stale_lrc = current_output.with_suffix(".lrc")
    stale_lrc.write_text("[00:00.00]old\n", encoding="utf-8")
    payload["payload"]["item"]["lyrics_status"] = "plain"
    payload["payload"]["lyrics_text"] = "plain one\nplain two\n"
    payload["payload"]["current_lrc_path"] = str(stale_lrc)
    payload["payload"]["target_lrc_path"] = None

    embedded_lyrics: list[str | None] = []
    monkeypatch.setattr(reprocess_module, "_download_audio", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        reprocess_module,
        "write_media_tags",
        lambda _path, _item, _cover, lyrics: embedded_lyrics.append(lyrics),
    )
    monkeypatch.setattr(reprocess_module, "_sync_remote_artifacts", lambda *args: None)

    result = reprocess_module.apply_reprocess(payload)

    assert result["ok"] is True
    assert result["lrc_path"] is None
    assert embedded_lyrics == ["plain one\nplain two\n"]
    assert not stale_lrc.exists()


def test_apply_reprocess_same_video_synced_lyrics_preserves_lrc(
    tmp_path: Path, monkeypatch
) -> None:
    payload = _apply_payload(tmp_path, same_video=True)
    payload["payload"]["item"]["lyrics_status"] = "synced"
    payload["payload"]["lyrics_text"] = "[00:01.00]line one\n"
    target_lrc_path = Path(str(payload["payload"]["target_output_path"])).with_suffix(".lrc")
    payload["payload"]["target_lrc_path"] = str(target_lrc_path)

    monkeypatch.setattr(reprocess_module, "_download_audio", lambda *args, **kwargs: None)
    monkeypatch.setattr(reprocess_module, "write_media_tags", lambda *args, **kwargs: None)
    monkeypatch.setattr(reprocess_module, "_sync_remote_artifacts", lambda *args: None)

    result = reprocess_module.apply_reprocess(payload)

    assert result["ok"] is True
    assert result["lrc_path"] == str(target_lrc_path)
    assert target_lrc_path.read_text(encoding="utf-8") == "[00:01.00]line one\n"


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


def test_run_reprocess_stream_continues_after_one_preview_fails(
    tmp_path: Path, monkeypatch
) -> None:
    events: list[dict[str, object]] = []

    def candidate(track_id: str) -> dict[str, object]:
        return {
            "track_work_id": track_id,
            "youtube_music_track_id": track_id,
            "title": f"Song {track_id}",
            "artist": "Artist",
            "album": "Album",
            "album_artist": "Artist",
            "lyrics_status": "missing",
        }

    def preview_one(
        config: object,
        ytmusic: object,
        item: dict[str, object],
        index: int,
    ) -> dict[str, object]:
        if index == 1:
            raise RuntimeError("network unavailable after wake")
        track_id = str(item["track_work_id"])
        return {
            "action_kind": "noop",
            "diff": {},
            "payload": {
                "item": {
                    "id": track_id,
                    "youtube_music_track_id": track_id,
                    "title": f"Song {track_id}",
                    "artist": "Artist",
                    "album": "Album",
                    "album_artist": "Artist",
                    "source_url": f"https://music.youtube.com/watch?v={track_id}",
                    "lyrics_status": "missing",
                },
                "current_output_path": str(tmp_path / f"{track_id}.m4a"),
                "current_lrc_path": None,
                "target_output_path": str(tmp_path / f"{track_id}.m4a"),
                "target_lrc_path": None,
                "same_video": True,
            },
        }

    monkeypatch.setattr(reprocess_module, "_build_ytmusic_client", lambda auth: object())
    monkeypatch.setattr(reprocess_module, "_preview_one", preview_one)
    monkeypatch.setattr(reprocess_module, "emit_event", events.append)

    reprocess_module.run_reprocess_stream(
        {
            **_config_payload(tmp_path),
            "items": [candidate("track_2"), candidate("track_3")],
        }
    )

    track_events = [event for event in events if event["type"] == "track"]
    final_items = {
        str(event["item"]["id"]): event["item"]
        for event in track_events
        if isinstance(event.get("item"), dict)
        and event["item"].get("status") != "processing"
    }
    assert [event["event"] for event in events if event["type"] == "job"] == [
        "started",
        "completed",
    ]
    assert final_items["track_2"]["status"] == "failed_terminal"
    assert final_items["track_2"]["reason_code"] == "reprocess_preview_failed"
    assert final_items["track_3"]["status"] == "completed"


def test_apply_reprocess_same_video_missing_file_reports_context(
    tmp_path: Path,
) -> None:
    payload = _apply_payload(tmp_path, same_video=True)
    current_output = Path(str(payload["payload"]["current_output_path"]))
    current_output.unlink()

    try:
        reprocess_module.apply_reprocess(payload)
    except RuntimeError as exc:
        message = str(exc)
        assert "Current local file missing for same-video update." in message
        assert "Likely stale local path before apply." in message
        assert str(current_output) in message
    else:
        raise AssertionError("Expected missing current output to fail with context")


def test_copy_remote_file_wraps_rclone_failure_with_stdio(
    tmp_path: Path, monkeypatch
) -> None:
    local_path = tmp_path / "audio.m4a"
    local_path.write_bytes(b"audio")

    def raise_rclone(*args: object, **kwargs: object) -> None:
        raise subprocess.CalledProcessError(
            3,
            ["rclone", "copyto", str(local_path), "remote:path"],
            output=b"partial output",
            stderr=b"sftp failure",
        )

    monkeypatch.setattr(reprocess_module.subprocess, "run", raise_rclone)

    try:
        reprocess_module._copy_remote_file(
            reprocess_module._config_from_payload(_config_payload(tmp_path)),
            local_path,
            "remote:path",
        )
    except RuntimeError as exc:
        message = str(exc)
        assert "rclone copyto failed: returncode=3" in message
        assert "local_exists=True" in message
        assert "local_size=5" in message
        assert "stderr=sftp failure" in message
        assert "stdout=partial output" in message
    else:
        raise AssertionError("Expected wrapped rclone copy error")


def test_delete_remote_file_ignores_rclone_not_found(monkeypatch) -> None:
    def raise_not_found(*args: object, **kwargs: object) -> None:
        raise subprocess.CalledProcessError(4, ["rclone", "deletefile", "remote:path"])

    monkeypatch.setattr(reprocess_module.subprocess, "run", raise_not_found)

    reprocess_module._delete_remote_file("remote:path")


def test_delete_remote_file_rethrows_other_rclone_errors(monkeypatch) -> None:
    def raise_other(*args: object, **kwargs: object) -> None:
        raise subprocess.CalledProcessError(
            3,
            ["rclone", "deletefile", "remote:path"],
            stderr=b"permission denied",
        )

    monkeypatch.setattr(reprocess_module.subprocess, "run", raise_other)

    try:
        reprocess_module._delete_remote_file("remote:path")
    except RuntimeError as exc:
        message = str(exc)
        assert "rclone deletefile failed: returncode=3" in message
        assert "remote_path=remote:path" in message
        assert "stderr=permission denied" in message
    else:
        raise AssertionError("Expected non-4 rclone delete errors to be re-raised")
