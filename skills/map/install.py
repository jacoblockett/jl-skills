"""Install the Map skill into the shared user Agent Skills directory.

The source of truth remains this repository. Installation creates a directory link at
~/.agents/skills/map so Codex and other Agent-Skills-compatible harnesses can discover
SKILL.md, then creates a dedicated runtime virtual environment outside the repository.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import venv
from pathlib import Path


SKILL_NAME = "map"
SOURCE = Path(__file__).resolve().parent
TARGET = Path.home() / ".agents" / "skills" / SKILL_NAME


def runtime_root() -> Path:
    override = os.environ.get("JL_MAP_HOME")
    if override:
        return Path(override).expanduser().resolve()
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return base / "jl-map"


def same_location(a: Path, b: Path) -> bool:
    try:
        return a.samefile(b)
    except (FileNotFoundError, OSError):
        return False


def create_directory_link(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)

    if target.exists() or target.is_symlink():
        if same_location(source, target):
            return
        raise RuntimeError(
            f"Refusing to replace existing skill path: {target}\n"
            "Move/remove it explicitly, then rerun the installer."
        )

    if os.name != "nt":
        target.symlink_to(source, target_is_directory=True)
        return

    # Prefer a real symlink when Windows Developer Mode/permissions allow it.
    try:
        target.symlink_to(source, target_is_directory=True)
        return
    except OSError:
        pass

    # Directory junctions do not normally require elevation and are sufficient for
    # skill discovery. `mklink` is a cmd built-in, so invoke it through cmd.exe.
    result = subprocess.run(
        ["cmd.exe", "/d", "/c", "mklink", "/J", str(target), str(source)],
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "Could not create the Map skill directory link.\n"
            f"stdout: {result.stdout.strip()}\n"
            f"stderr: {result.stderr.strip()}"
        )


def runtime_python(venv_dir: Path) -> Path:
    if os.name == "nt":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def install_runtime() -> Path:
    root = runtime_root()
    venv_dir = root / "venv"
    root.mkdir(parents=True, exist_ok=True)

    if not runtime_python(venv_dir).exists():
        venv.EnvBuilder(with_pip=True).create(venv_dir)

    py = runtime_python(venv_dir)
    subprocess.run(
        [str(py), "-m", "pip", "install", "--disable-pip-version-check", "-e", str(SOURCE)],
        check=True,
    )
    return venv_dir


def verify_install(venv_dir: Path) -> None:
    skill_file = TARGET / "SKILL.md"
    if not skill_file.is_file():
        raise RuntimeError(f"Installed skill is missing {skill_file}")

    if os.name == "nt":
        cli = venv_dir / "Scripts" / "map-state.exe"
    else:
        cli = venv_dir / "bin" / "map-state"
    if not cli.exists():
        raise RuntimeError(f"Installed runtime is missing {cli}")

    subprocess.run([str(cli), "--help"], check=True, stdout=subprocess.DEVNULL)


def main() -> int:
    try:
        if not (SOURCE / "SKILL.md").is_file():
            raise RuntimeError(f"Source skill is missing {SOURCE / 'SKILL.md'}")

        create_directory_link(SOURCE, TARGET)
        venv_dir = install_runtime()
        verify_install(venv_dir)

        print(f"Map skill source : {SOURCE}")
        print(f"Agent skill path : {TARGET}")
        print(f"Runtime          : {venv_dir}")
        print("Installed. Restart/reload the agent harness if it caches skill discovery.")
        return 0
    except Exception as exc:
        print(f"map install: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
