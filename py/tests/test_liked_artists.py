from __future__ import annotations

from typing import Any

from liked_music_syncer import liked_artists


def test_fetch_liked_artists_keeps_same_name_trusted_and_unidentified_rows(
    monkeypatch,
) -> None:
    class FakeYTMusic:
        def get_liked_songs(self, limit: int) -> dict[str, Any]:
            assert limit == 5000
            return {
                "tracks": [
                    {"artists": [{"name": "Phoenix", "id": "UC_TRUSTED"}]},
                    {"artists": [{"name": "Phoenix"}]},
                ]
            }

        def get_artist(self, _channel_id: str) -> dict[str, Any]:
            return {}

    monkeypatch.setattr(
        liked_artists, "build_browser_auth_client", lambda _auth: FakeYTMusic()
    )

    result = liked_artists.fetch_liked_artists("auth")

    assert result["artists"] == [
        {
            "id": "artist_channel_UC_TRUSTED",
            "channel_id": "UC_TRUSTED",
            "name": "Phoenix",
            "normalized_name": "phoenix",
            "photo_url": None,
            "liked_track_count": 1,
        },
        {
            "id": "artist_name_phoenix",
            "channel_id": None,
            "name": "Phoenix",
            "normalized_name": "phoenix",
            "photo_url": None,
            "liked_track_count": 1,
        },
    ]


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


def test_fetch_artist_image_retries_transient_failure(monkeypatch) -> None:
    attempts = 0
    sleeps: list[float] = []

    class FakeYTMusic:
        def get_artist(self, _channel_id: str) -> dict[str, Any]:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise RuntimeError("temporary failure")
            return {
                "thumbnails": [
                    {
                        "url": "https://img.test/recovered.jpg",
                        "width": 544,
                        "height": 544,
                    }
                ]
            }

    monkeypatch.setattr(
        liked_artists, "build_browser_auth_client", lambda _auth: FakeYTMusic()
    )
    monkeypatch.setattr(liked_artists.time, "sleep", sleeps.append)

    result = liked_artists.fetch_artist_image(
        {
            "ytmusic_browser_auth": "auth",
            "artist": {
                "id": "artist_channel_RECOVERED",
                "channel_id": "RECOVERED",
                "name": "Recovered Artist",
            },
        }
    )

    assert result["ok"] is True
    assert result["artist"]["photo_url"] == "https://img.test/recovered.jpg"
    assert attempts == 2
    assert sleeps == [0.5]


def test_fetch_artist_image_reports_exhausted_failure(monkeypatch) -> None:
    attempts = 0
    sleeps: list[float] = []

    class FakeYTMusic:
        def get_artist(self, _channel_id: str) -> dict[str, Any]:
            nonlocal attempts
            attempts += 1
            raise RuntimeError("temporary\nfailure")

    monkeypatch.setattr(
        liked_artists, "build_browser_auth_client", lambda _auth: FakeYTMusic()
    )
    monkeypatch.setattr(liked_artists.time, "sleep", sleeps.append)

    result = liked_artists.fetch_artist_image(
        {
            "ytmusic_browser_auth": "auth",
            "artist": {
                "id": "artist_channel_FAILING",
                "channel_id": "FAILING",
                "name": "Failing Artist",
            },
        }
    )

    assert result == {
        "ok": False,
        "message": "Artist image lookup failed after 3 attempts.",
        "artist": None,
        "error_type": "RuntimeError",
        "error_message": "temporary failure",
        "attempts": 3,
    }
    assert attempts == 3
    assert sleeps == [0.5, 1.5]


def test_fetch_artist_image_does_not_retry_successful_response_without_image(
    monkeypatch,
) -> None:
    attempts = 0

    class FakeYTMusic:
        def get_artist(self, _channel_id: str) -> dict[str, Any]:
            nonlocal attempts
            attempts += 1
            return {"thumbnails": []}

    monkeypatch.setattr(
        liked_artists, "build_browser_auth_client", lambda _auth: FakeYTMusic()
    )

    result = liked_artists.fetch_artist_image(
        {
            "ytmusic_browser_auth": "auth",
            "artist": {
                "id": "artist_channel_NO_IMAGE",
                "channel_id": "NO_IMAGE",
                "name": "No Image Artist",
            },
        }
    )

    assert result == {
        "ok": True,
        "message": "Artist page returned no usable image.",
        "artist": None,
    }
    assert attempts == 1
