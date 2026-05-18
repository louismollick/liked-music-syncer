from __future__ import annotations

from pathlib import Path

import pytest

from liked_music_syncer.models import SyncConfig
from liked_music_syncer.sync_engine import (
    _build_yt_dlp_options,
    _build_ytmusic_client,
    _configure_yt_dlp_plugins,
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
        ytmusic_auth_mode="oauth_device",
        ytmusic_client_id="client-id",
        ytmusic_client_secret="client-secret",
        ytmusic_oauth_token_json="{}",
        ytmusic_browser_auth="",
        folder_template="{albumartist}/{album}",
        file_template="{track:02d} {title}",
        embed_unsynced_lyrics=True,
        write_lrc_sidecar=True,
        ffmpeg_path="ffmpeg",
        yt_dlp_plugin_dir=str(plugin_dir),
        yt_dlp_po_token_base_url="http://127.0.0.1:4416",
    )


def test_build_yt_dlp_options_enables_mweb_and_bgutil(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(
        "liked_music_syncer.sync_engine._configure_yt_dlp_plugins",
        lambda config: None,
    )

    options = _build_yt_dlp_options(_config(tmp_path), skip_download=True)

    assert options["skip_download"] is True
    assert options["extractor_args"]["youtube"]["player_client"] == ["mweb", "default"]
    assert options["extractor_args"]["youtubepot-bgutilhttp"]["base_url"] == [
        "http://127.0.0.1:4416"
    ]


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

    client = _build_ytmusic_client(
        "browser_headers",
        "client-id",
        "client-secret",
        "{}",
        "cookie: a=b",
    )

    assert client is sentinel
