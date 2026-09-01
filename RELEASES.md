
# JLS release contract

JLS is the `jls` installer and external skill catalog. It does not own skill source code or publish skill packages.

## Ownership boundary

JLS owns:

- the compiled `jls` installer;
- canonical installer target detection;
- generic package download/verification/install/update/uninstall behavior;
- the catalog of external skill release-manifest URLs;
- installer releases.

Each skill repository owns:

- its skill source and documentation;
- native runtimes and tests;
- package assembly;
- target-specific or portable skill archives;
- skill release manifests and immutable artifact hashes;
- skill releases.

No `skills/` source tree belongs in JLS.

## Required installer targets

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

Public installer asset names are exactly:

```text
jls-windows-x64.exe
jls-windows-arm64.exe
jls-macos-x64
jls-macos-arm64
jls-linux-x64-gnu
jls-linux-arm64-gnu
jls-linux-x64-musl
jls-linux-arm64-musl
```

## Catalog

`catalog.json` is the source-controlled list of skill repositories known to JLS. It contains references only:

```json
{
  "format": 1,
  "skills": {
    "map": {
      "manifest_url": "https://github.com/jacoblockett/jls-map/releases/latest/download/manifest.json"
    }
  }
}
```

Adding a skill to JLS means adding a release-manifest reference. It does not mean importing that skill's source or packages.

## JLS release manifest: format 3

A JLS release contains installer artifacts plus external skill references:

```json
{
  "format": 3,
  "installer": {
    "version": "0.7.0",
    "artifacts": {
      "windows-x64": {
        "url": "https://github.com/jacoblockett/jls/releases/download/<snapshot>/jls-windows-x64.exe",
        "sha256": "<64 lowercase hex characters>"
      }
    }
  },
  "skills": {
    "map": {
      "manifest_url": "https://github.com/jacoblockett/jls-map/releases/latest/download/manifest.json"
    }
  }
}
```

The JLS manifest never embeds or republishes skill archives.

## External skill release manifest

Each referenced skill publishes its own manifest. JLS resolves that manifest when it needs the available skill catalog.

Required shape:

```json
{
  "format": 1,
  "name": "map",
  "version": "0.5.0",
  "min_installer": "0.7.0",
  "artifacts": {
    "windows-x64": {
      "url": "https://github.com/jacoblockett/jls-map/releases/download/<skill-release>/map-windows-x64.zip",
      "sha256": "<64 lowercase hex characters>"
    }
  }
}
```

A skill may publish exact canonical target keys and/or an explicit `portable` artifact. JLS selects the exact current target first and uses `portable` only when the skill explicitly publishes it. No foreign OS/architecture/ABI fallback is allowed.

The package downloaded from a skill repository retains the package-manifest contract consumed by the installer. The skill repository, not JLS, is responsible for ensuring its release manifest and package contents agree.

A referenced skill manifest returning HTTP 404 is treated as not currently published and is omitted from the available catalog. Other HTTP or validation failures are errors.

## Installer build and publication

The release path is intentionally simple:

```text
prepare
  -> build/test eight installer targets
  -> aggregate/verify eight installers + catalog references
  -> publish
```

Every target build compiles and launches only the JLS installer. JLS does not install Rust, build skill runtimes, or create skill ZIPs.

The aggregator independently requires all eight installer target fragments, verifies target-qualified filenames, URLs, versions, and SHA-256 values, and verifies every fragment contains exactly the source-controlled `catalog.json` references.

A publishable JLS release therefore contains exactly eight installer binaries plus `manifest.json`.

## Nightly and Stable

Nightly is the rolling `nightly` prerelease/tag. Stable uses an immutable UTC timestamp tag `YYYY.MM.DD-HHmmZ`.

Both use the same build/test/aggregate path. Neither may publish a partial installer target set.

The stable update URL is:

```text
https://github.com/jacoblockett/jls/releases/latest/download/manifest.json
```

`JLS_UPDATE_MANIFEST_URL` may override it for deterministic development/testing.

JLS release cadence is independent from skill release cadence. Updating JLS does not require rebuilding unchanged skills, and updating a skill does not require a new JLS binary release unless its catalog reference changes.
