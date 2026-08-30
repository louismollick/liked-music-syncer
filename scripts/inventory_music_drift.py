#!/usr/bin/env python3
"""Build a read-only comparison of the local and VPS music libraries."""

from __future__ import annotations

import csv
import json
import re
import subprocess
import sys
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Iterable


REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

from liked_music_syncer.media_tags import register_lms_mediafile_fields  # noqa: E402
from mediafile import MediaFile  # noqa: E402


LOCAL_ROOT = Path("/Users/louismollick/Music/liked-music-syncer")
REMOTE_ROOT = "/home/ubuntu/louismollick-server/music"
REPORT_DIR = REPO_ROOT / "reports"
CSV_PATH = REPORT_DIR / "music-drift-2026-08-29.csv"
SUMMARY_PATH = REPORT_DIR / "music-drift-2026-08-29.md"


@dataclass(slots=True)
class Song:
    side: str
    path: str
    title: str
    artist: str
    album_artist: str
    album: str
    duration: float | None
    source_id: str
    resolved_id: str
    spotify_id: str
    soundcloud_id: str
    mb_track_id: str
    isrc: str
    size: int | None

    @property
    def ids(self) -> set[str]:
        return {
            f"{kind}:{value}"
            for kind, value in (
                ("youtube", self.source_id),
                ("youtube", self.resolved_id),
                ("spotify", self.spotify_id),
                ("soundcloud", self.soundcloud_id),
                ("musicbrainz", self.mb_track_id),
                ("isrc", self.isrc),
            )
            if value
        }


def text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return "; ".join(str(item) for item in value if item is not None)
    if isinstance(value, date):
        return value.isoformat()
    return str(value).strip()


def normalize(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).casefold()
    value = value.replace("&", " and ")
    value = re.sub(r"\b(?:official\s+(?:audio|video|music video)|lyrics?|visuali[sz]er)\b", " ", value)
    value = re.sub(r"\b(?:feat|ft)\.?\s+", " ", value)
    value = re.sub(r"[^\w]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def duration_close(left: float | None, right: float | None, tolerance: float = 3.0) -> bool:
    return left is not None and right is not None and abs(left - right) <= tolerance


def local_songs() -> list[Song]:
    register_lms_mediafile_fields()
    songs: list[Song] = []
    for path in sorted(LOCAL_ROOT.rglob("*.m4a")):
        media = MediaFile(str(path))
        songs.append(
            Song(
                side="local",
                path=path.relative_to(LOCAL_ROOT).as_posix(),
                title=text(media.title),
                artist=text(media.artist),
                album_artist=text(media.albumartist),
                album=text(media.album),
                duration=float(media.length) if media.length is not None else None,
                source_id=text(getattr(media, "lms_youtube_music_track_id", None)),
                resolved_id=text(getattr(media, "lms_resolved_youtube_music_track_id", None)),
                spotify_id=text(getattr(media, "lms_spotify_track_id", None)),
                soundcloud_id=text(getattr(media, "lms_soundcloud_track_id", None)),
                mb_track_id=text(media.mb_trackid),
                isrc=text(media.isrc),
                size=path.stat().st_size,
            )
        )
    return songs


def tag(row: dict[str, Any], name: str) -> Any:
    for key, value in row.items():
        if key == name or key.endswith(f":{name}"):
            return value
    return None


def remote_songs() -> list[Song]:
    fields = [
        "-Title", "-Artist", "-AlbumArtist", "-Album", "-Duration", "-FileSize#",
        "-LMS_YOUTUBE_MUSIC_TRACK_ID", "-LMS_RESOLVED_YOUTUBE_MUSIC_TRACK_ID",
        "-LMS_SPOTIFY_TRACK_ID", "-LMS_SOUNDCLOUD_TRACK_ID", "-MusicBrainzTrackId", "-ISRC",
    ]
    command = ["ssh", "vps", "exiftool", "-j", "-n", "-G1", "-s", *fields, "-ext", "m4a", "-r", REMOTE_ROOT]
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    rows = json.loads(result.stdout)
    songs: list[Song] = []
    for row in rows:
        source = text(row.get("SourceFile"))
        duration = tag(row, "Duration")
        songs.append(
            Song(
                side="remote",
                path=source.removeprefix(f"{REMOTE_ROOT}/"),
                title=text(tag(row, "Title")),
                artist=text(tag(row, "Artist")),
                album_artist=text(tag(row, "AlbumArtist")),
                album=text(tag(row, "Album")),
                duration=float(duration) if isinstance(duration, int | float) else None,
                source_id=text(tag(row, "LMS_YOUTUBE_MUSIC_TRACK_ID")),
                resolved_id=text(tag(row, "LMS_RESOLVED_YOUTUBE_MUSIC_TRACK_ID")),
                spotify_id=text(tag(row, "LMS_SPOTIFY_TRACK_ID")),
                soundcloud_id=text(tag(row, "LMS_SOUNDCLOUD_TRACK_ID")),
                mb_track_id=text(tag(row, "MusicBrainzTrackId")),
                isrc=text(tag(row, "ISRC")),
                size=int(tag(row, "FileSize")) if isinstance(tag(row, "FileSize"), int | float) else None,
            )
        )
    return songs


def choose_match(remote: Song, candidates: Iterable[Song]) -> tuple[Song | None, str, str]:
    candidates = list(candidates)
    same_path = [song for song in candidates if song.path == remote.path]
    if same_path:
        return same_path[0], "same_path", "certain"

    id_matches = [song for song in candidates if remote.ids & song.ids]
    if id_matches:
        best = max(id_matches, key=lambda song: len(remote.ids & song.ids))
        shared = ";".join(sorted(remote.ids & best.ids))
        return best, f"shared_id:{shared}", "certain"

    r_artist = normalize(remote.artist or remote.album_artist)
    r_title = normalize(remote.title)
    exact_metadata = [
        song for song in candidates
        if normalize(song.artist or song.album_artist) == r_artist
        and normalize(song.title) == r_title
        and duration_close(remote.duration, song.duration)
    ]
    if exact_metadata:
        best = min(exact_metadata, key=lambda song: abs((song.duration or 0) - (remote.duration or 0)))
        return best, "normalized_artist_title_duration", "strong"

    best: Song | None = None
    best_score = 0.0
    for song in candidates:
        if not duration_close(remote.duration, song.duration, tolerance=5.0):
            continue
        artist_score = SequenceMatcher(None, r_artist, normalize(song.artist or song.album_artist)).ratio()
        title_score = SequenceMatcher(None, r_title, normalize(song.title)).ratio()
        score = 0.4 * artist_score + 0.6 * title_score
        if artist_score >= 0.72 and title_score >= 0.78 and score > best_score:
            best = song
            best_score = score
    if best is not None:
        return best, f"fuzzy_metadata_duration:{best_score:.3f}", "possible"
    return None, "no_equivalent_found", "unmatched"


def main() -> None:
    local = local_songs()
    remote = remote_songs()
    local_by_ids: dict[str, list[Song]] = defaultdict(list)
    for song in local:
        for identity in song.ids:
            local_by_ids[identity].append(song)

    rows: list[dict[str, Any]] = []
    status_counts: Counter[str] = Counter()
    remote_identity_counts = Counter(identity for song in remote for identity in song.ids)
    remote_meta_counts = Counter(
        (normalize(song.artist or song.album_artist), normalize(song.title), round(song.duration or -1))
        for song in remote
    )
    local_paths = {song.path for song in local}

    for song in remote:
        narrowed = {candidate.path: candidate for identity in song.ids for candidate in local_by_ids.get(identity, [])}
        match, reason, confidence = choose_match(song, narrowed.values() if narrowed else local)
        if song.path in local_paths:
            status = "present_same_path"
        elif match and confidence == "certain":
            status = "remote_only_duplicate_by_id"
        elif match and confidence == "strong":
            status = "remote_only_duplicate_by_metadata"
        elif match:
            status = "remote_only_possible_duplicate"
        else:
            status = "remote_only_no_equivalent"
        status_counts[status] += 1
        duplicate_on_remote = any(remote_identity_counts[item] > 1 for item in song.ids)
        meta_key = (normalize(song.artist or song.album_artist), normalize(song.title), round(song.duration or -1))
        duplicate_on_remote = duplicate_on_remote or remote_meta_counts[meta_key] > 1
        rows.append(
            {
                "status": status,
                "confidence": confidence,
                "match_reason": reason,
                "remote_duplicate_group": "yes" if duplicate_on_remote else "no",
                "remote_path": song.path,
                "remote_title": song.title,
                "remote_artist": song.artist,
                "remote_album_artist": song.album_artist,
                "remote_album": song.album,
                "remote_duration_seconds": f"{song.duration:.3f}" if song.duration is not None else "",
                "remote_size_bytes": song.size or "",
                "remote_youtube_id": song.source_id,
                "remote_resolved_youtube_id": song.resolved_id,
                "remote_spotify_id": song.spotify_id,
                "remote_musicbrainz_track_id": song.mb_track_id,
                "local_path": match.path if match else "",
                "local_title": match.title if match else "",
                "local_artist": match.artist if match else "",
                "local_album_artist": match.album_artist if match else "",
                "local_album": match.album if match else "",
                "local_duration_seconds": f"{match.duration:.3f}" if match and match.duration is not None else "",
                "local_youtube_id": match.source_id if match else "",
                "local_resolved_youtube_id": match.resolved_id if match else "",
                "local_spotify_id": match.spotify_id if match else "",
                "local_musicbrainz_track_id": match.mb_track_id if match else "",
            }
        )

    REPORT_DIR.mkdir(exist_ok=True)
    with CSV_PATH.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)

    remote_only = len(remote) - status_counts["present_same_path"]
    current_local_paths = {song.path for song in local}
    current_remote_paths = {song.path for song in remote}
    local_paths_absent_remote = current_local_paths - current_remote_paths
    represented_elsewhere = {
        row["local_path"]
        for row in rows
        if row["local_path"] and row["status"].startswith("remote_only_duplicate")
    }
    unmatched = [row for row in rows if row["status"] == "remote_only_no_equivalent"]
    unmatched_lines = "\n".join(
        f"- `{row['remote_path']}`"
        for row in unmatched
    )
    summary = f"""# Music library drift inventory

Generated 2026-08-29 using a read-only scan of `{LOCAL_ROOT}` and `{REMOTE_ROOT}` on `vps`.

## Counts

| Category | Files |
| --- | ---: |
| Local audio files | {len(local)} |
| VPS audio files | {len(remote)} |
| VPS files present at the same local path | {status_counts['present_same_path']} |
| VPS-only paths | {remote_only} |
| VPS-only duplicate by embedded ID | {status_counts['remote_only_duplicate_by_id']} |
| VPS-only duplicate by normalized metadata and duration | {status_counts['remote_only_duplicate_by_metadata']} |
| VPS-only possible duplicate | {status_counts['remote_only_possible_duplicate']} |
| VPS-only with no equivalent found | {status_counts['remote_only_no_equivalent']} |

The CSV contains every VPS `.m4a`, its classification, the best local match, and the evidence used. `possible` matches need human review. `no_equivalent_found` means no shared embedded identity and no artist/title/duration match under the documented thresholds.

## Diagnosis

The app does not run `rsync`. Normal sync and remote backfill use `rclone copyto`, which adds or overwrites one target and does not delete other paths. Reprocess has a targeted `rclone deletefile` cleanup when it knows the old path, but ordinary sync does not mirror the local tree.

The current remote-backfill path selection also preserves a stale remote path when it finds a song there by source or resolved YouTube ID. It then copies the current local file over that stale path. This explains both the drift and VPS files whose filename no longer describes their embedded title and artist.

There are {len(local_paths_absent_remote)} current local paths absent from the VPS. Of those, {len(local_paths_absent_remote & represented_elsewhere)} are represented by an ID or metadata-matched file at another VPS path.

## VPS files with no canonical equivalent found

{unmatched_lines}
"""
    SUMMARY_PATH.write_text(summary, encoding="utf-8")
    print(summary)
    print(f"CSV: {CSV_PATH}")


if __name__ == "__main__":
    main()
