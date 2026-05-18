from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from string import Formatter
from typing import Any, Mapping, Sequence


INVALID_PATH_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def sanitize_segment(value: str, fallback: str = "_") -> str:
    compact = " ".join(value.strip().split())
    cleaned = INVALID_PATH_CHARS.sub("_", compact)
    return cleaned or fallback


class TemplateFormatter(Formatter):
    def get_value(
        self,
        key: int | str,
        args: Sequence[Any],
        kwargs: Mapping[str, Any],
    ) -> Any:
        if isinstance(key, str):
            return kwargs.get(key, "")
        return Formatter.get_value(self, key, args, kwargs)


def render_template(template: str, context: dict[str, Any]) -> str:
    formatter = TemplateFormatter()
    safe_context = {
        key: sanitize_segment(str(value)) if isinstance(value, str) else value
        for key, value in context.items()
    }
    rendered = formatter.format(template, **safe_context)
    return "/".join(sanitize_segment(part) for part in rendered.split("/"))


@dataclass(slots=True)
class OutputLayout:
    folder_template: str
    file_template: str
    extension: str = ".m4a"

    def build_path(self, root: Path, context: dict[str, Any]) -> Path:
        folder = render_template(self.folder_template, context)
        file_stem = render_template(self.file_template, context)
        return root / folder / f"{file_stem}{self.extension}"
