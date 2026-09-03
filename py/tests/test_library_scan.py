from __future__ import annotations

import io
import subprocess
from pathlib import Path

from PIL import Image
from mediafile import MediaFile

from liked_music_syncer.library_scan import scan_root
from liked_music_syncer.media_tags import register_lms_mediafile_fields, write_media_tags
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


def _item(source_id: str = "source123") -> SyncItemState:
    return SyncItemState(
        id="item_123",
        source_video_id=source_id,
        title="Track Title",
        artist="Artist Name",
        album="Album Name",
        album_artist="Album Artist",
        source_url=f"https://music.youtube.com/watch?v={source_id}",
        cover_art_url=None,
        artist_credits=[
            {"name": "Artist Name", "channel_id": "UC_ARTIST"},
            {"name": "Guest Artist", "channel_id": "UC_GUEST"},
        ],
    )


def test_m4a_standard_and_custom_tag_round_trip(tmp_path: Path) -> None:
    audio_path = tmp_path / "Artist Name" / "Album Name" / "Track Title.m4a"
    _make_m4a(audio_path)

    item = _item("liked123")
    item.resolved_youtube_music_track_id = "catalog456"
    item.track_number = 2
    item.track_total = 10
    item.disc_number = 1
    item.disc_total = 2
    item.year = 2024
    item.date = "2024-03-01"
    item.genre = "rock"
    item.language = "en"
    item.isrc = "USABC1234567"
    item.mb_track_id = "mb-track"
    item.mb_album_id = "mb-album"
    item.mb_releasegroup_id = "mb-release-group"
    item.resolution_method = "search_song_exact"

    write_media_tags(audio_path, item, _cover_bytes(), "[00:01.00]line one\n")
    scan = scan_root({"transport": "filesystem", "kind": "local", "uri": str(tmp_path)})
    file_data = scan["files"][0]

    assert file_data["title"] == "Track Title"
    assert file_data["artist"] == "Artist Name"
    assert file_data["album"] == "Album Name"
    assert file_data["album_artist"] == "Album Artist"
    assert file_data["track_number"] == 2
    assert file_data["track_total"] == 10
    assert file_data["disc_number"] == 1
    assert file_data["disc_total"] == 2
    assert file_data["year"] == 2024
    assert file_data["date"] == "2024-03-01"
    assert file_data["genre"] == "rock"
    assert file_data["language"] == "en"
    assert file_data["isrc"] == "USABC1234567"
    assert file_data["mb_track_id"] == "mb-track"
    assert file_data["mb_album_id"] is None
    assert file_data["mb_releasegroup_id"] is None
    assert file_data["youtube_music_track_id"] == "liked123"
    assert file_data["resolved_youtube_music_track_id"] == "catalog456"
    assert file_data["tag_schema_version"] == 5
    assert file_data["artist_credits"] == [
        {"name": "Artist Name", "channel_id": "UC_ARTIST"},
        {"name": "Guest Artist", "channel_id": "UC_GUEST"},
    ]
    assert file_data["resolution_method"] == "search_song_exact"
    assert file_data["lyrics_status"] == "synced"
    assert file_data["cover_art_present"] is True


def test_scan_keeps_same_recording_on_two_releases_as_two_tracks(
    tmp_path: Path,
) -> None:
    album_path = tmp_path / "tricot" / "T H E" / "09 99.974℃.m4a"
    single_path = tmp_path / "tricot" / "99.974" / "01 99.974℃.m4a"
    _make_m4a(album_path)
    _make_m4a(single_path)

    album_item = _item("1zez30Rj82g")
    album_item.catalog_release_browse_id = "MPREb_Npjg6HxNrZ3"
    album_item.catalog_release_title = "T H E"
    album_item.catalog_release_kind = "album"
    album_item.album = "T H E"
    album_item.disc_number = 1
    album_item.track_number = 9
    write_media_tags(album_path, album_item, None, None)

    single_item = _item("1zez30Rj82g")
    single_item.catalog_release_browse_id = "MPREb_dia2KRjntFT"
    single_item.catalog_release_title = "99.974"
    single_item.catalog_release_kind = "single"
    single_item.album = "99.974"
    single_item.disc_number = 1
    single_item.track_number = 1
    write_media_tags(single_path, single_item, None, None)

    scan = scan_root({"transport": "filesystem", "kind": "local", "uri": str(tmp_path)})
    files = {entry["relative_path"]: entry for entry in scan["files"]}

    assert files["tricot/T H E/09 99.974℃.m4a"]["identity_kind"] == "ytm_release_track"
    assert files["tricot/T H E/09 99.974℃.m4a"]["identity_value"] == (
        "MPREb_Npjg6HxNrZ3:1:9"
    )
    assert files["tricot/99.974/01 99.974℃.m4a"]["identity_kind"] == (
        "ytm_release_track"
    )
    assert files["tricot/99.974/01 99.974℃.m4a"]["identity_value"] == (
        "MPREb_dia2KRjntFT:1:1"
    )


def test_comments_migration_parses_legacy_source_url(tmp_path: Path) -> None:
    register_lms_mediafile_fields()
    audio_path = tmp_path / "legacy.m4a"
    _make_m4a(audio_path)

    from mediafile import MediaFile

    legacy_media = MediaFile(str(audio_path))
    legacy_media.comments = "https://music.youtube.com/watch?v=legacy123"
    legacy_media.save()

    item = _item("new-liked-id")
    item.youtube_music_track_id = ""
    item.resolved_youtube_music_track_id = "catalog456"
    write_media_tags(audio_path, item, None, None)

    migrated = MediaFile(str(audio_path))
    assert migrated.lms_youtube_music_track_id == "legacy123"
    assert migrated.lms_resolved_youtube_music_track_id == "catalog456"
    assert migrated.comments in (None, "")


def test_write_media_tags_removes_existing_album_musicbrainz_ids(
    tmp_path: Path,
) -> None:
    register_lms_mediafile_fields()
    audio_path = tmp_path / "previously-tagged.m4a"
    _make_m4a(audio_path)

    previous = MediaFile(str(audio_path))
    previous.mb_albumid = "old-album-id"
    previous.mb_releasegroupid = "old-release-group-id"
    previous.save()

    item = _item()
    item.mb_track_id = "recording-id"
    item.mb_album_id = "old-album-id"
    item.mb_releasegroup_id = "old-release-group-id"
    write_media_tags(audio_path, item, None, None)

    rewritten = MediaFile(str(audio_path))
    assert rewritten.mb_trackid == "recording-id"
    assert rewritten.mb_albumid in (None, "")
    assert rewritten.mb_releasegroupid in (None, "")
    assert "----:com.apple.iTunes:MusicBrainz Album Id" not in rewritten.mgfile
    assert "----:com.apple.iTunes:MusicBrainz Release Group Id" not in rewritten.mgfile


def test_comment_changes_do_not_change_managed_metadata_fingerprint(tmp_path: Path) -> None:
    register_lms_mediafile_fields()
    audio_path = tmp_path / "song.m4a"
    _make_m4a(audio_path)
    write_media_tags(audio_path, _item(), _cover_bytes(), "lyrics")

    before = scan_root({"transport": "filesystem", "kind": "local", "uri": str(tmp_path)})["files"][0]
    media = MediaFile(str(audio_path))
    media.comments = "player-owned note"
    media.save()
    after = scan_root({"transport": "filesystem", "kind": "local", "uri": str(tmp_path)})["files"][0]

    assert after["tag_fingerprint"] == before["tag_fingerprint"]


def test_sidecar_content_has_an_independent_fingerprint(tmp_path: Path) -> None:
    audio_path = tmp_path / "song.m4a"
    _make_m4a(audio_path)
    write_media_tags(audio_path, _item(), None, None)
    sidecar = audio_path.with_suffix(".lrc")
    sidecar.write_text("first", encoding="utf-8")
    before = scan_root({"transport": "filesystem", "kind": "local", "uri": str(tmp_path)})["files"][0]
    sidecar.write_text("second", encoding="utf-8")
    after = scan_root({"transport": "filesystem", "kind": "local", "uri": str(tmp_path)})["files"][0]

    assert after["tag_fingerprint"] == before["tag_fingerprint"]
    assert after["sidecar_sha256"] != before["sidecar_sha256"]


def test_scan_root_reports_synced_plain_and_missing_lyrics(tmp_path: Path) -> None:
    synced_path = tmp_path / "synced.m4a"
    plain_path = tmp_path / "plain.m4a"
    missing_path = tmp_path / "missing.m4a"
    _make_m4a(synced_path)
    _make_m4a(plain_path)
    _make_m4a(missing_path)

    write_media_tags(synced_path, _item("sync1"), None, "[00:01.00]line\n")
    write_media_tags(plain_path, _item("plain1"), None, "line\n")
    write_media_tags(missing_path, _item("missing1"), None, None)

    scan = scan_root({"transport": "filesystem", "kind": "local", "uri": str(tmp_path)})
    files = {entry["relative_path"]: entry for entry in scan["files"]}

    assert files["synced.m4a"]["lyrics_status"] == "synced"
    assert files["plain.m4a"]["lyrics_status"] == "plain"
    assert files["missing.m4a"]["lyrics_status"] == "missing"
    assert "lyrics" in files["missing.m4a"]["missing_fields"]


def test_scan_root_only_requires_language_when_lyrics_exist(tmp_path: Path) -> None:
    plain_path = tmp_path / "plain.m4a"
    missing_path = tmp_path / "missing.m4a"
    _make_m4a(plain_path)
    _make_m4a(missing_path)

    write_media_tags(plain_path, _item("plain1"), None, "Hello from the other side\n")
    write_media_tags(missing_path, _item("missing1"), None, None)

    scan = scan_root({"transport": "filesystem", "kind": "local", "uri": str(tmp_path)})
    files = {entry["relative_path"]: entry for entry in scan["files"]}

    assert "language" in files["plain.m4a"]["missing_fields"]
    assert "language" not in files["missing.m4a"]["missing_fields"]


def test_write_media_tags_accepts_year_only_date_value(tmp_path: Path) -> None:
    audio_path = tmp_path / "year-only.m4a"
    _make_m4a(audio_path)

    item = _item("liked123")
    item.year = 2021
    item.date = "2021"

    write_media_tags(audio_path, item, None, None)
    scan = scan_root({"transport": "filesystem", "kind": "local", "uri": str(tmp_path)})
    file_data = scan["files"][0]

    assert file_data["year"] == 2021
    assert file_data["date"] == "2021"


def test_release_date_precision_changes_managed_fingerprint(tmp_path: Path) -> None:
    year_path = tmp_path / "year.m4a"
    exact_path = tmp_path / "exact.m4a"
    _make_m4a(year_path)
    _make_m4a(exact_path)

    year_item = _item("year123")
    year_item.year = 2021
    year_item.date = "2021"
    exact_item = _item("year123")
    exact_item.year = 2021
    exact_item.date = "2021-01-01"
    write_media_tags(year_path, year_item, None, None)
    write_media_tags(exact_path, exact_item, None, None)

    files = {
        entry["relative_path"]: entry
        for entry in scan_root(
            {"transport": "filesystem", "kind": "local", "uri": str(tmp_path)}
        )["files"]
    }
    assert files["year.m4a"]["date"] == "2021"
    assert files["exact.m4a"]["date"] == "2021-01-01"
    assert files["year.m4a"]["tag_fingerprint"] != files["exact.m4a"]["tag_fingerprint"]


def test_write_media_tags_preserves_year_month_precision(tmp_path: Path) -> None:
    audio_path = tmp_path / "year-month.m4a"
    _make_m4a(audio_path)
    item = _item("month123")
    item.year = 2021
    item.date = "2021-07"

    write_media_tags(audio_path, item, None, None)

    file_data = scan_root(
        {"transport": "filesystem", "kind": "local", "uri": str(tmp_path)}
    )["files"][0]
    assert file_data["date"] == "2021-07"
