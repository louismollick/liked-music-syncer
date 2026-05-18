from __future__ import annotations

from pathlib import Path

from liked_music_syncer.templating import OutputLayout, render_template


def test_render_template_sanitizes_segments() -> None:
    rendered = render_template("{albumartist}/{album}", {"albumartist": "A/B", "album": "Late: Set"})
    assert rendered == "A_B/Late_ Set"


def test_output_layout_builds_expected_path() -> None:
    layout = OutputLayout("{albumartist}/{album}", "{track:02d} {title}")
    output = layout.build_path(
        Path("/tmp/music"),
        {
            "albumartist": "Massive Attack",
            "album": "Mezzanine",
            "track": 3,
            "title": "Teardrop",
        },
    )
    assert output == Path("/tmp/music/Massive Attack/Mezzanine/03 Teardrop.m4a")
