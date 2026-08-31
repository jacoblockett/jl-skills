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
- the current pre-matrix build remains intentionally restricted to Windows x64 until step 7;
- Bun is pinned to `1.4.0` in both project metadata and GitHub Actions;
- target-aware release-manifest/package selection remains intentionally deferred to steps 3 and 6 rather than changing format-1 behavior early.

### 3. [ ] Move the release manifest to a target-aware schema

Introduce a new release-manifest format rather than changing format-1 semantics in place.

The installer entry must expose a version plus an artifact map keyed by target.

Each skill entry must expose a version, minimum installer version, and artifact map keyed by target, with optional `portable` fallback for skills that contain no native platform-specific payload.

Every artifact entry retains an immutable release URL and SHA-256.

### 4. [ ] Package native skills per target

Do not place every platform runtime into one universal skill ZIP.

For a native skill such as Map, build one complete installable package per target. Each package contains common skill/harness/support files plus only the runtime for that target.

A user on one target must never download unused runtimes for other targets.

### 5. [ ] Make build/release output names explicit

Apply the canonical target name to:

- installer binaries;
- skill archives;
- native runtime files inside packages where appropriate;
- GitHub Actions artifacts;
- GitHub Release assets;
- generated manifest URLs.

Do not publish ambiguous assets such as bare `jl-skills.exe` or `map.zip` once the target-aware format is active.

### 6. [ ] Make install/update selection target-aware

The running installer must select exactly its own target artifact for:

- installer self-update;
- skill installation;
- skill update;
- native runtime provisioning.

Use `portable` only when the skill explicitly publishes that fallback.

If the current target has no compatible artifact, fail clearly. Never fall back to a different OS, architecture, or ABI.

### 7. [ ] Replace the Windows-only workflow with a native build/test matrix

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

### 8. [ ] Run consumer acceptance on every target

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

### 9. [ ] Validate OS distribution friction

Test the actual downloadable release assets as consumers receive them.

At minimum:

- macOS: Gatekeeper behavior, and whether signing/notarization is required for acceptable installation;
- Windows: SmartScreen/AuthentiCode behavior and whether signing is required for acceptable installation;
- Linux: executable permissions and glibc/musl compatibility.

Treat required signing/notarization work as a Stable blocker if unsigned artifacts create unacceptable normal-user friction.

### 10. [ ] Publish Stable only after complete validation

Only after steps 1-9 pass should the first stable snapshot be published.

Stable publication must enforce the complete required target set rather than relying on a manual checklist or memory.

The existing rolling Nightly remains the production-test channel while this work is underway.
