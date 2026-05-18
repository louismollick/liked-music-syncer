from __future__ import annotations

import json
import time
from http.cookiejar import CookieJar
from typing import Any, Iterator
from urllib.request import Request

import ytmusicapi
from ytmusicapi import YTMusic
from ytmusicapi.auth.oauth import OAuthCredentials
from ytmusicapi.helpers import get_authorization, initialize_headers, sapisid_from_cookie
from yt_dlp.cookies import extract_cookies_from_browser

from .models import AuthFinishResult, AuthStartResult, AuthStatusResult

REQUIRED_TOKEN_FIELDS = {
    "access_token",
    "refresh_token",
    "token_type",
    "scope",
    "expires_in",
}
AUTH_CHECK_BROWSE_ID = "FEmusic_history"
YTMUSIC_ORIGIN = "https://music.youtube.com"
SIGN_IN_PROMPT_MESSAGE = "YT Music rejected the provided browser auth headers and returned a sign-in prompt."


def _normalize_error_state(message: str) -> str:
    lower = message.lower()
    if "authorization_pending" in lower:
        return "pending"
    if "slow_down" in lower:
        return "pending"
    if "expired_token" in lower or "expired" in lower:
        return "expired"
    return "failed"


def _token_error_message(payload: dict[str, Any]) -> str | None:
    error = payload.get("error")
    if not error:
        return None

    description = payload.get("error_description")
    if description:
        return f"{error}: {description}"
    return str(error)


def normalize_browser_auth_input(browser_auth_input: str) -> str:
    raw = browser_auth_input.strip()
    if not raw:
        raise ValueError("Browser auth headers must be provided.")

    if raw.startswith("{"):
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            raise ValueError("Browser auth JSON must be an object.")
        return json.dumps(parsed)

    return ytmusicapi.setup(headers_raw=raw)


def _parse_browser_auth_headers(browser_auth_input: str) -> dict[str, str]:
    parsed = json.loads(normalize_browser_auth_input(browser_auth_input))
    if not isinstance(parsed, dict):
        raise ValueError("Browser auth JSON must be an object.")

    headers: dict[str, str] = {}
    for key, value in parsed.items():
        if isinstance(key, str) and isinstance(value, str):
            normalized_key = key.strip().lower()
            normalized_value = value.strip()
            if normalized_key and normalized_value:
                headers[normalized_key] = normalized_value
    return headers


def _iter_nodes(value: Any) -> Iterator[Any]:
    yield value
    if isinstance(value, dict):
        for child in value.values():
            yield from _iter_nodes(child)
    elif isinstance(value, list):
        for child in value:
            yield from _iter_nodes(child)


def _extract_message_text(value: Any) -> str | None:
    if not isinstance(value, dict):
        return None

    text = value.get("text")
    if not isinstance(text, dict):
        return None

    runs = text.get("runs")
    if not isinstance(runs, list):
        return None

    parts = [part for run in runs if isinstance(run, dict) and isinstance(part := run.get("text"), str)]
    joined = "".join(parts).strip()
    return joined or None


def _find_sign_in_prompt_message(response: dict[str, Any]) -> str | None:
    found_sign_in = False
    messages: list[str] = []

    for node in _iter_nodes(response):
        if not isinstance(node, dict):
            continue

        if "signInEndpoint" in node:
            found_sign_in = True

        for key in ("messageRenderer", "messageSubtextRenderer"):
            message = _extract_message_text(node.get(key))
            if message and message not in messages:
                messages.append(message)

    if not found_sign_in:
        return None

    return " ".join(messages) if messages else None


def _create_validated_browser_auth_client(browser_auth_input: str) -> tuple[str, YTMusic]:
    normalized = json.dumps(_parse_browser_auth_headers(browser_auth_input))
    ytmusic = YTMusic(normalized)
    response = ytmusic._send_request("browse", {"browseId": AUTH_CHECK_BROWSE_ID})

    prompt_message = _find_sign_in_prompt_message(response)
    if prompt_message:
        raise ValueError(f"{SIGN_IN_PROMPT_MESSAGE} {prompt_message}")

    if not isinstance(response.get("contents"), dict):
        raise ValueError("YT Music browser auth check returned an unexpected response.")

    return normalized, ytmusic


def build_browser_auth_client(browser_auth_input: str) -> YTMusic:
    _, ytmusic = _create_validated_browser_auth_client(browser_auth_input)
    return ytmusic


def _get_cookie_header(cookie_jar: CookieJar, url: str) -> str:
    request = Request(url)
    cookie_jar.add_cookie_header(request)
    cookie_header = request.get_header("Cookie")
    if not cookie_header:
        raise ValueError("No YouTube Music cookies found in the selected browser. Make sure you are signed in.")
    return cookie_header


def build_browser_auth_from_browser_cookies(browser_name: str) -> str:
    cookie_jar = extract_cookies_from_browser(browser_name)
    cookie_header = _get_cookie_header(cookie_jar, YTMUSIC_ORIGIN)
    try:
        sapisid = sapisid_from_cookie(cookie_header)
    except KeyError as exc:
        raise ValueError(
            "Selected browser profile is missing the __Secure-3PAPISID YouTube cookie. Open music.youtube.com in that browser first."
        ) from exc

    headers = dict(initialize_headers())
    headers.update(
        {
            "authorization": get_authorization(f"{sapisid} {YTMUSIC_ORIGIN}"),
            "cookie": cookie_header,
            "x-goog-authuser": "0",
            "x-origin": YTMUSIC_ORIGIN,
        }
    )
    return json.dumps(headers)


def start_device_auth(client_id: str, client_secret: str) -> AuthStartResult:
    try:
        credentials = OAuthCredentials(client_id=client_id, client_secret=client_secret)
        code = credentials.get_code()
        return AuthStartResult(
            ok=True,
            message="YT Music device auth started.",
            verification_url=str(code["verification_url"]),
            user_code=str(code["user_code"]),
            device_code=str(code["device_code"]),
            interval=int(code["interval"]),
            expires_in=int(code["expires_in"]),
        )
    except Exception as exc:  # noqa: BLE001
        return AuthStartResult(ok=False, message=str(exc))


def finish_device_auth(client_id: str, client_secret: str, device_code: str) -> AuthFinishResult:
    try:
        credentials = OAuthCredentials(client_id=client_id, client_secret=client_secret)
        token = dict(credentials.token_from_code(device_code))
        token_error = _token_error_message(token)
        if token_error:
            state = _normalize_error_state(token_error)
            return AuthFinishResult(ok=state == "pending", state=state, message=token_error)

        missing_fields = sorted(REQUIRED_TOKEN_FIELDS - set(token))
        if missing_fields:
            return AuthFinishResult(
                ok=False,
                state="failed",
                message=f"OAuth token response missing fields: {', '.join(missing_fields)}",
            )

        return AuthFinishResult(
            ok=True,
            state="authorized",
            message="YT Music device auth complete.",
            token_json=json.dumps(token),
        )
    except Exception as exc:  # noqa: BLE001
        message = str(exc)
        state = _normalize_error_state(message)
        return AuthFinishResult(ok=state == "pending", state=state, message=message)


def check_auth_status(client_id: str, client_secret: str, token_json: str) -> AuthStatusResult:
    try:
        token = json.loads(token_json)
        token_error = _token_error_message(token)
        if token_error:
            return AuthStatusResult(
                ok=False,
                is_authenticated=False,
                message=token_error,
            )

        refresh_token = str(token.get("refresh_token", "")).strip()
        if not refresh_token:
            return AuthStatusResult(
                ok=False,
                is_authenticated=False,
                message="Saved OAuth token is incomplete: missing refresh_token.",
            )

        credentials = OAuthCredentials(client_id=client_id, client_secret=client_secret)
        fresh = credentials.refresh_token(refresh_token)
        refreshed_token: dict[str, Any] = dict(token)
        refreshed_token.update(dict(fresh))
        refreshed_token["refresh_token"] = refresh_token
        refreshed_token["expires_at"] = int(time.time()) + int(fresh["expires_in"])
        return AuthStatusResult(
            ok=True,
            is_authenticated=True,
            message="OAuth token refresh succeeded.",
            credential_json=json.dumps(refreshed_token),
        )
    except Exception as exc:  # noqa: BLE001
        return AuthStatusResult(
            ok=False,
            is_authenticated=False,
            message=str(exc),
        )


def check_browser_auth_status(browser_auth_input: str) -> AuthStatusResult:
    try:
        normalized, _ = _create_validated_browser_auth_client(browser_auth_input)
        return AuthStatusResult(
            ok=True,
            is_authenticated=True,
            message="Browser auth check succeeded.",
            credential_json=normalized,
        )
    except Exception as exc:  # noqa: BLE001
        return AuthStatusResult(
            ok=False,
            is_authenticated=False,
            message=str(exc),
        )


def capture_browser_auth_from_browser(browser_name: str) -> AuthStatusResult:
    try:
        browser_auth = build_browser_auth_from_browser_cookies(browser_name)
        normalized, _ = _create_validated_browser_auth_client(browser_auth)
        return AuthStatusResult(
            ok=True,
            is_authenticated=True,
            message=f"Loaded YT Music browser auth from {browser_name}.",
            credential_json=normalized,
        )
    except Exception as exc:  # noqa: BLE001
        return AuthStatusResult(
            ok=False,
            is_authenticated=False,
            message=str(exc),
        )
