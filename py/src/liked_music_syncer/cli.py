from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path
from typing import Any

from .auth import (
    check_browser_auth_status,
    capture_browser_auth_from_browser,
)
from .json_io import read_stdin_json, write_json
from .liked_artists import fetch_artist_images, fetch_liked_artists
from .library_scan import inspect_local_files, reconcile_local_root, scan_root
from .models import SyncConfig
from .sync_engine import run_sync


def _doctor(payload: dict[str, Any]) -> dict[str, Any]:
    output_directory = Path(str(payload.get("output_directory", ""))).expanduser()
    ffmpeg_path = str(payload.get("ffmpeg_path", "ffmpeg"))
    remote_copy_enabled = bool(payload.get("remote_copy_enabled", False))
    rclone_remote = str(payload.get("rclone_remote", ""))
    remote_music_root = str(payload.get("remote_music_root", ""))

    details = {
        "output_directory_exists": output_directory.exists() if output_directory else False,
        "ffmpeg": shutil.which(ffmpeg_path) or ffmpeg_path,
        "has_browser_auth": bool(payload.get("has_browser_auth")),
        "remote_copy_enabled": remote_copy_enabled,
        "remote_target": f"{rclone_remote}:{remote_music_root}" if remote_copy_enabled else "",
        "yt_dlp_plugin_dir": str(payload.get("yt_dlp_plugin_dir", "")),
        "yt_dlp_po_token_base_url": str(payload.get("yt_dlp_po_token_base_url", "")),
        "yt_dlp_plugin_zip_exists": bool(payload.get("yt_dlp_plugin_zip_exists", False)),
        "yt_dlp_provider_entry_exists": bool(payload.get("yt_dlp_provider_entry_exists", False)),
    }
    ok = bool(details["ffmpeg"])
    return {
        "ok": ok,
        "message": "Worker doctor complete." if ok else "Worker doctor found missing tooling.",
        "details": json.dumps(details, ensure_ascii=False),
    }


def main() -> int:
    if len(sys.argv) < 2:
        raise SystemExit("expected command")

    command = sys.argv[1]
    payload = read_stdin_json()

    if command == "auth-status":
        write_json(
            check_browser_auth_status(
                browser_auth_input=str(payload.get("browser_auth_input", "")),
            )
        )
        return 0

    if command == "auth-capture-browser":
        write_json(
            capture_browser_auth_from_browser(
                browser_name=str(payload.get("browser", "firefox")),
            )
        )
        return 0

    if command == "doctor":
        write_json(_doctor(payload))
        return 0

    if command == "library-scan-root":
        write_json(scan_root(payload))
        return 0

    if command == "library-reconcile-local-root":
        write_json(reconcile_local_root(payload))
        return 0

    if command == "library-inspect-local-files":
        write_json(inspect_local_files(payload))
        return 0

    if command == "liked-artists":
        write_json(
            fetch_liked_artists(
                browser_auth_input=str(payload.get("ytmusic_browser_auth", "")),
            )
        )
        return 0

    if command == "artist-images":
        artists = payload.get("artists")
        write_json(
            fetch_artist_images(
                browser_auth_input=str(payload.get("ytmusic_browser_auth", "")),
                artists=artists if isinstance(artists, list) else [],
            )
        )
        return 0

    if command == "sync-run":
        run_sync(SyncConfig.from_payload(payload))
        return 0

    raise SystemExit(f"unknown command: {command}")


if __name__ == "__main__":
    raise SystemExit(main())
