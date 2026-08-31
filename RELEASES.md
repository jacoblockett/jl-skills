# jl-skills release channels

Status: Windows production-path acceptance has passed, but the first Stable release is blocked until the cross-platform target work in `To Do.md` is complete.

This file is the durable release/update contract. `To Do.md` owns the ordered implementation plan for unfinished cross-platform release work.

## Core model

- `jl-skills` and every skill have independent semantic versions.
- A stable GitHub release is a distribution snapshot, not a master semantic version.
- Stable update discovery uses only the latest normal GitHub release. Nightly never participates in stable update discovery.
- One stable snapshot contains the current installer and every currently published skill package for every required supported target.
- Updating the installer and updating a skill are independent operations unless that skill explicitly requires a newer installer capability.
- Repository work is performed directly on `main`; no feature-branch/PR workflow is assumed unless explicitly reintroduced later.
- Stable publication is not permitted until every required distribution target is built, tested, represented in the release manifest, and validated as defined in `To Do.md`.

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

## Release assets and naming

Release assets must identify their target operating system and architecture directly. A user must not need to infer compatibility from a file extension.

The required target matrix and exact naming policy are locked in `To Do.md` while the target-aware build/release implementation is developed.

Do not publish the first Stable release using the current ambiguous Windows-only asset names such as:

```text
jl-skills.exe
map.zip
```

Those names remain part of the current pre-stable/Nightly implementation only and are scheduled for replacement by explicit target-qualified names before Stable.

The stable public update index remains:

```text
https://github.com/jacoblockett/jl-skills/releases/latest/download/manifest.json
```

Nightly remains a prerelease so GitHub `latest` resolves only to a normal Stable snapshot once Stable exists.

## Release manifest

`manifest.json` is the sole remote index used for release/update discovery. `jl-skills` does not enumerate release history or download skill packages merely to discover versions.

The current pre-stable implementation uses release-manifest format 1 with one installer artifact and one archive per skill. That format is intentionally Windows-only and must not become the first Stable contract.

Before Stable, the release manifest will move to a new target-aware format as specified by `To Do.md`. The new format must retain these existing invariants:

- installer and skill semantic versions remain independent;
- every downloadable artifact has an immutable snapshot URL and SHA-256;
- skill entries retain `min_installer` compatibility metadata;
- artifact URLs point to the immutable timestamped snapshot, not a moving `releases/latest/...` asset URL;
- the running installer selects only an artifact compatible with its own canonical target;
- a platform-independent skill may explicitly publish a `portable` artifact;
- absence of a compatible target artifact is an error, never permission to download another architecture/OS/ABI.

No distribution-level semantic version exists.

## Update discovery

### Installer

The running executable knows its own compiled semantic version.

Stable installer update behavior remains:

1. fetch the latest stable `manifest.json`;
2. compare the running installer semantic version with the published installer version;
3. if the published version is newer, report it as available;
4. select only the artifact for the running installer's canonical target;
5. if requested, download that artifact, verify its SHA-256, and replace only the installer.

A newer installer is never forced merely because it exists.

### Skills

The selected scope's filesystem remains the source of truth for installed skill state. An installed catalog skill reports its own name/version in installed `SKILL.md` metadata.

Skill update behavior remains:

1. read the installed skill version from `SKILL.md` metadata;
2. fetch/read the corresponding entry in the latest stable `manifest.json`;
3. compare installed and published semantic versions;
4. before installation, verify the running installer satisfies the skill's `min_installer`;
5. select only the skill package for the running installer's canonical target, or an explicitly published `portable` package;
6. download only that package, verify its SHA-256, and install that snapshot.

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

The current Windows-only pre-stable package contains the Windows x64 runtime. Cross-platform work will replace the one-archive model for native skills with target-specific complete packages so a consumer downloads only the runtime for the current target.

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

During the current cross-platform work, Nightly remains the proving channel. Once the target-aware matrix is implemented, Nightly must require the same complete supported target set as Stable; it must not publish partial platform matrices.

## Workflow direction

Prefer one broadly named GitHub Actions workflow for build/release behavior unless a concrete platform limitation requires another shape.

The repository is main-only development. Workflow behavior must not assume feature branches or pull requests.

Build/test failures must prevent publication. Stable publication occurs only after all required build/test/aggregate gates succeed.

The current workflow is Windows x64 only. Replacing it with the complete target build/test matrix is release-blocking work tracked in `To Do.md`.

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

The first Stable release is blocked until every ordered item in `To Do.md` is complete, including:

- canonical target abstraction;
- target-qualified public artifact names;
- target-aware release manifest;
- per-target native skill packages;
- target-aware installer self-update and skill selection;
- complete native build/test matrix;
- consumer acceptance on every required target;
- OS-specific distribution-friction/signing review;
- mechanical verification that the full supported target set exists before publication.
