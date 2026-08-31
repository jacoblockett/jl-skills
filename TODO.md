# jl-skills to do

Status: current release-blocking plan.

No stable release should be published until the required cross-platform installer and skill-runtime targets below are built, tested, packaged, and selected correctly at runtime.

## Required distribution targets

Public target keys:

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

Do not add 32-bit x86, ARM32, RISC-V, or other targets without a concrete user/support requirement.

## Public artifact naming

Release asset names must identify OS and architecture directly; users must not have to infer compatibility from a file extension.

Installer examples:

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

Native skill-package examples:

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

A platform-independent skill may use one `portable` artifact instead of duplicating an identical package per target.

## Work order

### 1. [x] Lock the target and release contract

Update `RELEASES.md` and `INSTALLER_SPEC.md` to make the eight target keys, explicit artifact naming, per-target package policy, platform-aware installer/skill selection, and the stable-release completeness gate authoritative.

Stable must be mechanically blocked unless every required target is present and successful.

### 2. [x] Introduce one canonical target abstraction

Replace scattered OS/architecture checks with one target model that owns at least:

```text
key
os
arch
abi
executable suffix
Bun compile target
Rust target triple
```

The compiled installer should know its own canonical target at build time.

Upgrade the pinned Bun version to a current pinned release that supports the complete required matrix, including Windows ARM64. Do not use an unpinned `latest` dependency/toolchain policy.

Completed implementation:

- `src/targets.ts` owns the eight canonical target records and toolchain facts.
- the build selects a canonical target and injects it into the standalone installer as `JL_SKILLS_COMPILED_TARGET`;
- standalone installer startup validates that the compiled target was injected and is supported;
- matrix builds pass the canonical target explicitly rather than inferring Linux ABI from the host;
- Bun is pinned to `1.4.0` in both project metadata and GitHub Actions.

### 3. [x] Move the release manifest to a target-aware schema

Introduce a new release-manifest format rather than changing format-1 semantics in place.

The installer entry must expose a version plus an artifact map keyed by target.

Each skill entry must expose a version, minimum installer version, and artifact map keyed by target, with optional `portable` fallback for skills that contain no native platform-specific payload.

Every artifact entry retains an immutable release URL and SHA-256.

Completed implementation:

- `scripts/build.ts` emits release-manifest format 2 with installer and skill `artifacts` maps;
- `src/installer-updater.ts` parses only format 2 and validates canonical target keys, SHA-256 values, installer non-portability, and optional skill `portable` artifacts;
- format 1 is obsolete and no longer emitted by the build;
- release fixtures and updater regression coverage use the format-2 shape;
- each matrix target emits a single-target format-2 fragment;
- `scripts/aggregate-release.ts` combines only a complete validated target set into the publishable format-2 manifest.

### 4. [x] Package native skills per target

Do not place every platform runtime into one universal skill ZIP.

For a native skill such as Map, build one complete installable package per target. Each package contains common skill/harness/support files plus only the runtime for that target.

A user on one target must never download unused runtimes for other targets.

Completed implementation:

- Map source metadata declares the exact native runtime location for all eight canonical targets;
- build validation requires a complete native runtime declaration matching the canonical target naming contract;
- a native package is staged for exactly one build target and its packaged `manifest.json` contains only that target's runtime entry;
- no native package copies foreign-target runtimes;
- non-native skills are packaged once under the reserved `portable` artifact key, currently emitted by the `windows-x64` package job;
- Map package version is `0.5.0`; its minimum installer remains `0.7.0` because the target-specific package payload does not require a newer package-install capability;
- the native matrix produces one Map package for every required target.

### 5. [x] Make build/release output names explicit

Apply the canonical target name to:

- installer binaries;
- skill archives;
- native runtime files inside packages where appropriate;
- GitHub Actions artifacts;
- GitHub Release assets;
- generated manifest URLs.

Do not publish ambiguous assets such as bare `jl-skills.exe` or `map.zip` once the target-aware format is active.

Completed implementation:

- target naming helpers in `src/targets.ts` own installer, skill archive, and runtime artifact names;
- every matrix target emits its exact target-qualified installer and native skill archive names;
- Map runtime package paths use `runtime/<target>/map[.exe]`;
- format-2 manifest URLs use the same target-qualified names;
- GitHub Actions artifacts and GitHub Release assets use target-qualified names;
- build cleanup removes the obsolete bare `jl-skills.exe` and `map.zip` outputs;
- release/package regression fixtures expect qualified filenames.

### 6. [x] Make install/update selection target-aware

The running installer must select exactly its own target artifact for:

- installer self-update;
- skill installation;
- skill update;
- native runtime provisioning.

Use `portable` only when the skill explicitly publishes that fallback.

If the current target has no compatible artifact, fail clearly. Never fall back to a different OS, architecture, or ABI.

Completed implementation:

- installer self-update selects only `installer.artifacts[compiledTarget]` and fails when that exact target is absent;
- skill install/update selects `skill.artifacts[compiledTarget]` first and uses only an explicitly published `portable` artifact as fallback;
- downloaded native packages are rejected unless their packaged runtime metadata contains exactly the selected canonical target runtime;
- runtime provisioning and runtime executable suffix selection use the build-time embedded canonical target rather than host OS/architecture heuristics;
- target-qualified installer self-update/uninstall management validates the running executable against the canonical installer asset name;
- unit coverage exercises exact-target selection, missing-target failure, portable fallback, and foreign-runtime-package rejection;
- explicit target arguments exist only for non-standalone unit coverage; production selection defaults to the compiled target embedded in the executable.

### 7. [x] Replace the Windows-only workflow with a native build/test matrix

Build and test the required targets on appropriate runners/environments.

Expected release shape:

```text
prepare
  -> target build/test matrix
  -> aggregate/validate
  -> publish
```

Use a complete matrix covering the eight required targets. Keep failures visible across the matrix rather than hiding later failures after the first target breaks.

The aggregate/publish job must depend on every required target succeeding and must independently assert that the expected complete target set is present.

Nightly and Stable must never publish a partial target set.

Completed implementation:

- `.github/workflows/build.yml` uses an eight-target native build/test matrix with `fail-fast: false`;
- Windows x64 uses `windows-2025`, Windows ARM64 uses the GA `windows-11-vs2026-arm` image, macOS uses native Intel/ARM runners, and Linux uses native x64/ARM64 Ubuntu runners;
- GNU and musl Map builds use native Ubuntu architecture runners; musl compilation uses `musl`/`musl-tools` plus target-specific Rust linker configuration, while Bun musl installer execution is validated in pinned `oven/bun:1.4.0-alpine` with its musl-compatible `libgcc`/`libstdc++` runtime;
- every target runs target-specific Map Rust tests, builds its target-qualified installer/package, launches the compiled installer and Map runtime in the appropriate consumer environment, and runs target-contract tests;
- Windows x64 additionally retains the established full installer regression suite;
- every target uploads an isolated `target-<key>` artifact containing its installer, skill package fragment, and target manifest fragment;
- `scripts/aggregate-release.ts` independently compares downloaded artifacts against all eight canonical targets and the source skill catalog, verifies exact filenames/URLs/SHA-256 values/version metadata, and rejects missing/extra/foreign target coverage;
- manual `build` produces the same verified aggregate release bundle without publishing it;
- Nightly and Stable publication occur only after the complete aggregate gate succeeds.

### 8. [x] Run consumer acceptance on every target

For every required target, verify the actual release artifact can:

- launch;
- discover/select the correct target;
- install Map;
- place harness-native resources correctly;
- execute the target-specific Map runtime;
- update correctly;
- uninstall correctly;
- avoid downloading/installing foreign-platform binaries.

Where scope semantics apply, retain the existing project/custom/user scope lifecycle guarantees.

Completed and empirically passed in GitHub Actions run `33438373610` on commit `deb92464e50d9dabe0d1916bcc761f670430912e`:

- all eight target jobs completed successfully;
- `tests/consumer-acceptance.test.ts` drives the compiled target-qualified installer against that target job's real `manifest.json` and Map package through a local release server;
- Windows x64 runs the established full installer regression suite, which includes consumer acceptance;
- the other non-musl targets run focused consumer acceptance directly;
- both musl targets execute launch and consumer acceptance inside pinned Alpine with musl-compatible `libgcc`/`libstdc++`;
- project/custom-path acceptance installs Map into both Codex and Claude, verifies native harness resources and exact-target runtime metadata, executes the installed Map runtime, forces and repairs a stale skill/runtime update, and preserves unrelated plus `.map` generated data;
- staged Codex then Claude uninstall proves scope-local tooling remains until the final harness integration is removed and generated data survives ordinary uninstall;
- user-scope acceptance verifies user-local harness resources/tooling and proves the invocation project is untouched;
- the target package fixture contains only the current target's release assets, and installed package/runtime assertions reject foreign-target runtime provisioning.

### 9. [x] Keep distribution qualification intentionally simple

The fresh native build/test environments are the release qualification boundary. Do not add a second post-publication matrix that downloads and re-runs the same artifacts.

Accepted policy:

- the eight-target build matrix plus consumer acceptance is sufficient release qualification;
- `scripts/aggregate-release.ts` must still verify the complete target set, filenames, release URLs, versions, and SHA-256 values before publication;
- macOS and Windows releases remain intentionally unsigned;
- Gatekeeper, SmartScreen, Smart App Control, and other unsigned-binary friction are accepted and may be handled through documentation/user issues rather than a release-blocking audit;
- raw macOS/Linux executable downloads may require `chmod +x` before launch;
- Bun musl installers require a musl environment with compatible `libgcc` and `libstdc++`;
- user-reported platform-specific issues can be handled through normal issue reports instead of duplicating CI after publication.

The former post-download distribution audit, validation receipt, and Nightly promotion machinery were removed as unnecessary complexity.

### 10. [ ] Publish the first Stable snapshot

Stable is now intentionally straightforward:

1. run the same complete eight-target build/test/consumer matrix on `main`;
2. aggregate and independently verify the complete release bundle;
3. publish that verified bundle under a new immutable UTC timestamp tag.

No prior Nightly validation receipt is required and Stable does not depend on a second post-publication test pass.

Nightly uses the same verified build path but publishes to the rolling `nightly` prerelease/tag. Manual `build` stops after producing the verified workflow artifact.
