from __future__ import annotations

import json
from http.cookiejar import Cookie, CookieJar

import liked_music_syncer.auth as auth_module
from liked_music_syncer.auth import _normalize_error_state, normalize_browser_auth_input


def test_normalize_error_state_maps_pending_and_expired() -> None:
    assert _normalize_error_state("authorization_pending") == "pending"
    assert _normalize_error_state("expired_token") == "expired"
    assert _normalize_error_state("boom") == "failed"


def test_finish_device_auth_returns_pending_for_error_payload(monkeypatch) -> None:
    class FakeCredentials:
        def __init__(self, client_id: str, client_secret: str) -> None:
            self.client_id = client_id
            self.client_secret = client_secret

        def token_from_code(self, device_code: str) -> dict[str, str]:
            assert device_code == "device-code"
            return {"error": "authorization_pending"}

    monkeypatch.setattr(auth_module, "OAuthCredentials", FakeCredentials)

    result = auth_module.finish_device_auth("client-id", "client-secret", "device-code")

    assert result.ok is True
    assert result.state == "pending"
    assert result.token_json is None
    assert result.message == "authorization_pending"


def test_check_auth_status_rejects_missing_refresh_token() -> None:
    result = auth_module.check_auth_status(
        "client-id",
        "client-secret",
        json.dumps({"access_token": "abc"}),
    )

    assert result.ok is False
    assert result.is_authenticated is False
    assert result.message == "Saved OAuth token is incomplete: missing refresh_token."


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
    monkeypatch.setattr(
        auth_module,
        "build_browser_auth_from_browser_cookies",
        lambda browser_name: '{"cookie":"a=b","authorization":"SAPISIDHASH demo","x-goog-authuser":"0"}',
    )
    monkeypatch.setattr(
        auth_module,
        "_create_validated_browser_auth_client",
        lambda browser_auth_input: (browser_auth_input, object()),
    )

    result = auth_module.capture_browser_auth_from_browser("firefox")

    assert result.ok is True
    assert result.is_authenticated is True
    assert result.credential_json is not None
