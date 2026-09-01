
# JLS to do

Status: repository split in progress.

## 1. [x] Build the installer for all required targets

The installer has native build/launch coverage for Windows x64/ARM64, macOS x64/ARM64, Linux GNU x64/ARM64, and Linux musl x64/ARM64.

## 2. [x] Move Map source out of JLS

The authoritative Map source snapshot was migrated losslessly to `jacoblockett/jls-map` before deletion from JLS.

## 3. [x] Make JLS installer-only

JLS no longer contains a `skills/` tree, builds skill runtimes, creates skill archives, or publishes skill payloads. `catalog.json` contains external skill release-manifest references only. JLS releases contain eight installer binaries plus `manifest.json`.

## 4. [ ] Make JLS-Map independently releasable

Give JLS-Map its own target build/test/package workflow and publish its own skill release manifest plus target packages.

## 5. [ ] Verify external catalog resolution end to end

Publish a JLS-Map release, verify JLS resolves its external manifest, then exercise install/update/uninstall through a released JLS installer without any skill payload living in JLS.

## 6. [ ] Publish the first Stable JLS snapshot

Run the complete eight-target installer build/test/aggregate path and publish the verified installer-only bundle under an immutable UTC timestamp tag.
