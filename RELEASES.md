# jl-skills release channels

Status: Windows production-path acceptance has passed, but the first Stable release is blocked until the cross-platform target work in `TODO.md` is complete.

This file is the durable release/update contract. `TODO.md` owns the ordered implementation plan for unfinished cross-platform release work.

## Core model

- `jl-skills` and every skill have independent semantic versions.
- A stable GitHub release is a distribution snapshot, not a master semantic version.
- Stable update discovery uses only the latest normal GitHub release. Nightly never participates in stable update discovery.
- One stable snapshot contains the current installer and every currently published skill package for every required supported target.
- Updating the installer and updating a skill are independent operations unless that skill explicitly requires a newer installer capability.
- Repository work is performed directly on `main`; no feature-branch/PR workflow is assumed unless explicitly reintroduced later.
- Stable publication is not permitted until every required distribution target is built, tested, represented in the release manifest, and validated as defined in `TODO.md`.

## Stable release identity

Use a calendar/timestamp tag rather than a synthetic distribution semver.

Tag format:

```text
YYYY.MM.DD-HHmmZ
```

Example:

```text
2026.08.31-0518Z
```

Use UTC. The release timestamp identifies only the distribution snapshot; component compatibility still uses each component's own semantic version.

Stable release tags are immutable.

## Required distribution targets

The canonical required target keys for the first Stable contract are exactly:

```text
windows-x64
windows-arm64
macos-x64
macos-arm64
linux-x64-gnu
linux-arm64-gnu
linux-x64-musl
linux-arm64-musl
```

These keys are public release-contract identifiers, not display aliases. They are used consistently by build metadata, release-manifest artifact maps, package selection, diagnostics, and public filenames.

Do not add 32-bit x86, ARM32, RISC-V, or another target without a concrete support requirement and an explicit contract update.

## Compiled target identity

Every compiled `jl-skills` executable has exactly one canonical target key embedded at build time.

That embedded target key is authoritative for installer self-update and skill-package artifact selection. The installer must not infer its release target from runtime `platform + arch` checks. Runtime inspection may be used only for diagnostics or consistency checks.

This is required in particular for Linux, where OS and architecture alone do not distinguish GNU/glibc from musl.

## Release assets and naming

Release assets must identify their target operating system and architecture directly. Linux assets also identify the ABI. A user must not need to infer compatibility from a file extension.

Installer asset names are exactly:

```text
jl-skills-windows-x64.exe
jl-skills-windows-arm64.exe
jl-skills-macos-x64
jl-skills-macos-arm64
jl-skills-linux-x64-gnu
jl-skills-linux-arm64-gnu
jl-skills-linux-x64-musl
jl-skills-linux-arm64-musl
```

Map package asset names are exactly:

```text
map-windows-x64.zip
map-windows-arm64.zip
map-macos-x64.zip
map-macos-arm64.zip
map-linux-x64-gnu.zip
map-linux-arm64-gnu.zip
map-linux-x64-musl.zip
map-linux-arm64-musl.zip
```

The filename itself identifies compatibility. `.exe` is only the Windows executable suffix and is not the compatibility signal.

Do not publish the first Stable release using ambiguous assets such as:

```text
jl-skills.exe
map.zip
```

Those names remain part of the current pre-stable/Nightly implementation only and are replaced when release-manifest format 2 becomes active.

The stable public update index remains:

```text
https://github.com/jacoblockett/jl-skills/releases/latest/download/manifest.json
```

Nightly remains a prerelease so GitHub `latest` resolves only to a normal Stable snapshot once Stable exists.

## Release manifest

`manifest.json` is the sole remote index used for release/update discovery. `jl-skills` does not enumerate release history or download skill packages merely to discover versions.

The current pre-stable implementation uses release-manifest format 1 with one installer artifact and one archive per skill. That format is intentionally Windows-only and must not become the first Stable contract.

The first Stable release uses release-manifest format 2. Format 2 has this exact structural contract:

```json
{
  "format": 2,
  "installer": {
    "version": "0.8.0",
    "artifacts": {
      "windows-x64": {
        "url": "https://github.com/jacoblockett/jl-skills/releases/download/<snapshot>/jl-skills-windows-x64.exe",
        "sha256": "<64 lowercase hex characters>"
      }
    }
  },
  "skills": {
    "map": {
      "version": "0.5.0",
      "min_installer": "0.8.0",
      "artifacts": {
        "windows-x64": {
          "url": "https://github.com/jacoblockett/jl-skills/releases/download/<snapshot>/map-windows-x64.zip",
          "sha256": "<64 lowercase hex characters>"
        }
      }
    }
  }
}
```

The example shows one artifact entry only to illustrate the shape. A publishable native release must satisfy the complete target-set rules below.

Format-2 invariants:

- `format` is exactly `2`.
- Installer and skill semantic versions remain independent plain semantic versions.
- `installer.artifacts` is keyed by canonical target key and never uses `portable`.
- Each skill entry retains `version` and `min_installer`.
- Each skill `artifacts` map is keyed by canonical target key and may additionally use the reserved key `portable` only for an explicitly platform-independent package.
- Every artifact contains exactly the immutable snapshot URL used for that artifact plus its SHA-256.
- Artifact URLs point to the immutable timestamped snapshot, not a moving `releases/latest/...` asset URL.
- The installer resolves an artifact by exact canonical target key first. For skills only, if that exact key is absent, an explicitly published `portable` artifact may be used.
- Absence of a compatible exact-target or allowed portable skill artifact is an incompatibility error. Another OS, architecture, or ABI is never a fallback.
- Unrelated artifact entries do not change the running installer's embedded target identity.

No distribution-level semantic version exists.

## Skill package target policy

Native skills are packaged per canonical target. Each target package is complete for that target and contains common skill/harness/support files plus only the native runtime payload required by that target.

Map is a native skill and therefore publishes one Map archive for each required target. A Map package must never contain runtimes for foreign targets merely to make the ZIP universal.

A genuinely platform-independent skill may publish one `portable` artifact instead of duplicating identical archives across all targets. `portable` is a release-manifest artifact key, not a ninth canonical machine target.

A package that contains target-specific native runtime content is not portable.

## Update discovery

### Installer

The running executable knows its own compiled semantic version and embedded canonical target.

Stable installer update behavior remains:

1. fetch the latest stable `manifest.json`;
2. compare the running installer semantic version with the published installer version;
3. if the published version is newer, report it as available;
4. select only `installer.artifacts[currentTarget]`;
5. if that artifact is absent, report the release as incompatible with the running target;
6. if requested, download that artifact, verify its SHA-256, and replace only the installer.

A newer installer is never forced merely because it exists.

### Skills

The selected scope's filesystem remains the source of truth for installed skill state. An installed catalog skill reports its own name/version in installed `SKILL.md` metadata.

Skill update behavior remains:

1. read the installed skill version from `SKILL.md` metadata;
2. fetch/read the corresponding entry in the latest stable `manifest.json`;
3. compare installed and published semantic versions;
4. before installation, verify the running installer satisfies the skill's `min_installer`;
5. select `skill.artifacts[currentTarget]` when present, otherwise the explicitly published `skill.artifacts.portable` when present;
6. fail clearly if neither compatible artifact exists;
7. download only the selected package, verify its SHA-256, and install that snapshot.

The manifest inside a skill archive is not used for update discovery. The archive is downloaded only when installing/updating that skill.

If installed version metadata is missing or malformed, presence may still be recognized but the installed version is unknown; never fabricate a version.

## Compatibility

Each released skill version declares a minimum installer version through `min_installer` in its source/package `manifest.json`. The build derives the release-manifest compatibility entry from that authored value.

If the running installer satisfies that minimum, the skill may install/update even when a newer installer exists.

If the running installer is below the skill's minimum:

1. report the skill update and its installer requirement;
2. compare the latest stable installer version from the same release manifest;
3. report an available compatible installer update if one exists for the current target;
4. offer/allow the installer update, but never perform it silently;
5. block only the incompatible skill operation if the required installer capability is unavailable or declined.

There is no general installer-first policy.

## Skill package model

Every skill source directory uses:

```text
skills/<name>/manifest.json
```

The package manifest is the authoritative description of that immutable skill snapshot.

Current required fields are:

- `format`;
- `name`;
- `version`;
- `min_installer`;
- `description`;
- `skill_files`.

Optional install-semantics fields are present only when needed, including:

- `harness_resources`;
- `runtime`;
- `runtime_artifacts`;
- `runtime_files`;
- `runtime_cli`;
- `cli_token`;
- `instruction_fragment`;
- `generated_data`.

Skill packages do not choose absolute or scope-independent runtime destinations. Runtime/tooling is installed under the selected scope's neutral directory:

```text
user scope       ~/.jl-skills/<skill>/
project/custom   <scope>/.jl-skills/<skill>/
```

Harness-specific resources are declared by the skill package but their installation locations are owned by harness adapters.

Map currently declares native Codex and Claude subagent resources separately and keeps its runtime/support files outside harness skill-discovery directories.

Current Map semantic/package version is `0.4.0`; current installer version is `0.7.0`. Map requires installer `0.7.0`.

The current Windows-only pre-stable package contains the Windows x64 runtime. Cross-platform work replaces the one-archive model for native skills with target-specific complete packages so a consumer downloads only the runtime for the current target.

Map's development-only material (`README.md`, `SPEC.md`, Cargo files, Rust source, tests) is not release-package payload.

Package generation validates manifest name/version metadata against `SKILL.md`, validates every declared file, packages the declared snapshot, hashes it, and derives release metadata from the built artifact.

## Scope-local native tooling

Native skill tooling is scope-local, not globally shared across installations.

For Map today:

```text
user scope
  ~/.jl-skills/map/bin/map.exe
  ~/.jl-skills/map/schema.surql

project/custom scope
  <scope>/.jl-skills/map/bin/map.exe
  <scope>/.jl-skills/map/schema.surql
```

On non-Windows targets the runtime executable has no `.exe` suffix.

Multiple harness integrations for the same skill inside one scope share that scope's tooling. Different scopes do not share runtime binaries.

Removing the final harness integration for a skill at a scope removes its scope-local installed tooling. Skill-generated project data remains a separate lifecycle concern.

## Nightly channel

`nightly` is one rolling GitHub prerelease for production-path testing.

It must:

- build only from `main`;
- run automatically at 2:00 AM Eastern and support manual dispatch;
- skip compilation/publication when no build-relevant source changed since the previous successful nightly unless forced;
- build and test the same artifact model intended for Stable;
- replace the rolling Nightly assets rather than accumulate dated Nightly releases;
- move the `nightly` tag only after successful build/test/publication;
- never become GitHub's latest normal Stable release.

Once format 2 is active, Nightly requires the same complete supported target set as Stable and must not publish a partial matrix.

## Publication completeness gate

Nightly and Stable publication are both mechanically blocked unless all of the following are true in the same release attempt:

1. every required target build/test job succeeded;
2. the aggregator received an installer artifact for all eight canonical targets;
3. the aggregator received a package artifact for all eight canonical targets for every native published skill;
4. every portable published skill has its declared `portable` package artifact;
5. every expected release asset has a computed SHA-256 and an immutable release URL matching its actual target-qualified filename;
6. the generated format-2 manifest contains the complete expected installer artifact set and complete compatible artifact coverage for every published skill;
7. the aggregator independently compares the produced target keys against the canonical required target set rather than trusting matrix job count alone.

Failure of any condition stops publication. The workflow must not create/advance a Stable snapshot, replace Nightly assets, or advance the `nightly` tag with a partial or failed target set.

Additional targets may be added only by updating the canonical contract. Missing required targets are always fatal.

## Workflow direction

Prefer one broadly named GitHub Actions workflow for build/release behavior unless a concrete platform limitation requires another shape.

The repository is main-only development. Workflow behavior must not assume feature branches or pull requests.

Build/test failures must prevent publication. Stable publication occurs only after all required build/test/aggregate gates succeed.

The current workflow is Windows x64 only. Replacing it with the complete target build/test matrix is release-blocking work tracked in `TODO.md`.

## Current acceptance state

Windows x64 production-path acceptance has passed for installer `0.7.0` / Map `0.4.0`:

- project-scope install/uninstall worked against real filesystem paths;
- user-scope install/uninstall worked against the real user home;
- Codex skill files land under `.agents/skills/map`;
- Codex native Map subagents land under `.codex/agents` rather than inside the skill directory;
- scope-local Map runtime/support tooling is installed and removed with the final harness integration;
- project and user scopes do not share Map runtime binaries;
- generated `.map` semantic state is separate from ordinary uninstall;
- empty `AGENTS.md` files and harness parent directories are retained on uninstall;
- generic redundant install/update/uninstall outro messages have been removed;
- the rolling Nightly workflow has been exercised repeatedly through real release downloads.

This acceptance is sufficient confidence in the Windows lifecycle implementation, but it is not sufficient to publish Stable because the required Linux/macOS/ARM/ABI release targets are not yet implemented and validated.

## Stable gate

The first Stable release is blocked until every ordered item in `TODO.md` is complete, including:

- canonical target abstraction;
- target-qualified public artifact names;
- target-aware release manifest;
- per-target native skill packages;
- target-aware installer self-update and skill selection;
- complete native build/test matrix;
- consumer acceptance on every required target;
- OS-specific distribution-friction/signing review;
- mechanical verification that the full supported target set exists before publication.
