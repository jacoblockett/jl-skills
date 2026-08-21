"""Stable launcher used by the installed Map skill.

This module deliberately has no SurrealDB dependency. It locates the dedicated Map
runtime created by install.py and forwards all arguments to its map-state executable.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def runtime_root() -> Path:
    override = os.environ.get("JL_MAP_HOME")
    if override:
        return Path(override).expanduser().resolve()
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return base / "jl-map"


def executable() -> Path:
    venv_dir = runtime_root() / "venv"
    if os.name == "nt":
        return venv_dir / "Scripts" / "map-state.exe"
    return venv_dir / "bin" / "map-state"


def main(argv: list[str] | None = None) -> int:
    cli = executable()
    if not cli.exists():
        print(
            "Map runtime is not installed. Run the skill's install.py from the jl-skills repository first.",
            file=sys.stderr,
        )
        return 1
    return subprocess.call([str(cli), *(sys.argv[1:] if argv is None else argv)])


if __name__ == "__main__":
    raise SystemExit(main())
