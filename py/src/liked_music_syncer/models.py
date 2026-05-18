from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(slots=True)
class AuthStartResult:
    ok: bool
    message: str
    verification_url: str | None = None
    user_code: str | None = None
    device_code: str | None = None
    interval: int | None = None
    expires_in: int | None = None


@dataclass(slots=True)
class AuthFinishResult:
    ok: bool
    state: str
    message: str
    token_json: str | None = None


@dataclass(slots=True)
class AuthStatusResult:
    ok: bool
    is_authenticated: bool
    message: str
    credential_json: str | None = None


@dataclass(slots=True)
class SyncConfig:
    run_id: str
    output_directory: Path
    dry_run: bool
    remote_copy_enabled: bool
    rclone_remote: str
    remote_music_root: str
    ytmusic_auth_mode: str
    ytmusic_client_id: str
    ytmusic_client_secret: str
    ytmusic_oauth_token_json: str
    ytmusic_browser_auth: str
    folder_template: str
    file_template: str
    embed_unsynced_lyrics: bool
    write_lrc_sidecar: bool
    ffmpeg_path: str
    yt_dlp_plugin_dir: str
    yt_dlp_po_token_base_url: str

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "SyncConfig":
        return cls(
            run_id=str(payload["run_id"]),
            output_directory=Path(str(payload["output_directory"])).expanduser(),
            dry_run=bool(payload["dry_run"]),
            remote_copy_enabled=bool(payload["remote_copy_enabled"]),
            rclone_remote=str(payload.get("rclone_remote", "")),
            remote_music_root=str(payload.get("remote_music_root", "")),
            ytmusic_auth_mode=str(payload.get("ytmusic_auth_mode", "oauth_device")),
            ytmusic_client_id=str(payload["ytmusic_client_id"]),
            ytmusic_client_secret=str(payload["ytmusic_client_secret"]),
            ytmusic_oauth_token_json=str(payload["ytmusic_oauth_token_json"]),
            ytmusic_browser_auth=str(payload.get("ytmusic_browser_auth", "")),
            folder_template=str(payload["folder_template"]),
            file_template=str(payload["file_template"]),
            embed_unsynced_lyrics=bool(payload["embed_unsynced_lyrics"]),
            write_lrc_sidecar=bool(payload["write_lrc_sidecar"]),
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
    status: str = "pending"
    stage: str = "idle"
    reason_code: str = ""
    reason_detail: str = ""
    source_kind: str = "liked_song"
    video_type: str | None = None
    resolution_method: str = "unresolved"
    track_number: int | None = None
    track_total: int | None = None
    year: int | None = None
    date: str | None = None
    audio_codec: str | None = None
    metadata_matched: bool = False
    musicbrainz_matched: bool = False
    lyrics_matched: bool = False
    lyrics_source: str | None = None
    selected_source_url: str | None = None
    output_path: str | None = None
    lrc_path: str | None = None

    def as_event_payload(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "source_video_id": self.source_video_id,
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
            "year": self.year,
            "date": self.date,
            "audio_codec": self.audio_codec,
            "metadata_matched": self.metadata_matched,
            "musicbrainz_matched": self.musicbrainz_matched,
            "lyrics_matched": self.lyrics_matched,
            "lyrics_source": self.lyrics_source,
            "selected_source_url": self.selected_source_url,
            "output_path": self.output_path,
            "lrc_path": self.lrc_path,
        }
