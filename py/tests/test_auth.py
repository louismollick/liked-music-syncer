from __future__ import annotations

import json
from http.cookiejar import Cookie, CookieJar
from pathlib import Path

import liked_music_syncer.auth as auth_module
from liked_music_syncer.auth import normalize_browser_auth_input


def test_normalize_browser_auth_input_accepts_json() -> None:
    payload = normalize_browser_auth_input('{"cookie":"a=b","x-goog-authuser":"0"}')

    assert json.loads(payload) == {
        "cookie": "a=b",
        "x-goog-authuser": "0",
    }


def test_check_browser_auth_status_normalizes_and_validates(monkeypatch) -> None:
    class FakeYTMusic:
        def __init__(self, auth: str) -> None:
            self.auth = auth

        def _send_request(self, endpoint: str, body: dict[str, str]) -> dict[str, object]:
            assert endpoint == "browse"
            assert body == {"browseId": "FEmusic_history"}
            return {"contents": {"sectionListRenderer": {"contents": []}}}

    monkeypatch.setattr(auth_module, "YTMusic", FakeYTMusic)
    monkeypatch.setattr(
        auth_module.ytmusicapi,
        "setup",
        lambda headers_raw: '{"cookie":"a=b","x-goog-authuser":"0","authorization":"SAPISIDHASH demo"}',
    )

    result = auth_module.check_browser_auth_status("cookie: a=b\nx-goog-authuser: 0")

    assert result.ok is True
    assert result.is_authenticated is True
    assert result.credential_json is not None


def test_check_browser_auth_status_rejects_sign_in_prompt(monkeypatch) -> None:
    class FakeYTMusic:
        def __init__(self, auth: str) -> None:
            self.auth = auth

        def _send_request(self, endpoint: str, body: dict[str, str]) -> dict[str, object]:
            assert endpoint == "browse"
            assert body == {"browseId": "FEmusic_history"}
            return {
                "contents": {
                    "singleColumnBrowseResultsRenderer": {
                        "tabs": [
                            {
                                "tabRenderer": {
                                    "content": {
                                        "sectionListRenderer": {
                                            "contents": [
                                                {
                                                    "itemSectionRenderer": {
                                                        "contents": [
                                                            {
                                                                "messageRenderer": {
                                                                    "text": {
                                                                        "runs": [{"text": "Looking for what you've liked?"}]
                                                                    },
                                                                    "button": {
                                                                        "buttonRenderer": {
                                                                            "navigationEndpoint": {
                                                                                "signInEndpoint": {"hack": True}
                                                                            }
                                                                        }
                                                                    },
                                                                    "subtext": {
                                                                        "messageSubtextRenderer": {
                                                                            "text": {
                                                                                "runs": [
                                                                                    {
                                                                                        "text": "Sign in to listen to your liked tracks"
                                                                                    }
                                                                                ]
                                                                            }
                                                                        }
                                                                    },
                                                                }
                                                            }
                                                        ]
                                                    }
                                                }
                                            ]
                                        }
                                    }
                                }
                            }
                        ]
                    }
                }
            }

    monkeypatch.setattr(auth_module, "YTMusic", FakeYTMusic)
    monkeypatch.setattr(
        auth_module.ytmusicapi,
        "setup",
        lambda headers_raw: '{"cookie":"a=b","x-goog-authuser":"0","authorization":"SAPISIDHASH demo"}',
    )

    result = auth_module.check_browser_auth_status("cookie: a=b\nx-goog-authuser: 0")

    assert result.ok is False
    assert result.is_authenticated is False
    assert "returned a sign-in prompt" in result.message


def test_build_browser_auth_from_browser_cookies(monkeypatch) -> None:
    jar = CookieJar()
    jar.set_cookie(
        Cookie(
            version=0,
            name="__Secure-3PAPISID",
            value="secure-cookie",
            port=None,
            port_specified=False,
            domain=".youtube.com",
            domain_specified=True,
            domain_initial_dot=True,
            path="/",
            path_specified=True,
            secure=True,
            expires=None,
            discard=True,
            comment=None,
            comment_url=None,
            rest={},
            rfc2109=False,
        )
    )
    jar.set_cookie(
        Cookie(
            version=0,
            name="VISITOR_INFO1_LIVE",
            value="visitor-cookie",
            port=None,
            port_specified=False,
            domain=".youtube.com",
            domain_specified=True,
            domain_initial_dot=True,
            path="/",
            path_specified=True,
            secure=True,
            expires=None,
            discard=True,
            comment=None,
            comment_url=None,
            rest={},
            rfc2109=False,
        )
    )

    monkeypatch.setattr(auth_module, "extract_cookies_from_browser", lambda browser_name: jar)
    monkeypatch.setattr(auth_module, "get_authorization", lambda auth: f"SAPISIDHASH {auth}")

    payload = json.loads(auth_module.build_browser_auth_from_browser_cookies("firefox"))

    assert payload["cookie"] == "__Secure-3PAPISID=secure-cookie; VISITOR_INFO1_LIVE=visitor-cookie"
    assert (
        payload["authorization"]
        == "SAPISIDHASH secure-cookie https://music.youtube.com"
    )
    assert payload["x-goog-authuser"] == "0"
    assert payload["x-origin"] == "https://music.youtube.com"


def test_capture_browser_auth_from_browser_validates_before_returning(monkeypatch) -> None:
    jar = CookieJar()
    jar.set_cookie(
        Cookie(
            version=0,
            name="__Secure-3PAPISID",
            value="secure-cookie",
            port=None,
            port_specified=False,
            domain=".youtube.com",
            domain_specified=True,
            domain_initial_dot=True,
            path="/",
            path_specified=True,
            secure=True,
            expires=None,
            discard=True,
            comment=None,
            comment_url=None,
            rest={},
            rfc2109=False,
        )
    )
    monkeypatch.setattr(
        auth_module,
        "_extract_browser_cookies",
        lambda browser_name: (jar, (browser_name,)),
    )
    monkeypatch.setattr(
        auth_module,
        "_create_validated_browser_auth_client",
        lambda browser_auth_input: (
            browser_auth_input,
            type(
                "Client",
                (),
                {"get_account_info": lambda self: {"accountName": "Listener", "channelHandle": "@listener"}},
            )(),
        ),
    )

    result = auth_module.capture_browser_auth_from_browser("firefox")

    assert result.ok is True
    assert result.is_authenticated is True
    assert result.credential_json is not None
    assert result.accounts is not None
    assert len(result.accounts) == 1


def test_capture_uses_the_resolved_browser_profile(monkeypatch) -> None:
    jar = CookieJar()
    jar.set_cookie(
        Cookie(
            version=0,
            name="__Secure-3PAPISID",
            value="secure-cookie",
            port=None,
            port_specified=False,
            domain=".youtube.com",
            domain_specified=True,
            domain_initial_dot=True,
            path="/",
            path_specified=True,
            secure=True,
            expires=None,
            discard=True,
            comment=None,
            comment_url=None,
            rest={},
            rfc2109=False,
        )
    )
    extracted: list[tuple[str, str | None]] = []

    def extract(browser: str, profile: str | None = None):
        extracted.append((browser, profile))
        return jar

    monkeypatch.setattr(auth_module, "extract_cookies_from_browser", extract)
    monkeypatch.setattr(
        auth_module,
        "_create_validated_browser_auth_client",
        lambda raw: (
            raw,
            type(
                "Client",
                (),
                {
                    "get_account_info": lambda self: {
                        "accountName": "Listener",
                        "channelHandle": "@listener",
                    }
                },
            )(),
        ),
    )

    result = auth_module.capture_browser_auth_from_browser(
        "chrome", "Profile 2"
    )

    assert result.ok is True
    assert extracted == [("chrome", "Profile 2")]


def test_capture_probes_all_five_slots_across_gaps_and_deduplicates(monkeypatch) -> None:
    jar = CookieJar()
    jar.set_cookie(
        Cookie(
            version=0,
            name="__Secure-3PAPISID",
            value="secure-cookie",
            port=None,
            port_specified=False,
            domain=".youtube.com",
            domain_specified=True,
            domain_initial_dot=True,
            path="/",
            path_specified=True,
            secure=True,
            expires=None,
            discard=True,
            comment=None,
            comment_url=None,
            rest={},
            rfc2109=False,
        )
    )
    monkeypatch.setattr(auth_module, "_extract_browser_cookies", lambda browser: (jar, (browser,)))
    seen: list[int] = []

    class Client:
        def __init__(self, index: int) -> None:
            self.index = index

        def get_account_info(self) -> dict[str, str]:
            handle = "@two" if self.index in (2, 4) else "@zero"
            return {"accountName": handle, "channelHandle": handle}

    def validate(raw: str):
        index = int(json.loads(raw)["x-goog-authuser"])
        seen.append(index)
        if index in (1, 3):
            raise ValueError("no session")
        return raw, Client(index)

    monkeypatch.setattr(auth_module, "_create_validated_browser_auth_client", validate)

    result = auth_module.capture_browser_auth_from_browser("firefox")

    assert sorted(seen) == [0, 1, 2, 3, 4]
    assert result.ok is True
    assert result.accounts is not None
    assert [account["auth_user"] for account in result.accounts] == [0, 2]


def test_liked_song_count_counts_tracks_available_to_sync(monkeypatch) -> None:
    class Client:
        def get_liked_songs(self, limit: int) -> dict[str, object]:
            assert limit == 5000
            return {
                "trackCount": 1491,
                "tracks": [{"videoId": f"track-{index}"} for index in range(1340)],
            }

    monkeypatch.setattr(
        auth_module,
        "_create_validated_browser_auth_client",
        lambda raw: (raw, Client()),
    )

    assert auth_module.fetch_liked_song_count('{}') == {"ok": True, "count": 1340}


def test_auth_status_retries_transient_account_metadata_failure(monkeypatch) -> None:
    calls = 0

    class Client:
        def get_account_info(self) -> dict[str, str]:
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError("temporary account metadata failure")
            return {
                "accountName": "Listener",
                "channelHandle": "@listener",
                "accountPhotoUrl": "https://example.test/avatar.jpg",
            }

    monkeypatch.setattr(
        auth_module,
        "_create_validated_browser_auth_client",
        lambda raw: (raw, Client()),
    )

    result = auth_module.check_browser_auth_status('{}')

    assert calls == 2
    assert result.ok is True
    assert result.account == {
        "display_name": "Listener",
        "handle": "@listener",
        "image_url": "https://example.test/avatar.jpg",
    }


def test_zen_uses_firefox_extraction_with_zen_profile(monkeypatch) -> None:
    jar = CookieJar()
    calls: list[tuple[str, str | None]] = []
    monkeypatch.setattr(
        auth_module,
        "_custom_browser_profile",
        lambda browser_name: Path("/profiles/zen"),
    )
    monkeypatch.setattr(
        auth_module,
        "extract_cookies_from_browser",
        lambda browser_name, profile=None: calls.append((browser_name, profile)) or jar,
    )

    extracted, source = auth_module._extract_browser_cookies("zen")

    assert extracted is jar
    assert calls == [("firefox", "/profiles/zen")]
    assert source == ("firefox", "/profiles/zen")


def test_helium_tries_chromium_keychains_until_youtube_cookies_work(monkeypatch) -> None:
    empty_jar = CookieJar()
    youtube_jar = CookieJar()
    youtube_jar.set_cookie(
        Cookie(
            version=0,
            name="__Secure-3PAPISID",
            value="secure-cookie",
            port=None,
            port_specified=False,
            domain=".youtube.com",
            domain_specified=True,
            domain_initial_dot=True,
            path="/",
            path_specified=True,
            secure=True,
            expires=None,
            discard=True,
            comment=None,
            comment_url=None,
            rest={},
            rfc2109=False,
        )
    )
    calls: list[tuple[str, str | None]] = []
    monkeypatch.setattr(auth_module, "HELIUM_BACKENDS", ("chromium", "vivaldi"))
    monkeypatch.setattr(
        auth_module,
        "_custom_browser_profile",
        lambda browser_name: Path("/profiles/helium/Default"),
    )

    def extract(browser_name: str, profile: str | None = None) -> CookieJar:
        calls.append((browser_name, profile))
        return youtube_jar if browser_name == "vivaldi" else empty_jar

    monkeypatch.setattr(auth_module, "extract_cookies_from_browser", extract)

    extracted, source = auth_module._extract_browser_cookies("helium")

    assert extracted is youtube_jar
    assert calls == [
        ("chromium", "/profiles/helium/Default"),
        ("vivaldi", "/profiles/helium/Default"),
    ]
    assert source == ("vivaldi", "/profiles/helium/Default")


def test_permission_error_is_only_a_privacy_permission_issue_for_safari() -> None:
    error = PermissionError("Operation not permitted")

    assert auth_module._classify_auth_error(error, "chrome") == "cookie_store_unreadable"
    assert auth_module._classify_auth_error(error, "firefox") == "cookie_store_unreadable"
    assert auth_module._classify_auth_error(error, "safari") == "permission_denied"
