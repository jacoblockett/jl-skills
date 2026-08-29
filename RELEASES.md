# jl-skills release channels

Status: accepted direction; implementation pending.

This file is the durable contract and running checklist for release/update work.

## Core model

- `jl-skills` and every skill have independent semantic versions.
- A stable GitHub release is a distribution snapshot, not a master semantic version.
- Stable update discovery uses only the latest normal GitHub release. Nightly never participates in stable update discovery.
- One stable release contains the current installer and every currently published skill package, regardless of which component changed.
- Updating the installer and updating a skill are independent operations unless that skill explicitly requires a newer installer capability.
- Repository work is performed directly on `main`; no feature-branch/PR workflow is assumed unless explicitly reintroduced later.

## Stable release identity

Use a calendar/timestamp tag rather than a synthetic distribution semver.

Tag format:

```text
YYYY.MM.DD-HHmmZ
```

Example:

```text
2026.08.29-0141Z
```

Use UTC. The release timestamp identifies only the distribution snapshot; component compatibility still uses each component's own semantic version.

## Stable release assets

Top-level assets:

```text
manifest.json
jl-skills.exe
map.zip
```

Additional skills follow the same `<skill>.zip` pattern. Each skill archive is the complete immutable snapshot of that released skill version.

The stable public update index is:

```text
https://github.com/jacoblockett/jl-skills/releases/latest/download/manifest.json
```

Nightly remains a prerelease so GitHub `latest` continues to resolve to the current stable snapshot.

## Stable `manifest.json`

The latest stable `manifest.json` is the sole remote index used for stable update discovery. `jl-skills` does not enumerate release history or download skill archives merely to discover versions.

Exact schema:

```json
{
  "format": 1,
  "installer": {
    "version": "0.6.0",
    "url": "https://github.com/jacoblockett/jl-skills/releases/download/2026.08.29-0141Z/jl-skills.exe",
    "sha256": "<64 lowercase hex characters>"
  },
  "skills": {
    "map": {
      "version": "0.3.0",
      "min_installer": "0.5.0",
      "url": "https://github.com/jacoblockett/jl-skills/releases/download/2026.08.29-0141Z/map.zip",
      "sha256": "<64 lowercase hex characters>"
    }
  }
}
```

Contract:

- `format` is the release-manifest schema version. The current format is `1`.
- `installer.version` is the newest stable installer semantic version in this snapshot.
- `installer.url` is the immutable URL for that snapshot's installer asset.
- `installer.sha256` verifies the downloaded installer.
- `skills` is keyed by stable skill name.
- `skills.<name>.version` is the newest stable semantic version of that skill in this snapshot.
- `skills.<name>.min_installer` is the minimum `jl-skills` semantic version capable of installing/updating that skill version.
- `skills.<name>.url` is the immutable URL for that snapshot's complete skill archive.
- `skills.<name>.sha256` verifies the downloaded skill archive.

Artifact URLs inside the manifest must point to the immutable timestamped release, not `releases/latest/...`. This keeps the manifest and the assets it describes bound to the same snapshot even if another stable release is published between manifest fetch and artifact download.

No distribution-level semantic version exists.

## Update discovery

### Installer

The running executable knows its own compiled semantic version.

To check for an installer update:

1. fetch the latest stable `manifest.json`;
2. compare the running installer semantic version with `manifest.installer.version`;
3. if the manifest version is newer, report that version as the available installer update;
4. if requested, download `manifest.installer.url`, verify `manifest.installer.sha256`, and replace only the installer.

A newer installer is never forced merely because it exists.

### Skills

The selected scope's filesystem remains the source of truth for installed skill state. An installed catalog skill reports its own name/version in its installed `SKILL.md` metadata.

To check for a skill update:

1. read the installed skill version from its installed `SKILL.md` metadata;
2. fetch/read the corresponding entry in the latest stable `manifest.json`;
3. compare the installed semantic version with `manifest.skills.<name>.version`;
4. if the manifest version is newer, report that version as the available skill update;
5. before installation, verify the running installer satisfies `manifest.skills.<name>.min_installer`;
6. if compatible and requested, download the skill archive, verify its SHA-256, and install that archive snapshot.

The manifest inside a skill archive is not used for update discovery. The archive is downloaded only when installing/updating that skill.

If installed version metadata is missing or malformed, presence may still be recognized but the installed version is unknown; never fabricate a version.

## Compatibility

Each released skill version declares a minimum installer version through `min_installer` in its source/package `manifest.json`. The build copies that value into the corresponding top-level release-manifest entry; it is authored once rather than maintained separately.

If the running installer satisfies that minimum, the skill may install/update even when a newer installer exists.

If the running installer is below the skill's minimum:

1. report the skill update and its installer requirement;
2. compare the latest stable installer version from the same release manifest;
3. report an available installer update if it can satisfy the requirement;
4. offer/allow the installer update, but never perform it silently;
5. block only the incompatible skill operation if the required installer capability is unavailable or the user declines the necessary installer update.

There is no general installer-first policy.

## Skill packages

Every skill source directory uses the contextual name:

```text
skills/<name>/manifest.json
```

That same file is included at the root of the released `<skill>.zip` and is the authoritative description of that immutable skill snapshot.

Required package-manifest fields:

- `format`: package-manifest schema version; currently `1`;
- `name`: stable skill identifier and archive basename;
- `version`: skill semantic version;
- `min_installer`: minimum compatible `jl-skills` semantic version;
- `description`: catalog/UI description;
- `skill_files`: files/directories copied into each selected harness's skill directory.

Optional install-semantics fields are present only when the skill needs them: `runtime`, `runtime_artifacts`, `runtime_files`, `runtime_cli`, `runtime_cli_destination`, `runtime_shared_files`, `cli_token`, `instruction_fragment`, and `generated_data`.

Map's exact source/package manifest is:

```json
{
  "format": 1,
  "name": "map",
  "version": "0.2.0",
  "min_installer": "0.5.0",
  "description": "Durable local graph of user intent, questions, decisions, ideas, facts, dependencies, and recovery state.",
  "skill_files": [
    "SKILL.md",
    "agents"
  ],
  "runtime": "rust",
  "runtime_artifacts": {
    "windows-x64": "runtime/windows-x64/map.exe"
  },
  "runtime_cli": "map",
  "runtime_cli_destination": "~/.jl-skills/map/bin/map.exe",
  "runtime_shared_files": {
    "schema.surql": "~/.jl-skills/map/schema.surql"
  },
  "cli_token": "JL_MAP_CLI",
  "instruction_fragment": "AGENTS.fragment.md",
  "generated_data": [
    {
      "path": ".map",
      "marker": "project.json"
    }
  ]
}
```

Map's released archive layout is exactly:

```text
map.zip
  manifest.json
  SKILL.md
  AGENTS.fragment.md
  agents/
    map-completion-auditor.toml
    map-context.toml
    map-discovery-reviewer.toml
    map-discovery.toml
    map-linguist.toml
    map-state-reviewer.toml
    map-state-writer.toml
  schema.surql
  runtime/
    windows-x64/
      map.exe
```

The archive contains only the installable snapshot. Map's `README.md`, `SPEC.md`, Cargo files, Rust source, tests, and other development material are not package payload.

The build validates manifest name/version metadata against `SKILL.md`, stages the declared payload, creates one `<skill>.zip`, hashes the archive, and derives the top-level release-manifest skill entry from that built archive and its package manifest.

For non-publishing local/CI builds, `JL_SKILLS_RELEASE_TAG` may be omitted and generated artifact URLs use the placeholder `dev` tag. Release workflows must set `JL_SKILLS_RELEASE_TAG` to the actual snapshot tag before publication.

The old embedded catalog remains only as a temporary installation path until items 5-6 switch the installer to downloaded archives and remove it. `build/map.exe` likewise remains temporarily for existing workflow compatibility; it is not part of the accepted stable release asset set.

## Nightly channel

`nightly` is one rolling GitHub prerelease for production-path testing.

It should:

- build only from `main`;
- run nightly on the agreed schedule and support manual force dispatch;
- skip compilation/publication when no build-relevant source changed since the last successful nightly, unless forced;
- build and test the same installer/skill packages used by stable releases;
- replace the rolling nightly assets instead of accumulating dated nightly releases;
- move the `nightly` tag only after a successful build/test/publication;
- never become GitHub's latest stable release.

## Workflow direction

Prefer one broadly named GitHub Actions workflow for build/release behavior unless a concrete limitation requires separation.

The repository is currently main-only development, so future workflow cleanup should not assume feature branches or pull requests. Remove the bespoke branch-hygiene workflow and any branch/PR-only machinery that no longer serves the current process.

Use GitHub-native repository features instead of bespoke workflow code where they are sufficient.

## Known current failure

The first release-automation Action run failed because Map declares `agents` as a directory in `skill_files`, the catalog generator recursively embeds the files under it, but the installer later tries to extract an asset literally named `map/agents`.

All Map Rust tests passed, the installer compiled, and updater-specific tests passed. The 15 installer regression failures are one packaging failure fanning out across install-dependent tests, not 15 unrelated defects.

Do not patch this directory bug in isolation if the independent skill-package redesign removes the embedded-catalog path entirely.

## Remaining work

Work through these sequentially and keep scope narrow.

- [x] **1. Update the durable release/update contract.** Record the accepted one-archive-per-skill model, sole stable update-index behavior, local-version sources, main-only repository workflow, and remove stale branch/PR assumptions.
- [x] **2. Lock the top-level stable `manifest.json` schema.** Use `format`, `installer`, and `skills` as documented above; bind artifact URLs to the immutable timestamped release; use the latest normal release only as the entry point for update discovery.
- [x] **3. Lock the per-skill package manifest and archive layout.** Source/package metadata is `skills/<name>/manifest.json`; the same file is packaged at archive root; Map's exact manifest and archive contents are documented above.
- [x] **4. Build skill archives as release artifacts.** The build stages each declared package payload, creates `<skill>.zip`, hashes it, and generates top-level `manifest.json` entries from the built archive. Workflow publication of those outputs is handled in item 7.
- [ ] **5. Change install/update logic to consume the release manifest and skill archives.** Compare running installer version and installed `SKILL.md` metadata against the release manifest, enforce only `min_installer`, then download/verify/install the requested archive.
- [ ] **6. Remove obsolete embedded-skill machinery.** Delete catalog/base64/extraction/update paths that no longer have a job once archive delivery is authoritative; let the current `map/agents` failure disappear through the architecture instead of patching it separately.
- [ ] **7. Simplify Actions around the final package model and main-only workflow.** Collapse the current workflows where practical, remove branch-hygiene/PR-only behavior, publish `jl-skills.exe`, `manifest.json`, and every `<skill>.zip`, retain clean build/test, change-aware rolling nightly publication, and explicit manual stable publication.
- [ ] **8. Repair and run tests around the final package model.** Preserve meaningful regression coverage and add focused coverage for archive installation, independent skill updates, and minimum-installer compatibility.
- [ ] **9. Publish/test nightly.** Produce the rolling nightly through the real release path and perform the planned production install/update/uninstall test with Codex.
- [ ] **10. Publish first stable snapshot.** After production validation, manually publish the first timestamp-tagged stable release and verify installer/skill update discovery through `releases/latest/download/manifest.json`.
