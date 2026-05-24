from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(slots=True)
class AuthStatusResult:
    ok: bool
    is_authenticated: bool
    message: str
    credential_json: str | None = None


@dataclass(slots=True)
class SyncConfig:
    job_id: str
    output_directory: Path
    remote_copy_enabled: bool
    rclone_remote: str
    remote_music_root: str
    ytmusic_browser_auth: str
    yt_dlp_cookies_browser: str
    folder_template: str
    file_template: str
    embed_unsynced_lyrics: bool
    write_lrc_sidecar: bool
    lyrics_api_base_url: str
    spotify_match_enabled: bool
    ffmpeg_path: str
    yt_dlp_plugin_dir: str
    yt_dlp_po_token_base_url: str
    artist_filter_channel_ids: list[str] = field(default_factory=list)
    artist_filter_names_normalized: list[str] = field(default_factory=list)
    favorite_artist_catalogs: list[dict[str, str | None]] = field(default_factory=list)
    force_reprocess: bool = False
    existing_local_youtube_music_track_ids: list[str] = field(default_factory=list)
    existing_local_resolved_youtube_music_track_ids: list[str] = field(
        default_factory=list
    )
    existing_local_track_signatures: list[dict[str, Any]] = field(default_factory=list)
    existing_local_release_signatures: list[dict[str, Any]] = field(default_factory=list)

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "SyncConfig":
        return cls(
            job_id=str(payload["job_id"]),
            output_directory=Path(str(payload["output_directory"])).expanduser(),
            remote_copy_enabled=bool(payload["remote_copy_enabled"]),
            rclone_remote=str(payload.get("rclone_remote", "")),
            remote_music_root=str(payload.get("remote_music_root", "")),
            ytmusic_browser_auth=str(payload.get("ytmusic_browser_auth", "")),
            yt_dlp_cookies_browser=str(payload.get("yt_dlp_cookies_browser", "firefox")),
            folder_template=str(payload["folder_template"]),
            file_template=str(payload["file_template"]),
            embed_unsynced_lyrics=bool(payload["embed_unsynced_lyrics"]),
            write_lrc_sidecar=bool(payload["write_lrc_sidecar"]),
            lyrics_api_base_url=str(payload.get("lyrics_api_base_url", "")),
            spotify_match_enabled=bool(payload.get("spotify_match_enabled", False)),
            artist_filter_channel_ids=[
                str(value)
                for value in payload.get("artist_filter_channel_ids", [])
                if isinstance(value, str) and value
            ],
            artist_filter_names_normalized=[
                str(value).strip().lower()
                for value in payload.get("artist_filter_names_normalized", [])
                if isinstance(value, str) and value.strip()
            ],
            favorite_artist_catalogs=[
                {
                    "id": str(value.get("id", "")),
                    "channel_id": str(value["channel_id"])
                    if isinstance(value.get("channel_id"), str)
                    else None,
                    "name": str(value.get("name", "")),
                    "normalized_name": str(value.get("normalized_name", "")),
                }
                for value in payload.get("favorite_artist_catalogs", [])
                if isinstance(value, dict) and str(value.get("id", "")).strip()
            ],
            force_reprocess=bool(payload.get("force_reprocess", False)),
            existing_local_youtube_music_track_ids=[
                str(value)
                for value in payload.get("existing_local_youtube_music_track_ids", [])
                if isinstance(value, str) and value
            ],
            existing_local_resolved_youtube_music_track_ids=[
                str(value)
                for value in payload.get("existing_local_resolved_youtube_music_track_ids", [])
                if isinstance(value, str) and value
            ],
            existing_local_track_signatures=[
                value
                for value in payload.get("existing_local_track_signatures", [])
                if isinstance(value, dict)
            ],
            existing_local_release_signatures=[
                value
                for value in payload.get("existing_local_release_signatures", [])
                if isinstance(value, dict)
            ],
            ffmpeg_path=str(payload["ffmpeg_path"]),
            yt_dlp_plugin_dir=str(payload.get("yt_dlp_plugin_dir", "")),
            yt_dlp_po_token_base_url=str(payload.get("yt_dlp_po_token_base_url", "")),
        )


@dataclass(slots=True)
class SyncItemState:
    id: str
    source_video_id: str
    title: str
    artist: str
    album: str
    album_artist: str
    source_url: str
    cover_art_url: str | None
    youtube_music_track_id: str = ""
    spotify_track_id: str | None = None
    soundcloud_track_id: str | None = None
    resolved_youtube_music_track_id: str | None = None
    source_origin: str | None = None
    catalog_release_browse_id: str | None = None
    catalog_release_title: str | None = None
    catalog_release_kind: str | None = None
    normalized_primary_artist: str | None = None
    normalized_title: str | None = None
    status: str = "pending"
    stage: str = "idle"
    reason_code: str = ""
    reason_detail: str = ""
    source_kind: str = "liked_song"
    video_type: str | None = None
    resolution_method: str = "unresolved"
    track_number: int | None = None
    track_total: int | None = None
    disc_number: int | None = None
    disc_total: int | None = None
    year: int | None = None
    date: str | None = None
    genre: str | None = None
    language: str | None = None
    isrc: str | None = None
    mb_track_id: str | None = None
    mb_album_id: str | None = None
    mb_releasegroup_id: str | None = None
    lyrics_status: str = "missing"
    audio_codec: str | None = None
    metadata_matched: bool = False
    musicbrainz_matched: bool = False
    lyrics_matched: bool = False
    lyrics_source: str | None = None
    selected_source_url: str | None = None
    output_path: str | None = None
    lrc_path: str | None = None

    def __post_init__(self) -> None:
        if not self.youtube_music_track_id:
            self.youtube_music_track_id = self.source_video_id
        if not self.resolved_youtube_music_track_id:
            self.resolved_youtube_music_track_id = self.youtube_music_track_id

    def as_event_payload(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "youtube_music_track_id": self.youtube_music_track_id,
            "spotify_track_id": self.spotify_track_id,
            "soundcloud_track_id": self.soundcloud_track_id,
            "resolved_youtube_music_track_id": self.resolved_youtube_music_track_id,
            "source_origin": self.source_origin,
            "catalog_release_browse_id": self.catalog_release_browse_id,
            "catalog_release_title": self.catalog_release_title,
            "catalog_release_kind": self.catalog_release_kind,
            "title": self.title,
            "artist": self.artist,
            "album": self.album,
            "album_artist": self.album_artist,
            "source_url": self.source_url,
            "cover_art_url": self.cover_art_url,
            "status": self.status,
            "stage": self.stage,
            "reason_code": self.reason_code,
            "reason_detail": self.reason_detail,
            "source_kind": self.source_kind,
            "video_type": self.video_type,
            "resolution_method": self.resolution_method,
            "track_number": self.track_number,
            "track_total": self.track_total,
            "disc_number": self.disc_number,
            "disc_total": self.disc_total,
            "year": self.year,
            "date": self.date,
            "genre": self.genre,
            "language": self.language,
            "isrc": self.isrc,
            "mb_track_id": self.mb_track_id,
            "mb_album_id": self.mb_album_id,
            "mb_releasegroup_id": self.mb_releasegroup_id,
            "lyrics_status": self.lyrics_status,
            "audio_codec": self.audio_codec,
            "metadata_matched": self.metadata_matched,
            "musicbrainz_matched": self.musicbrainz_matched,
            "lyrics_matched": self.lyrics_matched,
            "lyrics_source": self.lyrics_source,
            "selected_source_url": self.selected_source_url,
            "output_path": self.output_path,
            "lrc_path": self.lrc_path,
        }
