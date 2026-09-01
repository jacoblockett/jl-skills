# JLS

JLS is the cross-platform `jl-skills` installer and catalog for independently released skills.

JLS does **not** contain skill source code, build skill runtimes, or publish skill archives. Each skill owns its source, tests, packaging, and releases in its own repository. JLS contains only references to those published skill manifests in `catalog.json`.

The first external skill is Map:

```text
jacoblockett/jls-map
```

## Build

Requires Bun 1.4.0.

```bash
bun install --frozen-lockfile
bun run build
bun run test:installer
```

`bun run build` builds the installer for `JL_SKILLS_BUILD_TARGET` (Windows x64 by default for local Windows development) and emits a target fragment manifest. GitHub Actions builds all eight supported installer targets and aggregates them into the publishable release manifest.

## Release shape

A JLS release contains only:

```text
jl-skills-windows-x64.exe
jl-skills-windows-arm64.exe
jl-skills-macos-x64
jl-skills-macos-arm64
jl-skills-linux-x64-gnu
jl-skills-linux-arm64-gnu
jl-skills-linux-x64-musl
jl-skills-linux-arm64-musl
manifest.json
```

`manifest.json` contains installer artifacts plus external skill-manifest references. Skill archives live in their owning repositories.
