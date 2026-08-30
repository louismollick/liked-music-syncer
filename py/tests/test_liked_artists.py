from __future__ import annotations

from typing import Any

from liked_music_syncer import liked_artists


def test_fetch_artist_image_uses_trusted_channel_id_without_search(monkeypatch) -> None:
    class FakeYTMusic:
        def search(self, *_args: object, **_kwargs: object) -> list[dict[str, Any]]:
            raise AssertionError("artist image lookup must not search by name")

        def get_artist(self, channel_id: str) -> dict[str, Any]:
            assert channel_id == "RIGHT_BAND"
            return {
                "thumbnails": [
                    {
                        "url": "https://img.test/right-band.jpg",
                        "width": 544,
                        "height": 544,
                    }
                ]
            }

    monkeypatch.setattr(
        liked_artists, "build_browser_auth_client", lambda _auth: FakeYTMusic()
    )

    result = liked_artists.fetch_artist_image(
        {
            "ytmusic_browser_auth": "auth",
            "artist": {
                "id": "artist_channel_RIGHT_BAND",
                "channel_id": "RIGHT_BAND",
                "name": "Phoenix",
            },
        }
    )

    assert result == {
        "ok": True,
        "message": "Artist image resolved.",
        "artist": {
            "id": "artist_channel_RIGHT_BAND",
            "channel_id": "RIGHT_BAND",
            "photo_url": "https://img.test/right-band.jpg",
        },
    }


def test_fetch_artist_image_without_channel_id_does_not_search(monkeypatch) -> None:
    class FakeYTMusic:
        def search(self, *_args: object, **_kwargs: object) -> list[dict[str, Any]]:
            raise AssertionError("artist image lookup must not search by name")

        def get_artist(self, _channel_id: str) -> dict[str, Any]:
            raise AssertionError("missing channel ID must not call get_artist")

    monkeypatch.setattr(
        liked_artists, "build_browser_auth_client", lambda _auth: FakeYTMusic()
    )

    result = liked_artists.fetch_artist_image(
        {
            "ytmusic_browser_auth": "auth",
            "artist": {"id": "local_artist_phoenix", "name": "Phoenix"},
        }
    )

    assert result == {
        "ok": True,
        "message": "No trusted artist image available.",
        "artist": None,
    }
