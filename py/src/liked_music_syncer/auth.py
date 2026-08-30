from __future__ import annotations

import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from http.cookiejar import CookieJar
from pathlib import Path
from typing import Any, Iterator
from urllib.request import Request

import ytmusicapi
from ytmusicapi import YTMusic
from ytmusicapi.helpers import get_authorization, initialize_headers, sapisid_from_cookie
from yt_dlp.cookies import extract_cookies_from_browser

from .models import AuthStatusResult
AUTH_CHECK_BROWSE_ID = "FEmusic_history"
YTMUSIC_ORIGIN = "https://music.youtube.com"
SIGN_IN_PROMPT_MESSAGE = "YT Music rejected the provided browser auth headers and returned a sign-in prompt."
HELIUM_BACKENDS = ("chromium", "chrome", "brave", "vivaldi", "edge", "opera")


def _custom_browser_profile(browser_name: str) -> Path | None:
    home = Path.home()
    if sys.platform == "darwin":
        app_support = home / "Library" / "Application Support"
        profiles = {
            "zen": app_support / "zen" / "Profiles",
            "helium": app_support / "net.imput.helium" / "Default",
        }
    elif sys.platform in ("cygwin", "win32"):
        appdata = Path(os.environ.get("APPDATA", home))
        local_appdata = Path(os.environ.get("LOCALAPPDATA", home))
        profiles = {
            "zen": appdata / "zen" / "Profiles",
            "helium": local_appdata / "net.imput.helium" / "Default",
        }
    else:
        config_home = Path(os.environ.get("XDG_CONFIG_HOME", home / ".config"))
        profiles = {
            "zen": home / ".zen",
            "helium": config_home / "net.imput.helium" / "Default",
        }
    return profiles.get(browser_name)


def _extract_browser_cookies(
    browser_name: str, profile_name: str | None = None
) -> tuple[CookieJar, tuple[str, ...]]:
    normalized = browser_name.strip().lower()
    profile = _custom_browser_profile(normalized)
    if normalized == "zen":
        assert profile is not None
        return extract_cookies_from_browser("firefox", profile=str(profile)), (
            "firefox",
            str(profile),
        )
    if normalized == "helium":
        assert profile is not None
        errors: list[str] = []
        for backend in HELIUM_BACKENDS:
            try:
                jar = extract_cookies_from_browser(backend, profile=str(profile))
                _get_cookie_header(jar, YTMUSIC_ORIGIN)
                return jar, (backend, str(profile))
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{backend}: {exc}")
        raise ValueError(
            "Could not decrypt YouTube Music cookies from Helium. "
            "Make sure you are signed in at music.youtube.com and fully quit Helium. "
            f"Tried compatible Chromium keychains ({'; '.join(errors)})."
        )
    if profile_name:
        return extract_cookies_from_browser(normalized, profile=profile_name), (
            normalized,
            profile_name,
        )
    return extract_cookies_from_browser(normalized), (normalized,)


def resolve_yt_dlp_cookie_source(browser_name: str) -> tuple[str, ...]:
    """Return yt-dlp's cookies-from-browser tuple for built-in and custom browsers."""
    normalized = browser_name.strip().lower()
    profile = _custom_browser_profile(normalized)
    if normalized == "zen":
        assert profile is not None
        return ("firefox", str(profile))
    if normalized == "helium":
        _, source = _extract_browser_cookies(normalized)
        return source
    return (normalized,)


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


def _build_browser_auth_from_cookie_header(cookie_header: str, auth_user: int) -> str:
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
            "x-goog-authuser": str(auth_user),
            "x-origin": YTMUSIC_ORIGIN,
        }
    )
    return json.dumps(headers)


def build_browser_auth_from_browser_cookies(browser_name: str, auth_user: int = 0) -> str:
    cookie_jar, _ = _extract_browser_cookies(browser_name)
    return _build_browser_auth_from_cookie_header(
        _get_cookie_header(cookie_jar, YTMUSIC_ORIGIN), auth_user
    )


def check_browser_auth_status(browser_auth_input: str) -> AuthStatusResult:
    try:
        normalized, client = _create_validated_browser_auth_client(browser_auth_input)
        account = _get_safe_account(client)
        return AuthStatusResult(
            ok=True,
            is_authenticated=True,
            message="Browser auth check succeeded.",
            credential_json=normalized,
            account=account,
        )
    except Exception as exc:  # noqa: BLE001
        return AuthStatusResult(
            ok=False,
            is_authenticated=False,
            message=str(exc),
            issue_code=_classify_auth_error(exc),
        )


def capture_browser_auth_from_browser(
    browser_name: str, profile_name: str | None = None
) -> AuthStatusResult:
    try:
        cookie_jar, _ = (
            _extract_browser_cookies(browser_name, profile_name)
            if profile_name
            else _extract_browser_cookies(browser_name)
        )
        cookie_header = _get_cookie_header(cookie_jar, YTMUSIC_ORIGIN)

        def probe(auth_user: int) -> tuple[int, str, dict[str, str | None]] | Exception:
            try:
                candidate = _build_browser_auth_from_cookie_header(cookie_header, auth_user)
                normalized, client = _create_validated_browser_auth_client(candidate)
                return auth_user, normalized, _get_required_account(client)
            except Exception as exc:  # noqa: BLE001
                return exc

        with ThreadPoolExecutor(max_workers=2) as executor:
            probed = list(executor.map(probe, range(5)))

        accounts: list[dict[str, Any]] = []
        seen: set[tuple[str, str, str]] = set()
        for result in probed:
            if isinstance(result, Exception):
                continue
            auth_user, credential, account = result
            identity = (
                account.get("handle") or "",
                account.get("display_name") or "",
                account.get("image_url") or "",
            )
            if identity in seen:
                continue
            seen.add(identity)
            accounts.append(
                {
                    **account,
                    "auth_user": auth_user,
                    "credential_json": credential,
                }
            )

        if not accounts:
            failures = [result for result in probed if isinstance(result, Exception)]
            non_session = [
                failure
                for failure in failures
                if _classify_auth_error(failure, browser_name) != "no_session"
            ]
            if non_session:
                raise non_session[0]
            raise ValueError("No valid YouTube Music session found in browser account slots 0 through 4.")
        first = accounts[0]
        return AuthStatusResult(
            ok=True,
            is_authenticated=True,
            message=f"Loaded YT Music browser auth from {browser_name}.",
            credential_json=str(first["credential_json"]),
            account={
                "display_name": first.get("display_name"),
                "handle": first.get("handle"),
                "image_url": first.get("image_url"),
            },
            accounts=accounts,
        )
    except Exception as exc:  # noqa: BLE001
        return AuthStatusResult(
            ok=False,
            is_authenticated=False,
            message=str(exc),
            issue_code=_classify_auth_error(exc, browser_name),
        )


def fetch_liked_song_count(browser_auth_input: str) -> dict[str, Any]:
    try:
        _, client = _create_validated_browser_auth_client(browser_auth_input)
        liked = client.get_liked_songs(limit=1)
        count = liked.get("trackCount") if isinstance(liked, dict) else None
        return {"ok": isinstance(count, int), "count": count if isinstance(count, int) else None}
    except Exception:
        return {"ok": False, "count": None}


def _safe_account(value: Any) -> dict[str, str | None]:
    if not isinstance(value, dict):
        return {"display_name": "YouTube Music", "handle": None, "image_url": None}
    name = value.get("accountName") or value.get("name") or "YouTube Music"
    handle = value.get("channelHandle") or value.get("handle")
    image = value.get("accountPhotoUrl") or value.get("imageUrl")
    return {
        "display_name": str(name),
        "handle": str(handle) if isinstance(handle, str) else None,
        "image_url": str(image) if isinstance(image, str) else None,
    }


def _get_safe_account(client: Any) -> dict[str, str | None]:
    getter = getattr(client, "get_account_info", None)
    if not callable(getter):
        return _safe_account(None)
    try:
        return _safe_account(getter())
    except Exception:  # Account metadata must not invalidate usable credentials.
        return _safe_account(None)


def _get_required_account(client: Any) -> dict[str, str | None]:
    getter = getattr(client, "get_account_info", None)
    if not callable(getter):
        raise ValueError("YouTube Music account metadata is unavailable.")
    value = getter()
    if not isinstance(value, dict):
        raise ValueError("YouTube Music account metadata returned an unexpected response.")
    account = _safe_account(value)
    if account["display_name"] == "YouTube Music" and account["handle"] is None:
        raise ValueError("YouTube Music account metadata returned an unexpected response.")
    return account


def _classify_auth_error(exc: Exception, browser_name: str | None = None) -> str:
    message = str(exc).lower()
    if (
        "no youtube music cookies" in message
        or "missing the __secure" in message
        or "sign-in prompt" in message
        or "no valid youtube music session" in message
    ):
        return "no_session"
    if "keychain" in message or "decrypt" in message:
        return "keychain_denied"
    if browser_name == "safari" and ("permission" in message or "operation not permitted" in message):
        return "permission_denied"
    if "profile" in message and ("missing" in message or "not found" in message):
        return "browser_profile_missing"
    if "network" in message or "timed out" in message or "urlopen" in message:
        return "network_unavailable"
    if "unexpected response" in message:
        return "unexpected_response"
    return "cookie_store_unreadable"
