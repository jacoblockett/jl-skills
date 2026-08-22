# jl-skill installer

`jl-skill` is implemented in Bun/TypeScript and distributed as one standalone executable.

The interactive setup flow uses `@clack/prompts` 1.7.0, the same prompt package used by current `create-vite`.

## Build

```bash
bash scripts/build-windows.sh
```

Build-time requirements:

- npm, used only to bootstrap pinned local build dependencies
- Bun 1.3.14, installed locally by the build script

Consumer requirement:

- none for the installer itself; `jl-skill.exe` is standalone

Map currently provisions its own scope-local Python 3.11+ virtual environment because Map remains a Python prototype.

## Local regression test

Do not test inside a working `jl-skills` checkout. Use a clean clone under `C:\Programming\jl-skill-test` and run:

```bash
bash scripts/test-installer.sh /c/Programming/jl-skill-test
```

The regression verifies standalone build identity, Bun-only implementation, Map project installation, Python runtime isolation, Map initialization and validation, receipt isolation, idempotent managed instructions, and no unintended Claude project installation during a Codex-only install. It then opens the real Clack wizard for a visual keyboard interaction check.

Windows CI runs the same automated regression with the interactive wizard skipped.
