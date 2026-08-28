# jl-skills release channels

Status: accepted release/update channel contract.

## Stable channel

Stable releases are the only source used by jl-skills update discovery.

A stable release:

- is tagged `v<MAJOR>.<MINOR>.<PATCH>`;
- is a normal GitHub release, never a prerelease;
- contains every currently published native binary, regardless of which component changed;
- contains `jl-skills-manifest.json` as the authoritative machine-readable version/hash index for that release.

Current Windows x64 assets:

```text
jl-skills.exe
map.exe
jl-skills-manifest.json
```

The release manifest carries the installer semver, installer artifact hash/URL, and each released skill's own semver plus native runtime artifact hash/URL.

The public update manifest remains:

```text
https://github.com/jacoblockett/jl-skills/releases/latest/download/jl-skills-manifest.json
```

GitHub `latest` must therefore remain a stable release. Nightly releases are prereleases and must never be marked latest.

Only plain stable semantic versions (`X.Y.Z`) are accepted from the public update manifest. Prerelease versions such as `X.Y.Z-nightly` are rejected even if a manifest URL is overridden during testing.

Installer update discovery compares the running installer version against the stable release manifest.

Interactive skill update discovery compares installed skill self-reported versions against the skill versions in the same stable release manifest. It must not use a nightly build or a newer development catalog as the update source.

Because the installer is the self-contained carrier for skill instructions/resources, a running installer can apply a stable skill update only when its embedded skill version exactly matches the stable release manifest. If the stable release advertises a newer skill than the running installer carries, the user must update `jl-skills` first, then retry the skill update.

Explicit non-interactive update/reapply commands may continue to operate deterministically from the running executable's embedded catalog; the interactive discovery channel is the published-release authority.

## Nightly channel

`nightly` is one rolling GitHub prerelease used for production-path testing.

It:

- is built only from `main`;
- runs nightly on schedule and may also be dispatched manually;
- builds only when build-relevant source changed since the last successful nightly, unless a manual force build is requested;
- builds and tests all current binaries from source;
- replaces the existing `nightly` assets rather than creating an accumulating series of dated releases;
- never publishes or replaces the stable update manifest channel;
- never becomes GitHub's latest release.

The `nightly` tag moves only after a successful build/test pass, so it also records the last source revision successfully published through the nightly channel.

## Stable release automation

Stable release publication is manual. The requested version must:

- be plain semver;
- match the installer source version and package version;
- not already have a tag/release.

The release workflow builds/tests from `main`, verifies the generated manifest, and publishes all current binaries plus the manifest in one atomic release unit.
