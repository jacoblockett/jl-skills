# jl-skills release channels

Status: accepted direction; implementation pending.

This file is the durable contract and running checklist for release/update work.

## Core model

- `jl-skills` and every skill have independent semantic versions.
- A stable GitHub release is a distribution snapshot, not a master semantic version.
- Stable update discovery uses only the latest normal GitHub release. Nightly never participates in stable update discovery.
- One stable release contains the current installer and every currently published skill package, regardless of which component changed.
- Updating the installer and updating a skill are independent operations unless that skill explicitly requires a newer installer capability.

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

Use UTC. This follows Calendar Versioning conventions for date-based release identity while keeping tags chronologically sortable and unambiguous. The release timestamp is only snapshot identity; component compatibility still uses each component's own semantic version.

## Stable release assets

Preferred top-level assets:

```text
manifest.json
jl-skills.exe
map.zip
```

Additional skills follow the same `<skill>.zip` pattern.

`manifest.json` is the authoritative release index. It should contain, at minimum:

- installer semantic version and artifact URL/hash;
- each released skill's semantic version and package URL/hash;
- each skill's minimum supported installer version.

The stable public index should be reachable through GitHub's latest normal release, e.g.:

```text
https://github.com/jacoblockett/jl-skills/releases/latest/download/manifest.json
```

Nightly must remain a prerelease so GitHub `latest` continues to mean the current stable snapshot.

## Skill packages

Skills must be independently downloadable/installable rather than being version-owned by the installer binary.

A skill package should contain the complete installable skill payload, including its own manifest and any runtime/support files it needs. For Map this includes the skill instructions, bundled specialist agents, instruction fragment, schema/runtime support, and native runtime.

Preferred package shape:

```text
map.zip
  manifest.json
  SKILL.md
  AGENTS.fragment.md
  agents/
  schema.surql
  runtime/
```

The exact internal layout may be simplified during implementation if an equally accurate smaller structure exists.

## Update behavior

### Installer

- The running installer compares its own semantic version with the installer version in the latest stable `manifest.json`.
- If a newer installer exists, report that an update is available.
- Do not force the update merely because it exists.
- If the user requests the installer update, fetch, verify, and replace only the installer.

### Skills

- The installer compares each installed skill's semantic version with that skill's version in the latest stable `manifest.json`.
- If a newer skill exists, report that an update is available.
- If the user requests the skill update, download and verify that skill's package and update only that skill.
- A newer skill must not require the installer itself to be current merely because the installer is older.

### Compatibility

Each skill declares a minimum installer version, e.g.:

```text
min_installer: 0.5.0
```

If the running installer satisfies the minimum, the skill may install/update even when a newer installer exists.

If the running installer is below the skill's minimum:

1. report the compatibility requirement;
2. check the latest stable installer version;
3. report the available installer update if it can satisfy the requirement;
4. offer/allow the installer update, but do not perform it silently;
5. block only the incompatible skill operation if the required installer capability is unavailable or the user declines the necessary installer update.

No general installer-first policy exists.

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

Prefer one broadly named GitHub Actions workflow for build/release behavior rather than separate granular workflows unless a concrete limitation requires separation.

That workflow may branch behavior by event:

- pull request: build/test and upload production-test artifacts only;
- nightly schedule: change-aware rolling prerelease publication;
- manual dispatch: production test or stable release publication as explicitly selected.

Use GitHub-native repository features instead of bespoke workflow code where they are sufficient. In particular, prefer GitHub's native delete-branch-on-merge setting over a custom branch-hygiene workflow.

## Known current failure

The first PR Action run failed because Map declares `agents` as a directory in `skill_files`, the catalog generator recursively embeds the files under it, but the installer later tries to extract an asset literally named `map/agents`.

All Map Rust tests passed, the installer compiled, and updater-specific tests passed. The 15 installer regression failures are one packaging failure fanning out across install-dependent tests, not 15 unrelated defects.

Do not patch this directory bug in isolation if the independent skill-package redesign removes the embedded-catalog path entirely.

## Remaining work

Work through these sequentially and keep scope narrow.

- [ ] **1. Finalize package/update contract.** Confirm the exact minimal `manifest.json` schema, skill package manifest schema, package layout, `min_installer` semantics, stable/latest lookup behavior, and whether source `skills/<name>/jl-skill.json` should also become simply `manifest.json`.
- [ ] **2. Simplify Actions design.** Collapse the current four workflow files into one broad workflow if practical; remove bespoke branch-hygiene automation; enable GitHub-native delete-branch-on-merge; retain PR build/test artifacts, change-aware rolling nightly publication, and explicit manual stable publication.
- [ ] **3. Decouple skill delivery from installer binaries.** Replace the installer's embedded skill-version ownership with independently downloadable, hash-verified skill packages from the selected release manifest. Preserve existing install/update/uninstall scope semantics and managed instruction behavior.
- [ ] **4. Implement compatibility-aware updates.** Installer and skills independently report available updates; enforce only per-skill `min_installer` requirements; never require an installer update solely because a newer installer exists.
- [ ] **5. YAGNI cleanup around the changed architecture.** Remove bespoke catalog/base64/extraction/update code that no longer has a job; consolidate duplicate plain-semver/platform helpers where doing so is smaller and clearer; avoid new utility frameworks or dependencies without a concrete need.
- [ ] **6. Repair tests around the final package model.** Replace/fix the current `map/agents` failure through the chosen package architecture, preserve existing regression coverage, and add focused tests for independent skill updates and minimum-installer compatibility.
- [ ] **7. Re-run PR production-source build.** Require Map tests, installer tests, packaging, and artifact generation to pass on a clean Windows Actions runner. Inspect produced artifacts rather than only trusting exit status.
- [ ] **8. Merge release work and clean branches.** Merge only after the revised PR is green, then remove obsolete feature branches so `main` is authoritative.
- [ ] **9. Publish/test nightly.** Produce the rolling nightly through the real release path and perform the planned production install/update/uninstall test with Codex.
- [ ] **10. Publish first stable snapshot.** After production validation, manually publish the first timestamp-tagged stable release and verify both installer and skill update discovery against `releases/latest/download/manifest.json`.
