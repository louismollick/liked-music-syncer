from liked_music_syncer.lyrics_language import (
    detect_primary_lyrics_language,
    normalize_lyrics_for_detection,
)


def test_detect_primary_lyrics_language_for_plain_english_lyrics() -> None:
    assert detect_primary_lyrics_language("Hello from the other side\nI must have called a thousand times\n") == "en"


def test_detect_primary_lyrics_language_for_lrc_lyrics() -> None:
    lyrics = "[00:01.00]Hello from the other side\n[00:05.00]I must have called a thousand times\n"
    assert detect_primary_lyrics_language(lyrics) == "en"


def test_detect_primary_lyrics_language_ignores_lrc_metadata_lines() -> None:
    lyrics = (
        "[ar:Adele]\n"
        "[ti:Hello]\n"
        "[00:01.00]Hello from the other side\n"
        "[00:05.00]I must have called a thousand times\n"
    )
    assert normalize_lyrics_for_detection(lyrics) == (
        "Hello from the other side I must have called a thousand times"
    )
    assert detect_primary_lyrics_language(lyrics) == "en"


def test_detect_primary_lyrics_language_returns_none_for_unusable_text() -> None:
    assert detect_primary_lyrics_language(None) is None
    assert detect_primary_lyrics_language(" \n\t ") is None
    assert detect_primary_lyrics_language("[00:01.00]\n[00:05.00]\n") is None
