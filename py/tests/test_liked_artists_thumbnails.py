from __future__ import annotations

from liked_music_syncer.liked_artists import _best_thumbnail_url, _upgrade_thumbnail_url


def test_upgrade_thumbnail_url_requests_larger_size() -> None:
    url = "https://lh3.googleusercontent.com/photo=s88-c-k-no-rj"
    assert _upgrade_thumbnail_url(url) == "https://lh3.googleusercontent.com/photo=s544-c-k-no-rj"


def test_best_thumbnail_url_prefers_larger_edge() -> None:
    thumbnails = [
        {"url": "https://example.test/small.jpg", "width": 60, "height": 60},
        {"url": "https://example.test/large.jpg", "width": 544, "height": 544},
    ]
    assert _best_thumbnail_url(thumbnails) == "https://example.test/large.jpg"


def test_best_thumbnail_url_upgrades_when_only_small_available() -> None:
    thumbnails = [{"url": "https://lh3.googleusercontent.com/x=s120", "width": 120, "height": 120}]
    assert _best_thumbnail_url(thumbnails) == "https://lh3.googleusercontent.com/x=s544"
