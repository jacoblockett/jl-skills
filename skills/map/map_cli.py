"""UTF-8-safe public bootstrap for the Map CLI."""

from __future__ import annotations

import sys
from typing import TextIO


def _configure_utf8(stream: TextIO) -> None:
    """Make redirected and terminal output deterministic on Windows.

    SurrealDB record IDs can contain Unicode delimiters, and Map subjects/details may
    contain arbitrary user text. Windows can otherwise choose a legacy charmap for
    stdout/stderr, which makes valid Map output fail during encoding.
    """
    reconfigure = getattr(stream, "reconfigure", None)
    if reconfigure is not None:
        reconfigure(encoding="utf-8", errors="backslashreplace")


def main(argv: list[str] | None = None) -> int:
    _configure_utf8(sys.stdout)
    _configure_utf8(sys.stderr)

    # Import after configuring stdio so every public CLI path inherits UTF-8.
    from map_entry import main as entry_main

    return entry_main(argv)


if __name__ == "__main__":
    raise SystemExit(main())
