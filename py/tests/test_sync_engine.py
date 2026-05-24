from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from liked_music_syncer.models import SyncConfig, SyncItemState
from liked_music_syncer.sync_engine import (
    _canonicalize_track_title,
    _build_yt_dlp_options,
    _build_ytmusic_client,
    _configure_yt_dlp_plugins,
    _dedupe_tracks,
    _discover_artist_catalog_tracks,
    _download_audio,
    _musicbrainz_enrich,
    _resolve_best_lyrics,
    run_sync,
    _resolve_exact_catalog,
    _resolve_lyrics,
    _skip_reason_for_existing_signature,
)


def _config(tmp_path: Path) -> SyncConfig:
    plugin_dir = tmp_path / "yt-dlp-plugins"
    plugin_dir.mkdir()
    return SyncConfig(
        run_id="run_123",
        output_directory=tmp_path / "out",
        dry_run=False,
        remote_copy_enabled=False,
        rclone_remote="",
        remote_music_root="",
        ytmusic_browser_auth="cookie: a=b",
        yt_dlp_cookies_browser="firefox",
        folder_template="{albumartist}/{album}",
        file_template="{track:02d} {title}",
        embed_unsynced_lyrics=True,
        write_lrc_sidecar=True,
        lyrics_api_base_url="",
        spotify_match_enabled=False,
        ffmpeg_path="ffmpeg",
        yt_dlp_plugin_dir=str(plugin_dir),
        yt_dlp_po_token_base_url="http://127.0.0.1:4416",
    )


def _item(
    *,
    source_video_id: str = "source123",
    title: str = "blackout",
    artist: str = "yeti let you notice",
) -> SyncItemState:
    return SyncItemState(
        id="item_123",
        source_video_id=source_video_id,
        title=title,
        artist=artist,
        album="_Singles",
        album_artist=artist,
        source_url=f"https://music.youtube.com/watch?v={source_video_id}",
        cover_art_url=None,
        stage="source_resolve",
    )


def _liked_track(video_id: str = "source123") -> dict[str, object]:
    return {
        "videoId": video_id,
        "title": "blackout",
        "artists": [{"name": "yeti let you notice"}],
        "thumbnails": [],
    }


def _run_sync_for_lyrics(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *,
    lyrics_text: str | None,
    embed_unsynced_lyrics: bool = True,
) -> tuple[dict[str, Any], list[tuple[str | None, str | None]]]:
    events: list[dict[str, Any]] = []
    tag_calls: list[tuple[str | None, str | None]] = []
    config = _config(tmp_path)
    config.embed_unsynced_lyrics = embed_unsynced_lyrics
    config.write_lrc_sidecar = False

    class FakeYTMusic:
        def get_liked_songs(self, limit: int = 5000) -> dict[str, object]:
            assert limit == 5000
            return {"tracks": [_liked_track()]}

    monkeypatch.setattr("liked_music_syncer.sync_engine.emit_event", events.append)
    monkeypatch.setattr(
        "liked_music_syncer.sync_engine._build_ytmusic_client",
        lambda *args, **kwargs: FakeYTMusic(),
    )
    monkeypatch.setattr(
        "liked_music_syncer.sync_engine._resolve_exact_catalog",
        lambda *args, **kwargs: "MPLYt_demo",
    )
    monkeypatch.setattr(
        "liked_music_syncer.sync_engine._resolve_lyrics",
        lambda *args, **kwargs: (lyrics_text, "Source: LyricFind"),
    )
    monkeypatch.setattr(
        "liked_music_syncer.sync_engine._musicbrainz_enrich",
        lambda item: None,
    )
    monkeypatch.setattr(
        "liked_music_syncer.sync_engine._download_audio",
        lambda *args, **kwargs: (tmp_path / "downloaded.m4a", {"acodec": "aac"}),
    )
    monkeypatch.setattr(
        "liked_music_syncer.sync_engine._normalize_audio",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        "liked_music_syncer.sync_engine._copy_remote",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        "liked_music_syncer.sync_engine.write_media_tags",
        lambda output_path, item, cover_bytes, embedded_lyrics: tag_calls.append(
            (item.language, embedded_lyrics)
        ),
    )

    run_sync(config)

    item_events = [event["item"] for event in events if event.get("type") == "item"]
    return item_events[-1], tag_calls


def test_build_yt_dlp_options_enables_mweb_and_bgutil(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(
        "liked_music_syncer.sync_engine._configure_yt_dlp_plugins",
        lambda config: None,
    )

    options = _build_yt_dlp_options(_config(tmp_path), skip_download=True)

    assert options["logtostderr"] is True
    assert options["noprogress"] is True
    assert options["skip_download"] is True
    assert options["remote_components"] == ["ejs:github"]
    assert options["cookiesfrombrowser"] == ("firefox",)
    assert options["extractor_args"]["youtube"]["player_client"] == ["mweb", "default"]
    assert options["extractor_args"]["youtubepot-bgutilhttp"]["base_url"] == [
        "http://127.0.0.1:4416"
    ]


def test_build_yt_dlp_options_uses_selected_cookie_browser(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(
        "liked_music_syncer.sync_engine._configure_yt_dlp_plugins",
        lambda config: None,
    )
    config = _config(tmp_path)
    config.yt_dlp_cookies_browser = "firefox"

    options = _build_yt_dlp_options(config, skip_download=True)

    assert options["cookiesfrombrowser"] == ("firefox",)


def test_configure_yt_dlp_plugins_rejects_missing_directory(tmp_path: Path) -> None:
    config = _config(tmp_path)
    config.yt_dlp_plugin_dir = str(tmp_path / "missing")

    with pytest.raises(FileNotFoundError, match="yt-dlp plugin directory not found"):
        _configure_yt_dlp_plugins(config)


def test_build_ytmusic_client_validates_browser_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    sentinel = object()

    monkeypatch.setattr(
        "liked_music_syncer.sync_engine.build_browser_auth_client",
        lambda browser_auth_input: sentinel,
    )

    client = _build_ytmusic_client("cookie: a=b")

    assert client is sentinel


def test_resolve_lyrics_falls_back_to_plain_lyrics() -> None:
    class FakeYTMusic:
        def __init__(self) -> None:
            self.calls: list[bool] = []

        def get_lyrics(self, browse_id: str, timestamps: bool = False) -> dict[str, object]:
            assert browse_id == "MPLYt_demo"
            self.calls.append(timestamps)
            if timestamps:
                raise RuntimeError("timed lyrics unavailable")
            return {
                "lyrics": "line one\nline two",
                "source": "Source: LyricFind",
                "hasTimestamps": False,
            }

    ytmusic = FakeYTMusic()

    lyrics, source = _resolve_lyrics(ytmusic, "MPLYt_demo")

    assert ytmusic.calls == [True, False]
    assert lyrics == "line one\nline two\n"
    assert source == "Source: LyricFind"


def test_run_sync_sets_language_from_plain_lyrics(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    final_item, tag_calls = _run_sync_for_lyrics(
        monkeypatch,
        tmp_path,
        lyrics_text="Hello from the other side\nI must have called a thousand times\n",
    )

    assert final_item["language"] == "en"
    assert final_item["lyrics_status"] == "plain"
    assert tag_calls == [
        (
            "en",
            "Hello from the other side\nI must have called a thousand times\n",
        )
    ]


def test_run_sync_keeps_language_none_without_lyrics(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    final_item, tag_calls = _run_sync_for_lyrics(
        monkeypatch,
        tmp_path,
        lyrics_text=None,
    )

    assert final_item["language"] is None
    assert final_item["lyrics_status"] == "missing"
    assert tag_calls == [(None, None)]


def test_run_sync_sets_language_for_unsynced_lyrics_even_when_embed_disabled(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    final_item, tag_calls = _run_sync_for_lyrics(
        monkeypatch,
        tmp_path,
        lyrics_text="Hello from the other side\nI must have called a thousand times\n",
        embed_unsynced_lyrics=False,
    )

    assert final_item["language"] == "en"
    assert final_item["lyrics_status"] == "plain"
    assert tag_calls == [("en", None)]


def test_dedupe_tracks_prefers_album_over_songs_duplicate() -> None:
    tracks = _dedupe_tracks(
        [
            {
                "videoId": "same",
                "title": "Song",
                "artists": [{"name": "Artist"}],
                "catalogSource": "songs",
            },
            {
                "videoId": "same",
                "title": "Song",
                "artists": [{"name": "Artist"}],
                "catalogSource": "album",
            },
        ]
    )

    assert len(tracks) == 1
    assert tracks[0]["catalogSource"] == "album"


def test_discover_artist_catalog_uses_albums_and_singles_only() -> None:
    class FakeYTMusic:
        def get_artist(self, channel_id: str) -> dict[str, object]:
            assert channel_id == "channel_1"
            return {
                "albums": {
                    "browseId": "albums",
                    "params": "album_params",
                    "results": [],
                },
                "singles": {
                    "browseId": "singles",
                    "params": "single_params",
                    "results": [],
                },
            }

        def get_artist_albums(
            self, browseId: str, params: str, limit: int | None = None
        ) -> list[dict[str, object]]:
            assert limit is None
            if browseId == "albums":
                assert params == "album_params"
                return [{"browseId": "album_1", "title": "Album One"}]
            if browseId == "singles":
                assert params == "single_params"
                return [{"browseId": "single_1", "title": "Single One"}]
            raise AssertionError(browseId)

        def get_album(self, browseId: str) -> dict[str, object]:
            if browseId == "album_1":
                return {
                    "title": "Album One",
                    "artists": [{"name": "Artist"}],
                    "tracks": [{"videoId": "album_track", "title": "Album Track"}],
                }
            if browseId == "single_1":
                return {
                    "title": "Single One",
                    "artists": [{"name": "Artist"}],
                    "tracks": [{"videoId": "single_track", "title": "Single Track"}],
                }
            raise AssertionError(browseId)

    tracks = _discover_artist_catalog_tracks(
        FakeYTMusic(),
        {
            "id": "artist_1",
            "channel_id": "channel_1",
            "name": "Artist",
            "normalized_name": "artist",
        },
    )

    assert [track["videoId"] for track in tracks] == [
        "album_track",
        "single_track",
    ]
    assert {track["sourceKind"] for track in tracks} == {"favorite_artist_catalog"}
    assert {track["sourceOrigin"] for track in tracks} == {"favorite_artist_release"}


def test_run_sync_favorite_catalog_items_use_favorite_source_kind(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    events: list[dict[str, Any]] = []
    config = _config(tmp_path)
    config.dry_run = True
    config.favorite_artist_catalogs = [
        {
            "id": "artist_1",
            "channel_id": "channel_1",
            "name": "Artist",
            "normalized_name": "artist",
        }
    ]

    class FakeYTMusic:
        pass

    monkeypatch.setattr("liked_music_syncer.sync_engine.emit_event", events.append)
    monkeypatch.setattr(
        "liked_music_syncer.sync_engine._build_ytmusic_client",
        lambda *args, **kwargs: FakeYTMusic(),
    )
    monkeypatch.setattr(
        "liked_music_syncer.sync_engine._discover_artist_catalog_tracks",
        lambda *args, **kwargs: [
            {
                "videoId": "catalog123",
                "title": "Catalog Song",
                "artists": [{"name": "Artist"}],
                "sourceKind": "favorite_artist_catalog",
            }
        ],
    )
    monkeypatch.setattr(
        "liked_music_syncer.sync_engine._resolve_exact_catalog",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        "liked_music_syncer.sync_engine._musicbrainz_enrich",
        lambda item: None,
    )
    monkeypatch.setattr(
        "liked_music_syncer.sync_engine._resolve_lyrics",
        lambda *args, **kwargs: (None, None),
    )

    run_sync(config)

    item_events = [event["item"] for event in events if event.get("type") == "item"]
    assert item_events[-1]["source_kind"] == "favorite_artist_catalog"
    completed = [event for event in events if event.get("event") == "completed"]
    assert completed[-1]["context"]["favorite_artist_catalog_counts"] == {
        "artist_1": 1
    }


def test_run_sync_favorite_catalog_items_skip_generic_resolution(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    config = _config(tmp_path)
    config.dry_run = True
    config.favorite_artist_catalogs = [
        {
            "id": "artist_1",
            "channel_id": "channel_1",
            "name": "Artist",
            "normalized_name": "artist",
        }
    ]

    class FakeYTMusic:
        def get_watch_playlist(self, videoId: str, limit: int = 1) -> dict[str, object]:
            assert videoId == "catalog123"
            assert limit == 1
            return {"lyrics": None}

    monkeypatch.setattr("liked_music_syncer.sync_engine.emit_event", lambda event: None)
    monkeypatch.setattr(
        "liked_music_syncer.sync_engine._build_ytmusic_client",
        lambda *args, **kwargs: FakeYTMusic(),
    )
    monkeypatch.setattr(
        "liked_music_syncer.sync_engine._discover_artist_catalog_tracks",
        lambda *args, **kwargs: [
            {
                "videoId": "catalog123",
                "title": "Catalog Song",
                "artists": [{"name": "Artist"}],
                "sourceKind": "favorite_artist_catalog",
                "sourceOrigin": "favorite_artist_release",
                "catalogReleaseBrowseId": "release123",
                "catalogReleaseTitle": "Release One",
                "catalogReleaseKind": "single",
                "trackNumber": 1,
                "trackTotal": 1,
            }
        ],
    )
    monkeypatch.setattr(
        "liked_music_syncer.sync_engine._resolve_exact_catalog",
        lambda *args, **kwargs: pytest.fail("generic resolution should be skipped"),
    )

    run_sync(config)


def test_skip_existing_prevents_duplicate_favorite_catalog_download(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    events: list[dict[str, Any]] = []
    config = _config(tmp_path)
    config.favorite_artist_catalogs = [
        {
            "id": "artist_1",
            "channel_id": "channel_1",
            "name": "Artist",
            "normalized_name": "artist",
        }
    ]
    config.existing_local_youtube_music_track_ids = ["catalog123"]

    monkeypatch.setattr("liked_music_syncer.sync_engine.emit_event", events.append)
    monkeypatch.setattr(
        "liked_music_syncer.sync_engine._build_ytmusic_client",
        lambda *args, **kwargs: object(),
    )
    monkeypatch.setattr(
        "liked_music_syncer.sync_engine._discover_artist_catalog_tracks",
        lambda *args, **kwargs: [
            {
                "videoId": "catalog123",
                "title": "Catalog Song",
                "artists": [{"name": "Artist"}],
                "sourceKind": "favorite_artist_catalog",
            }
        ],
    )
    monkeypatch.setattr(
        "liked_music_syncer.sync_engine._download_audio",
        lambda *args, **kwargs: pytest.fail("download should be skipped"),
    )

    run_sync(config)

    item_events = [event["item"] for event in events if event.get("type") == "item"]
    assert item_events[-1]["status"] == "skipped_existing"
    assert item_events[-1]["reason_code"] == "existing_library_identity"


def test_release_dedupe_skips_same_release_but_keeps_other_release() -> None:
    config = SyncConfig.from_payload(
        {
            "run_id": "run_1",
            "output_directory": "/tmp/out",
            "dry_run": True,
            "remote_copy_enabled": False,
            "rclone_remote": "",
            "remote_music_root": "",
            "ytmusic_browser_auth": "cookie: a=b",
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
            "existing_local_release_signatures": [
                {
                    "artist": "Artist",
                    "title": "Song",
                    "catalogReleaseBrowseId": "release123",
                    "trackNumber": 1,
                }
            ],
            "existing_local_track_signatures": [],
        }
    )
    item = _item(title="Song", artist="Artist")
    item.source_origin = "favorite_artist_release"
    item.catalog_release_browse_id = "release123"
    item.track_number = 1
    item.normalized_primary_artist = "artist"
    item.normalized_title = "song"

    assert _skip_reason_for_existing_signature(config, item) == (
        "existing_release",
        "Matching managed local release identity already scanned.",
    )

    item.catalog_release_browse_id = "release999"
    assert _skip_reason_for_existing_signature(config, item) is None


def test_resolve_exact_catalog_keeps_direct_album_match() -> None:
    class FakeYTMusic:
        def __init__(self) -> None:
            self.search_calls = 0

        def get_watch_playlist(self, videoId: str, limit: int = 1) -> dict[str, object]:
            assert videoId == "source123"
            assert limit == 1
            return {
                "tracks": [
                    {
                        "videoId": "source123",
                        "title": "blackout",
                        "artists": [{"name": "yeti let you notice", "id": "artist1"}],
                        "album": {"name": "blackout", "id": "album123"},
                        "videoType": "MUSIC_VIDEO_TYPE_ATV",
                        "length": "3:39",
                    }
                ],
                "lyrics": "MPLYt_direct",
            }

        def get_album(self, browseId: str) -> dict[str, object]:
            assert browseId == "album123"
            return {
                "title": "blackout",
                "artists": [{"name": "yeti let you notice"}],
                "year": "2021",
                "tracks": [{"videoId": "source123", "title": "blackout"}],
            }

        def search(self, *args: object, **kwargs: object) -> list[dict[str, object]]:
            self.search_calls += 1
            return []

    item = _item()

    lyrics_browse_id = _resolve_exact_catalog(FakeYTMusic(), item)

    assert lyrics_browse_id == "MPLYt_direct"
    assert item.resolution_method == "album_exact"
    assert item.album == "blackout"
    assert item.track_number == 1
    assert item.track_total == 1
    assert item.year == 2021
    assert item.date is None
    assert item.selected_source_url is None


def test_resolve_exact_catalog_promotes_omv_to_catalog_song() -> None:
    class FakeYTMusic:
        def get_watch_playlist(self, videoId: str, limit: int = 1) -> dict[str, object]:
            assert limit == 1
            if videoId == "source123":
                return {
                    "tracks": [
                        {
                            "videoId": "source123",
                            "title": "blackout",
                            "artists": [{"name": "yeti let you notice", "id": "artist1"}],
                            "videoType": "MUSIC_VIDEO_TYPE_OMV",
                            "length": "3:43",
                        }
                    ],
                    "lyrics": None,
                }
            if videoId == "catalog456":
                return {
                    "tracks": [
                        {
                            "videoId": "catalog456",
                            "title": "blackout",
                            "artists": [{"name": "yeti let you notice", "id": "artist1"}],
                            "album": {"name": "blackout", "id": "album123"},
                            "videoType": "MUSIC_VIDEO_TYPE_ATV",
                            "length": "3:39",
                        }
                    ],
                    "lyrics": "MPLYt_catalog",
                }
            raise AssertionError(videoId)

        def search(
            self,
            query: str,
            filter: str | None = None,
            limit: int = 20,
            ignore_spelling: bool = False,
        ) -> list[dict[str, object]]:
            assert query == "blackout yeti let you notice"
            assert filter == "songs"
            assert limit == 5
            assert ignore_spelling is False
            return [
                {
                    "videoId": "catalog456",
                    "title": "blackout",
                    "artists": [{"name": "yeti let you notice", "id": "artist1"}],
                    "album": {"name": "blackout", "id": "album123"},
                    "videoType": "MUSIC_VIDEO_TYPE_ATV",
                    "duration": "3:39",
                }
            ]

        def get_album(self, browseId: str) -> dict[str, object]:
            assert browseId == "album123"
            return {
                "title": "blackout",
                "artists": [{"name": "yeti let you notice"}],
                "year": "2021",
                "tracks": [{"videoId": "source123", "title": "blackout"}],
            }

    item = _item()

    lyrics_browse_id = _resolve_exact_catalog(FakeYTMusic(), item)

    assert lyrics_browse_id == "MPLYt_catalog"
    assert item.resolution_method == "search_song_exact"
    assert item.album == "blackout"
    assert item.track_number == 1
    assert item.track_total == 1
    assert item.year == 2021
    assert item.date is None
    assert item.video_type == "MUSIC_VIDEO_TYPE_ATV"
    assert item.selected_source_url == "https://music.youtube.com/watch?v=catalog456"


def test_resolve_exact_catalog_strips_omv_title_noise_and_matches_bilingual_song_title() -> None:
    class FakeYTMusic:
        def get_watch_playlist(self, videoId: str, limit: int = 1) -> dict[str, object]:
            assert limit == 1
            if videoId == "source123":
                return {
                    "tracks": [
                        {
                            "videoId": "source123",
                            "title": "Blurred City Lights - 月光 (Official Music Video)",
                            "artists": [{"name": "Blurred City Lights", "id": "artist1"}],
                            "videoType": "MUSIC_VIDEO_TYPE_OMV",
                            "length": "5:58",
                        }
                    ],
                    "lyrics": None,
                }
            if videoId == "catalog456":
                return {
                    "tracks": [
                        {
                            "videoId": "catalog456",
                            "title": "月光 - Gekkou",
                            "artists": [{"name": "Blurred City Lights", "id": "artist1"}],
                            "album": {"name": "Gekkou", "id": "album123"},
                            "videoType": "MUSIC_VIDEO_TYPE_ATV",
                            "length": "5:50",
                        }
                    ],
                    "lyrics": "MPLYt_catalog",
                }
            raise AssertionError(videoId)

        def search(
            self,
            query: str,
            filter: str | None = None,
            limit: int = 20,
            ignore_spelling: bool = False,
        ) -> list[dict[str, object]]:
            assert query == "月光 Blurred City Lights"
            assert filter == "songs"
            assert limit == 5
            assert ignore_spelling is False
            return [
                {
                    "videoId": "catalog456",
                    "title": "月光 - Gekkou",
                    "artists": [{"name": "Blurred City Lights", "id": "artist1"}],
                    "album": {"name": "Gekkou", "id": "album123"},
                    "videoType": "MUSIC_VIDEO_TYPE_ATV",
                    "duration": "5:50",
                }
            ]

        def get_album(self, browseId: str) -> dict[str, object]:
            assert browseId == "album123"
            return {
                "title": "Gekkou",
                "artists": [{"name": "Blurred City Lights"}],
                "year": "2024",
                "tracks": [{"videoId": "catalog456", "title": "月光 - Gekkou"}],
            }

    item = _item(title="Blurred City Lights - 月光 (Official Music Video)", artist="Blurred City Lights")

    lyrics_browse_id = _resolve_exact_catalog(FakeYTMusic(), item)

    assert lyrics_browse_id == "MPLYt_catalog"
    assert item.resolution_method == "search_song_exact"
    assert item.album == "Gekkou"
    assert item.track_number == 1
    assert item.track_total == 1
    assert item.title == "月光 - Gekkou"
    assert item.selected_source_url == "https://music.youtube.com/watch?v=catalog456"


def test_resolve_exact_catalog_allows_small_omv_intro_duration_gap() -> None:
    class FakeYTMusic:
        def get_watch_playlist(self, videoId: str, limit: int = 1) -> dict[str, object]:
            assert limit == 1
            if videoId == "source123":
                return {
                    "tracks": [
                        {
                            "videoId": "source123",
                            "title": "透明",
                            "artists": [{"name": "sokoninaru", "id": "artist1"}],
                            "videoType": "MUSIC_VIDEO_TYPE_OMV",
                            "length": "3:02",
                        }
                    ],
                    "lyrics": None,
                }
            if videoId == "catalog456":
                return {
                    "tracks": [
                        {
                            "videoId": "catalog456",
                            "title": "透明",
                            "artists": [{"name": "そこに鳴る", "id": "artist1"}],
                            "album": {"name": "透明", "id": "album123"},
                            "videoType": "MUSIC_VIDEO_TYPE_ATV",
                            "length": "2:51",
                        }
                    ],
                    "lyrics": "MPLYt_catalog",
                }
            raise AssertionError(videoId)

        def search(self, *args: object, **kwargs: object) -> list[dict[str, object]]:
            return [
                {
                    "videoId": "catalog456",
                    "title": "透明",
                    "artists": [{"name": "そこに鳴る", "id": "artist1"}],
                    "album": {"name": "透明", "id": "album123"},
                    "videoType": "MUSIC_VIDEO_TYPE_ATV",
                    "duration": "2:51",
                }
            ]

        def get_album(self, browseId: str) -> dict[str, object]:
            assert browseId == "album123"
            return {
                "title": "透明",
                "artists": [{"name": "そこに鳴る"}],
                "year": "2015",
                "tracks": [{"videoId": "catalog456", "title": "透明"}],
            }

    item = _item(title="透明", artist="sokoninaru")

    lyrics_browse_id = _resolve_exact_catalog(FakeYTMusic(), item)

    assert lyrics_browse_id == "MPLYt_catalog"
    assert item.resolution_method == "search_song_exact"
    assert item.album == "透明"
    assert item.track_number == 1
    assert item.track_total == 1
    assert item.selected_source_url == "https://music.youtube.com/watch?v=catalog456"


def test_resolve_exact_catalog_rejects_loose_duration_match() -> None:
    class FakeYTMusic:
        def get_watch_playlist(self, videoId: str, limit: int = 1) -> dict[str, object]:
            assert videoId == "source123"
            assert limit == 1
            return {
                "tracks": [
                    {
                        "videoId": "source123",
                        "title": "blackout",
                        "artists": [{"name": "yeti let you notice", "id": "artist1"}],
                        "videoType": "MUSIC_VIDEO_TYPE_OMV",
                        "length": "3:00",
                    }
                ],
                "lyrics": None,
            }

        def search(self, *args: object, **kwargs: object) -> list[dict[str, object]]:
            return [
                {
                    "videoId": "catalog456",
                    "title": "blackout",
                    "artists": [{"name": "yeti let you notice", "id": "artist1"}],
                    "album": {"name": "blackout", "id": "album123"},
                    "videoType": "MUSIC_VIDEO_TYPE_ATV",
                    "duration": "3:20",
                }
            ]

        def get_album(self, browseId: str) -> dict[str, object]:
            raise AssertionError(browseId)

    item = _item()

    lyrics_browse_id = _resolve_exact_catalog(FakeYTMusic(), item)

    assert lyrics_browse_id is None
    assert item.resolution_method == "watch_playlist"
    assert item.selected_source_url is None
    assert item.album == "_Singles"


def test_canonicalize_track_title_handles_unwrapped_mv_cases() -> None:
    assert _canonicalize_track_title("tricot『POOL』MV", ["tricot"]) == "POOL"
    assert _canonicalize_track_title('tricot "potage" MV', ["tricot"]) == "potage"
    assert _canonicalize_track_title("tricot『E』MV", ["tricot"]) == "E"


def test_download_audio_uses_selected_source_url(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    captured: dict[str, object] = {}

    monkeypatch.setattr(
        "liked_music_syncer.sync_engine._build_yt_dlp_options",
        lambda config, *, skip_download: {"skip_download": skip_download},
    )

    class FakeYoutubeDL:
        def __init__(self, options: dict[str, object]) -> None:
            captured["options"] = options

        def __enter__(self) -> "FakeYoutubeDL":
            return self

        def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
            return None

        def extract_info(self, url: str, download: bool = False) -> dict[str, object]:
            captured["url"] = url
            captured["download"] = download
            return {"id": "catalog456", "ext": "m4a", "acodec": "aac"}

        def prepare_filename(self, info: dict[str, object]) -> str:
            assert info["id"] == "catalog456"
            return str(tmp_path / "catalog456.m4a")

    monkeypatch.setattr("liked_music_syncer.sync_engine.YoutubeDL", FakeYoutubeDL)

    item = _item()
    item.selected_source_url = "https://music.youtube.com/watch?v=catalog456"

    prepared, info = _download_audio(_config(tmp_path), item, tmp_path)

    assert captured["url"] == "https://music.youtube.com/watch?v=catalog456"
    assert captured["download"] is True
    assert prepared == tmp_path / "catalog456.m4a"
    assert info["acodec"] == "aac"


def test_musicbrainz_enrich_keeps_exact_resolved_album(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return {
                "recordings": [
                    {
                        "id": "recording123",
                        "title": "evergreen",
                        "score": 100,
                        "releases": [
                            {
                                "id": "release123",
                                "title": "MusicBrainz Album",
                                "date": "2025-09-10",
                                "release-group": {"id": "group123"},
                            }
                        ],
                    }
                ]
            }

    monkeypatch.setattr(
        "liked_music_syncer.sync_engine.httpx.get",
        lambda *args, **kwargs: FakeResponse(),
    )

    item = _item(title="evergreen", artist="kurayamisaka")
    item.album = "YT Album"
    item.resolution_method = "album_exact"

    _musicbrainz_enrich(item)

    assert item.album == "YT Album"
    assert item.mb_track_id == "recording123"
    assert item.mb_album_id == "release123"
    assert item.mb_releasegroup_id == "group123"
    assert item.date == "2025-09-10"


def test_musicbrainz_enrich_fills_album_when_still_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return {
                "recordings": [
                    {
                        "id": "recording123",
                        "title": "evergreen",
                        "score": 100,
                        "releases": [
                            {
                                "id": "release123",
                                "title": "MusicBrainz Album",
                                "date": "2025-09-10",
                                "release-group": {"id": "group123"},
                            }
                        ],
                    }
                ]
            }

    monkeypatch.setattr(
        "liked_music_syncer.sync_engine.httpx.get",
        lambda *args, **kwargs: FakeResponse(),
    )

    item = _item(title="evergreen", artist="kurayamisaka")
    item.album = "_Singles"
    item.resolution_method = "watch_playlist"

    _musicbrainz_enrich(item)

    assert item.album == "MusicBrainz Album"
    assert item.mb_track_id == "recording123"
    assert item.mb_album_id == "release123"
    assert item.mb_releasegroup_id == "group123"
    assert item.date == "2025-09-10"


def test_musicbrainz_enrich_uses_title_variants_and_stable_release_selection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeResponse:
        def __init__(self, payload: dict[str, object]) -> None:
            self.payload = payload

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return self.payload

    def fake_get(url: str, *, params: dict[str, str], headers: dict[str, str], timeout: float) -> FakeResponse:
        assert url == "https://musicbrainz.org/ws/2/recording/"
        assert headers["User-Agent"] == "liked-music-syncer/0.1.0"
        assert timeout == 10.0

        query = params["query"]
        if query == 'recording:"ハイウェイ - highway" AND artist:"kurayamisaka"':
            return FakeResponse({"recordings": []})
        if query == 'recording:"ハイウェイ" AND artist:"kurayamisaka"':
            return FakeResponse(
                {
                    "recordings": [
                        {
                            "id": "single123",
                            "title": "ハイウェイ",
                            "score": 100,
                            "releases": [{"id": "single-release", "title": "ハイウェイ"}],
                        },
                        {
                            "id": "album123",
                            "title": "ハイウェイ",
                            "score": 100,
                            "isrcs": ["JPL542500741"],
                            "releases": [
                                {
                                    "id": "xw-release",
                                    "title": "kurayamisaka yori ai wo komete",
                                    "date": "2025-09-10",
                                    "country": "XW",
                                    "packaging": "None",
                                    "release-group": {"id": "group123"},
                                },
                                {
                                    "id": "jp-release",
                                    "title": "kurayamisaka yori ai wo komete",
                                    "date": "2025-09-10",
                                    "country": "JP",
                                    "packaging": "Jewel Case",
                                    "release-group": {"id": "group123"},
                                },
                            ],
                        },
                    ]
                }
            )
        raise AssertionError(query)

    monkeypatch.setattr("liked_music_syncer.sync_engine.httpx.get", fake_get)

    item = _item(title="ハイウェイ - highway", artist="kurayamisaka")
    item.album = "kurayamisaka yori ai wo komete"
    item.year = 2025
    item.resolution_method = "album_exact"

    _musicbrainz_enrich(item)

    assert item.album == "kurayamisaka yori ai wo komete"
    assert item.mb_track_id == "album123"
    assert item.mb_album_id == "jp-release"
    assert item.mb_releasegroup_id == "group123"
    assert item.date == "2025-09-10"
    assert item.isrc == "JPL542500741"


def test_resolve_best_lyrics_prefers_spotify_synced_over_yt_plain(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    config = _config(tmp_path)
    config.lyrics_api_base_url = "https://lyrics.example.test/api"
    config.spotify_match_enabled = True
    item = _item(title="Song", artist="Artist")

    monkeypatch.setattr(
        "liked_music_syncer.sync_engine._resolve_lyrics",
        lambda *args, **kwargs: ("plain line\n", "ytmusic"),
    )
    monkeypatch.setattr(
        "liked_music_syncer.sync_engine._spotify_match_track",
        lambda current_item: "spotify123",
    )
    monkeypatch.setattr(
        "liked_music_syncer.sync_engine._spotify_fetch_lyrics",
        lambda spotify_track_id, lyrics_api_base_url: ("[00:01.00]line\n", "synced"),
    )

    lyrics_text, lyrics_source = _resolve_best_lyrics(config, object(), item, "lyrics123")

    assert lyrics_text == "[00:01.00]line\n"
    assert lyrics_source == "spotify"
    assert item.spotify_track_id == "spotify123"
