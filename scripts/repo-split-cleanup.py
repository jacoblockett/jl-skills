from pathlib import Path
import json
import re
import shutil

root = Path(__file__).resolve().parents[1]

def write(path: str, content: str) -> None:
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content.rstrip() + "\n", encoding="utf-8")

write("catalog.json", r'''
{
  "format": 1,
  "skills": {
    "map": {
      "manifest_url": "https://github.com/jacoblockett/jls-map/releases/latest/download/manifest.json"
    }
  }
}
''')

write("README.md", r'''
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
''')

write("scripts/build.ts", r'''
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  hostMatchesTarget,
  installerAssetName,
  targetByKey,
} from '../src/targets'

const repo = join(import.meta.dir, '..')
const out = join(repo, 'build')
const semver = /^\d+\.\d+\.\d+$/
const buildTarget = targetByKey(process.env.JL_SKILLS_BUILD_TARGET?.trim() || 'windows-x64')

mkdirSync(out, { recursive: true })

if (!hostMatchesTarget(buildTarget)) {
  throw new Error(`build target ${buildTarget.key} does not match this host OS/architecture`)
}

type SkillReference = { manifest_url: string }
type Catalog = { format: 1; skills: Record<string, SkillReference> }

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function readCatalog(): Catalog {
  const raw = JSON.parse(readFileSync(join(repo, 'catalog.json'), 'utf8')) as Record<string, unknown>
  if (raw.format !== 1) throw new Error('catalog format must be 1')
  if (!raw.skills || typeof raw.skills !== 'object' || Array.isArray(raw.skills)) {
    throw new Error('catalog skills must be an object')
  }

  const skills: Record<string, SkillReference> = {}
  for (const [name, value] of Object.entries(raw.skills as Record<string, unknown>)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`invalid catalog skill name ${name}`)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid catalog skill ${name}`)
    const manifestUrl = (value as Record<string, unknown>).manifest_url
    if (typeof manifestUrl !== 'string' || !manifestUrl.trim()) throw new Error(`${name} catalog entry requires manifest_url`)
    const parsed = new URL(manifestUrl)
    if (parsed.protocol !== 'https:') throw new Error(`${name} manifest_url must use HTTPS`)
    skills[name] = { manifest_url: manifestUrl }
  }
  return { format: 1, skills }
}

const installerName = installerAssetName(buildTarget)
const output = join(out, installerName)
rmSync(join(out, 'jl-skill.exe'), { force: true })
rmSync(join(out, 'jl-skills.exe'), { force: true })
rmSync(output, { force: true })
for (const name of readdirSync(out)) {
  if (name.endsWith('.zip')) rmSync(join(out, name), { force: true })
}
rmSync(join(out, 'runtime-assets'), { recursive: true, force: true })
rmSync(join(out, 'packages'), { recursive: true, force: true })
rmSync(join(out, 'cargo'), { recursive: true, force: true })

const installerBuild = Bun.spawnSync([
  process.execPath,
  'build',
  join(repo, 'src', 'jl-skill.ts'),
  '--compile',
  `--target=${buildTarget.bunCompileTarget}`,
  '--define',
  `JL_SKILLS_COMPILED_TARGET=${JSON.stringify(buildTarget.key)}`,
  '--outfile',
  output,
], {
  cwd: repo,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})
if (installerBuild.exitCode !== 0) process.exit(installerBuild.exitCode)

const installerSource = readFileSync(join(repo, 'src', 'jl-skill.ts'), 'utf8')
const versionMatch = installerSource.match(/const VERSION = ['"]([^'"]+)['"]/)
if (!versionMatch) throw new Error('could not determine jl-skills installer version from src/jl-skill.ts')
const installerVersion = versionMatch[1]
if (!semver.test(installerVersion)) throw new Error(`installer version must be plain semver: ${installerVersion}`)

const releaseTag = process.env.JL_SKILLS_RELEASE_TAG?.trim() || 'dev'
if (!/^[A-Za-z0-9._-]+$/.test(releaseTag)) throw new Error(`invalid release tag: ${releaseTag}`)
const releaseBase = `https://github.com/jacoblockett/jls/releases/download/${releaseTag}`
const catalog = readCatalog()

const releaseManifest = {
  format: 3,
  installer: {
    version: installerVersion,
    artifacts: {
      [buildTarget.key]: {
        url: `${releaseBase}/${installerName}`,
        sha256: sha256(output),
      },
    },
  },
  skills: catalog.skills,
}

const manifestOutput = join(out, 'manifest.json')
rmSync(join(out, 'jl-skills-manifest.json'), { force: true })
writeFileSync(manifestOutput, `${JSON.stringify(releaseManifest, null, 2)}\n`)

console.log(`Built ${output}`)
console.log(`Built ${manifestOutput}`)
''')

write("scripts/aggregate-release.ts", r'''
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
  TARGET_KEYS,
  installerAssetName,
  targetByKey,
  type TargetKey,
} from '../src/targets'

const repo = resolve(import.meta.dir, '..')
const semver = /^\d+\.\d+\.\d+$/
const sha256Pattern = /^[a-f0-9]{64}$/

type Artifact = { url: string; sha256: string }
type SkillReference = { manifest_url: string }
type Fragment = {
  format: number
  installer: { version: string; artifacts: Record<string, Artifact> }
  skills: Record<string, SkillReference>
}

type Catalog = { format: 1; skills: Record<string, SkillReference> }

export type AggregateOptions = {
  inputRoot: string
  outputRoot: string
  releaseTag: string
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} keys must be exactly: ${wanted.join(', ')}`)
  }
}

function readCatalog(): Catalog {
  const raw = JSON.parse(readFileSync(join(repo, 'catalog.json'), 'utf8')) as Catalog
  if (raw.format !== 1 || !raw.skills || typeof raw.skills !== 'object') throw new Error('invalid catalog.json')
  return raw
}

function assertArtifact(
  artifact: Artifact | undefined,
  file: string,
  expectedUrl: string,
  label: string,
): Artifact {
  if (!artifact) throw new Error(`${label} is missing from its target manifest`)
  if (artifact.url !== expectedUrl) throw new Error(`${label} URL must be ${expectedUrl}`)
  if (!sha256Pattern.test(artifact.sha256)) throw new Error(`${label} has an invalid SHA-256`)
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`${label} file is missing: ${file}`)
  const actual = sha256(file)
  if (actual !== artifact.sha256) throw new Error(`${label} SHA-256 does not match ${basename(file)}`)
  return artifact
}

function readFragment(path: string, target: TargetKey, catalog: Catalog): Fragment {
  if (!existsSync(path)) throw new Error(`missing ${target} manifest fragment: ${path}`)
  const fragment = JSON.parse(readFileSync(path, 'utf8')) as Fragment
  if (fragment.format !== 3) throw new Error(`${target} manifest fragment must use format 3`)
  if (!fragment.installer || typeof fragment.installer !== 'object') throw new Error(`${target} fragment is missing installer metadata`)
  if (typeof fragment.installer.version !== 'string' || !semver.test(fragment.installer.version)) {
    throw new Error(`${target} fragment has invalid installer version`)
  }
  if (!fragment.installer.artifacts || typeof fragment.installer.artifacts !== 'object') {
    throw new Error(`${target} fragment is missing installer artifacts`)
  }
  exactKeys(fragment.installer.artifacts, [target], `${target} installer artifact map`)
  if (JSON.stringify(fragment.skills) !== JSON.stringify(catalog.skills)) {
    throw new Error(`${target} skill references do not match catalog.json`)
  }
  return fragment
}

export function aggregateRelease({ inputRoot, outputRoot, releaseTag }: AggregateOptions): string {
  if (!/^[A-Za-z0-9._-]+$/.test(releaseTag)) throw new Error(`invalid release tag: ${releaseTag}`)
  const releaseBase = `https://github.com/jacoblockett/jls/releases/download/${releaseTag}`
  const catalog = readCatalog()
  const fragments = new Map<TargetKey, { root: string; manifest: Fragment }>()

  let installerVersion: string | undefined
  for (const key of TARGET_KEYS) {
    const targetRoot = join(inputRoot, `target-${key}`)
    if (!existsSync(targetRoot) || !statSync(targetRoot).isDirectory()) {
      throw new Error(`required target artifact directory is missing: target-${key}`)
    }
    const manifest = readFragment(join(targetRoot, 'manifest.json'), key, catalog)
    if (installerVersion === undefined) installerVersion = manifest.installer.version
    else if (manifest.installer.version !== installerVersion) {
      throw new Error(`${key} installer version ${manifest.installer.version} does not match ${installerVersion}`)
    }
    fragments.set(key, { root: targetRoot, manifest })
  }

  if (!installerVersion) throw new Error('no installer version was aggregated')
  rmSync(outputRoot, { recursive: true, force: true })
  mkdirSync(outputRoot, { recursive: true })

  const installerArtifacts: Record<string, Artifact> = {}
  for (const key of TARGET_KEYS) {
    const target = targetByKey(key)
    const fragment = fragments.get(key)!
    const name = installerAssetName(target)
    const source = join(fragment.root, name)
    const expectedUrl = `${releaseBase}/${name}`
    const artifact = assertArtifact(fragment.manifest.installer.artifacts[key], source, expectedUrl, `${key} installer`)
    copyFileSync(source, join(outputRoot, name))
    installerArtifacts[key] = artifact
  }

  exactKeys(installerArtifacts, [...TARGET_KEYS], 'aggregated installer target set')

  const output = join(outputRoot, 'manifest.json')
  writeFileSync(output, `${JSON.stringify({
    format: 3,
    installer: {
      version: installerVersion,
      artifacts: installerArtifacts,
    },
    skills: catalog.skills,
  }, null, 2)}\n`)

  console.log(`Aggregated ${TARGET_KEYS.length} required installer targets into ${outputRoot}`)
  return output
}

if (import.meta.main) {
  const inputRoot = resolve(process.env.JL_SKILLS_AGGREGATE_INPUT?.trim() || join(repo, 'build', 'targets'))
  const outputRoot = resolve(process.env.JL_SKILLS_AGGREGATE_OUTPUT?.trim() || join(repo, 'build', 'release'))
  const releaseTag = process.env.JL_SKILLS_RELEASE_TAG?.trim()
  if (!releaseTag) throw new Error('JL_SKILLS_RELEASE_TAG is required for release aggregation')
  aggregateRelease({ inputRoot, outputRoot, releaseTag })
}
''')

write("src/targets.ts", r'''
import { arch, platform } from 'node:os'

export const TARGET_KEYS = [
  'windows-x64',
  'windows-arm64',
  'macos-x64',
  'macos-arm64',
  'linux-x64-gnu',
  'linux-arm64-gnu',
  'linux-x64-musl',
  'linux-arm64-musl',
] as const

export type TargetKey = typeof TARGET_KEYS[number]
export type TargetOS = 'windows' | 'macos' | 'linux'
export type TargetArch = 'x64' | 'arm64'
export type TargetAbi = 'msvc' | 'darwin' | 'gnu' | 'musl'

export type DistributionTarget = {
  key: TargetKey
  os: TargetOS
  arch: TargetArch
  abi: TargetAbi
  executableSuffix: '' | '.exe'
  bunCompileTarget: string
}

export const TARGETS: Record<TargetKey, DistributionTarget> = {
  'windows-x64': { key: 'windows-x64', os: 'windows', arch: 'x64', abi: 'msvc', executableSuffix: '.exe', bunCompileTarget: 'bun-windows-x64-baseline' },
  'windows-arm64': { key: 'windows-arm64', os: 'windows', arch: 'arm64', abi: 'msvc', executableSuffix: '.exe', bunCompileTarget: 'bun-windows-arm64' },
  'macos-x64': { key: 'macos-x64', os: 'macos', arch: 'x64', abi: 'darwin', executableSuffix: '', bunCompileTarget: 'bun-darwin-x64-baseline' },
  'macos-arm64': { key: 'macos-arm64', os: 'macos', arch: 'arm64', abi: 'darwin', executableSuffix: '', bunCompileTarget: 'bun-darwin-arm64' },
  'linux-x64-gnu': { key: 'linux-x64-gnu', os: 'linux', arch: 'x64', abi: 'gnu', executableSuffix: '', bunCompileTarget: 'bun-linux-x64-baseline' },
  'linux-arm64-gnu': { key: 'linux-arm64-gnu', os: 'linux', arch: 'arm64', abi: 'gnu', executableSuffix: '', bunCompileTarget: 'bun-linux-arm64' },
  'linux-x64-musl': { key: 'linux-x64-musl', os: 'linux', arch: 'x64', abi: 'musl', executableSuffix: '', bunCompileTarget: 'bun-linux-x64-musl' },
  'linux-arm64-musl': { key: 'linux-arm64-musl', os: 'linux', arch: 'arm64', abi: 'musl', executableSuffix: '', bunCompileTarget: 'bun-linux-arm64-musl' },
}

export function isTargetKey(value: string): value is TargetKey {
  return Object.hasOwn(TARGETS, value)
}

export function targetByKey(value: string): DistributionTarget {
  if (!isTargetKey(value)) throw new Error(`unsupported jl-skills target: ${value}`)
  return TARGETS[value]
}

export function hostMatchesTarget(target: DistributionTarget): boolean {
  const hostOs = platform() === 'win32' ? 'windows' : platform() === 'darwin' ? 'macos' : platform()
  return hostOs === target.os && arch() === target.arch
}

export function installerAssetName(target: DistributionTarget): string {
  return `jl-skills-${target.key}${target.executableSuffix}`
}

declare const JL_SKILLS_COMPILED_TARGET: string | undefined

export function compiledTarget(): DistributionTarget {
  const value = typeof JL_SKILLS_COMPILED_TARGET === 'string' ? JL_SKILLS_COMPILED_TARGET : undefined
  if (!value) throw new Error('jl-skills compiled target was not injected at build time')
  return targetByKey(value)
}
''')

updater = (root / "src/installer-updater.ts").read_text(encoding="utf-8")
marker = "async function downloadVerified("
idx = updater.index(marker)
suffix = updater[idx:]
prefix = r'''import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { containedPath, extractZip } from './archive'
import { compiledTarget, isTargetKey, type TargetKey } from './targets'

if (Bun.isStandaloneExecutable) compiledTarget()

export const DEFAULT_RELEASE_MANIFEST_URL = 'https://github.com/jacoblockett/jls/releases/latest/download/manifest.json'

type FetchLike = typeof fetch

export type ReleaseArtifact = {
  url: string
  sha256: string
}

export type TargetArtifactMap = Partial<Record<TargetKey, ReleaseArtifact>>
export type SkillArtifactMap = Partial<Record<TargetKey | 'portable', ReleaseArtifact>>

export type ReleasedSkill = {
  version: string
  min_installer: string
  artifacts: SkillArtifactMap
}

export type SkillReference = {
  manifest_url: string
}

export type ReleaseIndex = {
  format: 3
  installer: {
    version: string
    artifacts: TargetArtifactMap
  }
  skills: Record<string, SkillReference>
}

export type ReleaseManifest = {
  format: 3
  installer: {
    version: string
    artifacts: TargetArtifactMap
  }
  skills: Record<string, ReleasedSkill>
}

export type InstallerUpdate = {
  version: string
  artifact: ReleaseArtifact
}

export type GeneratedDataSpec = {
  path: string
  marker?: string
}

export type HarnessResources = Record<string, Record<string, string[]>>

export type SkillPackageManifest = {
  format: 1
  name: string
  version: string
  min_installer: string
  description: string
  skill_files: string[]
  harness_resources?: HarnessResources
  runtime_files?: string[]
  runtime?: string
  runtime_artifacts?: Record<string, string>
  runtime_cli?: string
  cli_token?: string
  instruction_fragment?: string
  generated_data?: GeneratedDataSpec[]
}

export type DownloadedSkillPackage = {
  manifest: SkillPackageManifest
  root: string
  cleanup: () => void
}

export type SelectedSkillArtifact = {
  key: TargetKey | 'portable'
  artifact: ReleaseArtifact
}

function semverParts(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function compareVersions(a: string, b: string): number {
  const left = semverParts(a)
  const right = semverParts(b)
  if (!left || !right) throw new Error(`invalid semantic version comparison: ${a} vs ${b}`)
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1
  }
  return 0
}

function parseSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} has an invalid SHA-256`)
  }
  return value
}

function parseArtifact(value: unknown, label: string): ReleaseArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ${label}`)
  const raw = value as Record<string, unknown>
  if (typeof raw.url !== 'string' || !raw.url.trim()) throw new Error(`${label} is missing a URL`)
  return { url: raw.url, sha256: parseSha256(raw.sha256, label) }
}

function parseArtifactMap(value: unknown, label: string, allowPortable: false): TargetArtifactMap
function parseArtifactMap(value: unknown, label: string, allowPortable: true): SkillArtifactMap
function parseArtifactMap(
  value: unknown,
  label: string,
  allowPortable: boolean,
): TargetArtifactMap | SkillArtifactMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) throw new Error(`${label} must contain at least one artifact`)

  const artifacts: Record<string, ReleaseArtifact> = {}
  for (const [key, artifact] of entries) {
    if (key !== 'portable' && !isTargetKey(key)) throw new Error(`${label} has invalid target ${key}`)
    if (key === 'portable' && !allowPortable) throw new Error(`${label} cannot publish a portable artifact`)
    artifacts[key] = parseArtifact(artifact, `${label}.${key}`)
  }
  return artifacts
}

function parseSkillReference(value: unknown, name: string): SkillReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid released skill reference ${name}`)
  const manifestUrl = (value as Record<string, unknown>).manifest_url
  if (typeof manifestUrl !== 'string' || !manifestUrl.trim()) throw new Error(`${name} skill reference is missing manifest_url`)
  return { manifest_url: manifestUrl }
}

export function parseReleaseManifest(value: unknown): ReleaseIndex {
  if (!value || typeof value !== 'object') throw new Error('invalid release manifest')
  const raw = value as Record<string, unknown>
  if (raw.format !== 3) throw new Error('unsupported release manifest format')

  if (!raw.installer || typeof raw.installer !== 'object') throw new Error('release manifest is missing installer metadata')
  const installerRaw = raw.installer as Record<string, unknown>
  if (typeof installerRaw.version !== 'string' || !semverParts(installerRaw.version)) {
    throw new Error('invalid installer release version')
  }
  const installerArtifacts = parseArtifactMap(installerRaw.artifacts, 'installer release artifacts', false)

  if (!raw.skills || typeof raw.skills !== 'object' || Array.isArray(raw.skills)) {
    throw new Error('release manifest is missing skill references')
  }
  const skills: Record<string, SkillReference> = {}
  for (const [name, reference] of Object.entries(raw.skills as Record<string, unknown>)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`invalid released skill name ${name}`)
    skills[name] = parseSkillReference(reference, name)
  }

  return {
    format: 3,
    installer: { version: installerRaw.version, artifacts: installerArtifacts },
    skills,
  }
}

export function parseSkillReleaseManifest(name: string, value: unknown): ReleasedSkill {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid released skill manifest ${name}`)
  const raw = value as Record<string, unknown>
  if (raw.format !== 1) throw new Error(`unsupported released skill manifest format for ${name}`)
  if (raw.name !== name) throw new Error(`released skill manifest for ${name} identifies ${String(raw.name)}`)
  if (typeof raw.version !== 'string' || !semverParts(raw.version)) throw new Error(`invalid released skill version ${name}`)
  if (typeof raw.min_installer !== 'string' || !semverParts(raw.min_installer)) {
    throw new Error(`invalid minimum installer version for ${name}`)
  }
  return {
    version: raw.version,
    min_installer: raw.min_installer,
    artifacts: parseArtifactMap(raw.artifacts, `released skill ${name} artifacts`, true),
  }
}

async function fetchReleaseIndex(
  manifestUrl: string,
  fetcher: FetchLike,
): Promise<ReleaseIndex | null> {
  const response = await fetcher(manifestUrl, { headers: { 'user-agent': 'jl-skills' } })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`stable release check failed with HTTP ${response.status}`)
  return parseReleaseManifest(await response.json())
}

export async function fetchStableReleaseManifest(
  manifestUrl = process.env.JL_SKILLS_UPDATE_MANIFEST_URL || DEFAULT_RELEASE_MANIFEST_URL,
  fetcher: FetchLike = fetch,
): Promise<ReleaseManifest | null> {
  const index = await fetchReleaseIndex(manifestUrl, fetcher)
  if (!index) return null

  const skills: Record<string, ReleasedSkill> = {}
  await Promise.all(Object.entries(index.skills).map(async ([name, reference]) => {
    const response = await fetcher(reference.manifest_url, { headers: { 'user-agent': 'jl-skills' } })
    if (response.status === 404) return
    if (!response.ok) throw new Error(`${name} release check failed with HTTP ${response.status}`)
    skills[name] = parseSkillReleaseManifest(name, await response.json())
  }))

  return { format: 3, installer: index.installer, skills }
}

function targetKey(target?: TargetKey): TargetKey {
  return target ?? compiledTarget().key
}

export function selectInstallerArtifact(manifest: ReleaseManifest | ReleaseIndex, target: TargetKey): ReleaseArtifact {
  const artifact = manifest.installer.artifacts[target]
  if (!artifact) throw new Error(`installer release has no ${target} artifact`)
  return artifact
}

export function selectSkillArtifact(name: string, released: ReleasedSkill, target: TargetKey): SelectedSkillArtifact {
  const exact = released.artifacts[target]
  if (exact) return { key: target, artifact: exact }
  const portable = released.artifacts.portable
  if (portable) return { key: 'portable', artifact: portable }
  throw new Error(`${name} has no ${target} or portable release artifact`)
}

export async function checkInstallerUpdate(
  currentVersion: string,
  manifestUrl = process.env.JL_SKILLS_UPDATE_MANIFEST_URL || DEFAULT_RELEASE_MANIFEST_URL,
  fetcher: FetchLike = fetch,
  target?: TargetKey,
): Promise<InstallerUpdate | null> {
  const manifest = await fetchReleaseIndex(manifestUrl, fetcher)
  if (!manifest || compareVersions(manifest.installer.version, currentVersion) <= 0) return null
  const currentTarget = targetKey(target)
  return { version: manifest.installer.version, artifact: selectInstallerArtifact(manifest, currentTarget) }
}

'''
write("src/installer-updater.ts", prefix + suffix)

write("tests/targets.test.ts", r'''
import { describe, expect, test } from 'bun:test'
import {
  TARGET_KEYS,
  TARGETS,
  installerAssetName,
  targetByKey,
} from '../src/targets'

describe('distribution targets', () => {
  test('locks the required public target set', () => {
    expect(TARGET_KEYS).toEqual([
      'windows-x64',
      'windows-arm64',
      'macos-x64',
      'macos-arm64',
      'linux-x64-gnu',
      'linux-arm64-gnu',
      'linux-x64-musl',
      'linux-arm64-musl',
    ])
    expect(Object.keys(TARGETS)).toEqual([...TARGET_KEYS])
  })

  test('owns installer compiler facts for every target', () => {
    for (const key of TARGET_KEYS) {
      const target = targetByKey(key)
      expect(target.key).toBe(key)
      expect(['windows', 'macos', 'linux']).toContain(target.os)
      expect(['x64', 'arm64']).toContain(target.arch)
      expect(['msvc', 'darwin', 'gnu', 'musl']).toContain(target.abi)
      expect(target.bunCompileTarget.startsWith('bun-')).toBe(true)
      expect(target.executableSuffix).toBe(target.os === 'windows' ? '.exe' : '')
      expect(installerAssetName(target)).toBe(`jl-skills-${key}${target.executableSuffix}`)
    }
  })

  test('uses the intended Bun targets', () => {
    expect(TARGETS['windows-x64'].bunCompileTarget).toBe('bun-windows-x64-baseline')
    expect(TARGETS['windows-arm64'].bunCompileTarget).toBe('bun-windows-arm64')
    expect(TARGETS['macos-x64'].bunCompileTarget).toBe('bun-darwin-x64-baseline')
    expect(TARGETS['macos-arm64'].bunCompileTarget).toBe('bun-darwin-arm64')
    expect(TARGETS['linux-x64-gnu'].bunCompileTarget).toBe('bun-linux-x64-baseline')
    expect(TARGETS['linux-arm64-gnu'].bunCompileTarget).toBe('bun-linux-arm64')
    expect(TARGETS['linux-x64-musl'].bunCompileTarget).toBe('bun-linux-x64-musl')
    expect(TARGETS['linux-arm64-musl'].bunCompileTarget).toBe('bun-linux-arm64-musl')
  })

  test('rejects unknown targets', () => {
    expect(() => targetByKey('linux-x64')).toThrow('unsupported jl-skills target')
  })
})
''')

write("tests/installer-updater.test.ts", r'''
import { describe, expect, test } from 'bun:test'
import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  checkInstallerUpdate,
  compareVersions,
  downloadSkillPackage,
  fetchStableReleaseManifest,
  parseReleaseManifest,
  parseSkillPackageManifest,
  parseSkillReleaseManifest,
  selectInstallerArtifact,
  selectSkillArtifact,
  type ReleasedSkill,
} from '../src/installer-updater'

const repo = resolve(import.meta.dir, '..')
const scratch = join(repo, 'build', 'installer-updater-tests')

function reset(name: string): string {
  const root = join(scratch, name)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  return root
}

function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function releaseIndex(installerVersion = '0.7.0') {
  return {
    format: 3,
    installer: {
      version: installerVersion,
      artifacts: {
        'windows-x64': {
          url: 'https://fixture.invalid/jl-skills-windows-x64.exe',
          sha256: '0'.repeat(64),
        },
      },
    },
    skills: {
      'example-skill': {
        manifest_url: 'https://fixture.invalid/example-skill-manifest.json',
      },
    },
  }
}

function skillRelease(version = '1.2.3', sha = '1'.repeat(64)) {
  return {
    format: 1,
    name: 'example-skill',
    version,
    min_installer: '0.7.0',
    artifacts: {
      'windows-x64': {
        url: 'https://fixture.invalid/example-skill-windows-x64.zip',
        sha256: sha,
      },
    },
  }
}

function fixtureFetcher(index: unknown, skill: unknown | null = skillRelease(), archive?: Uint8Array): typeof fetch {
  return (async (input: any) => {
    const url = String(input)
    if (url === 'https://fixture.invalid/manifest.json') return Response.json(index)
    if (url === 'https://fixture.invalid/example-skill-manifest.json') {
      return skill === null ? new Response('missing', { status: 404 }) : Response.json(skill)
    }
    if (url === 'https://fixture.invalid/example-skill-windows-x64.zip' && archive) return new Response(archive)
    return new Response('missing', { status: 404 })
  }) as typeof fetch
}

describe('release metadata', () => {
  test('semantic versions compare deterministically', () => {
    expect(compareVersions('0.5.0', '0.5.0')).toBe(0)
    expect(compareVersions('0.5.0', '0.6.0')).toBe(-1)
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
    expect(() => compareVersions('0.5.0-nightly', '0.5.0')).toThrow('invalid semantic version comparison')
  })

  test('JLS release manifest contains installer artifacts and external skill references only', () => {
    const parsed = parseReleaseManifest(releaseIndex())
    expect(parsed.format).toBe(3)
    expect(parsed.installer.version).toBe('0.7.0')
    expect(parsed.skills['example-skill'].manifest_url).toBe('https://fixture.invalid/example-skill-manifest.json')
    expect(() => parseReleaseManifest({ ...releaseIndex(), format: 2 })).toThrow('unsupported release manifest format')
  })

  test('external skill manifest owns version, compatibility, hashes, and target artifacts', () => {
    const released = parseSkillReleaseManifest('example-skill', skillRelease())
    expect(released.version).toBe('1.2.3')
    expect(released.min_installer).toBe('0.7.0')
    expect(released.artifacts['windows-x64']?.url).toEndWith('/example-skill-windows-x64.zip')
    expect(() => parseSkillReleaseManifest('other', skillRelease())).toThrow('identifies example-skill')
    expect(() => parseSkillReleaseManifest('example-skill', { ...skillRelease(), format: 2 })).toThrow('unsupported released skill manifest format')
  })

  test('stable release fetch resolves referenced skill manifests', async () => {
    const resolved = await fetchStableReleaseManifest(
      'https://fixture.invalid/manifest.json',
      fixtureFetcher(releaseIndex()),
    )
    expect(resolved?.skills['example-skill'].version).toBe('1.2.3')
  })

  test('unpublished referenced skills are omitted without breaking installer update discovery', async () => {
    const resolved = await fetchStableReleaseManifest(
      'https://fixture.invalid/manifest.json',
      fixtureFetcher(releaseIndex(), null),
    )
    expect(resolved?.skills).toEqual({})
  })

  test('artifact selection remains exact-target with explicit portable fallback only', () => {
    const native = parseSkillReleaseManifest('example-skill', skillRelease())
    expect(selectSkillArtifact('example-skill', native, 'windows-x64').key).toBe('windows-x64')
    expect(() => selectSkillArtifact('example-skill', native, 'linux-x64-gnu')).toThrow('no linux-x64-gnu or portable')

    const portable = parseSkillReleaseManifest('example-skill', {
      ...skillRelease(),
      artifacts: {
        portable: { url: 'https://fixture.invalid/example-skill-portable.zip', sha256: '2'.repeat(64) },
      },
    })
    expect(selectSkillArtifact('example-skill', portable, 'linux-arm64-musl').key).toBe('portable')
    const index = parseReleaseManifest(releaseIndex())
    expect(selectInstallerArtifact(index, 'windows-x64').url).toEndWith('/jl-skills-windows-x64.exe')
  })

  test('installer update does not need to fetch external skill manifests', async () => {
    const index = releaseIndex('0.8.0')
    const fetcher = (async (input: any) => {
      const url = String(input)
      if (url === 'https://fixture.invalid/manifest.json') return Response.json(index)
      throw new Error(`unexpected fetch ${url}`)
    }) as typeof fetch
    const update = await checkInstallerUpdate('0.7.0', 'https://fixture.invalid/manifest.json', fetcher, 'windows-x64')
    expect(update?.version).toBe('0.8.0')
  })
})

describe('skill package contract', () => {
  test('package manifest validation remains installer-owned and skill-agnostic', () => {
    const parsed = parseSkillPackageManifest({
      format: 1,
      name: 'example-skill',
      version: '1.2.3',
      min_installer: '0.7.0',
      description: 'Example',
      skill_files: ['SKILL.md'],
      runtime: 'native',
      runtime_artifacts: { 'windows-x64': 'runtime/windows-x64/example.exe' },
      runtime_files: ['support.dat'],
      runtime_cli: 'example',
      generated_data: [{ path: '.example', marker: 'project.json' }],
    })
    expect(parsed.name).toBe('example-skill')
    expect(parsed.runtime_artifacts?.['windows-x64']).toBe('runtime/windows-x64/example.exe')
    expect(() => parseSkillPackageManifest({
      format: 1,
      name: 'example-skill',
      version: '1.2.3',
      min_installer: '0.7.0',
      description: 'Example',
      skill_files: ['../escape'],
    })).toThrow('relative contained path')
  })

  test('download verifies and extracts a referenced package', async () => {
    const root = reset('package')
    const packageRoot = join(root, 'package')
    mkdirSync(packageRoot, { recursive: true })
    const packageManifest = {
      format: 1,
      name: 'example-skill',
      version: '1.2.3',
      min_installer: '0.7.0',
      description: 'Example',
      skill_files: ['SKILL.md'],
    }
    writeFileSync(join(packageRoot, 'manifest.json'), `${JSON.stringify(packageManifest, null, 2)}\n`)
    writeFileSync(join(packageRoot, 'SKILL.md'), '<!-- jl-skills-meta: {"name":"example-skill","version":"1.2.3","format":1} -->\n')

    const zip = new AdmZip()
    zip.addLocalFile(join(packageRoot, 'manifest.json'))
    zip.addLocalFile(join(packageRoot, 'SKILL.md'))
    const bytes = new Uint8Array(zip.toBuffer())
    const released: ReleasedSkill = {
      version: '1.2.3',
      min_installer: '0.7.0',
      artifacts: {
        'windows-x64': {
          url: 'https://fixture.invalid/example-skill-windows-x64.zip',
          sha256: sha256(bytes),
        },
      },
    }

    const downloaded = await downloadSkillPackage(
      'example-skill',
      released,
      fixtureFetcher({}, {}, bytes),
      'windows-x64',
    )
    try {
      expect(downloaded.manifest.name).toBe('example-skill')
      expect(existsSync(join(downloaded.root, 'SKILL.md'))).toBe(true)
    } finally {
      downloaded.cleanup()
    }
  })
})
''')

write("package.json", r'''
{
  "name": "jl-skills-installer",
  "private": true,
  "version": "0.7.0",
  "type": "module",
  "packageManager": "bun@1.4.0",
  "scripts": {
    "build": "bun scripts/build.ts",
    "test:installer": "bun test --timeout 30000 tests/exclusive-multiselect.test.ts tests/harnesses.test.ts tests/install-preflight.test.ts tests/installer-updater.test.ts tests/targets.test.ts",
    "smoke": "bun run build && bun run test:installer"
  },
  "dependencies": {
    "@clack/core": "1.4.3",
    "@clack/prompts": "1.7.0",
    "adm-zip": "0.6.0"
  }
}
''')

write(".github/workflows/build.yml", r'''
name: Build

on:
  schedule:
    - cron: '0 6,7 * * *'
  workflow_dispatch:
    inputs:
      action:
        description: What to run
        required: true
        default: build
        type: choice
        options:
          - build
          - nightly
          - stable
      force:
        description: Force a nightly even when no build-relevant source changed
        required: false
        default: false
        type: boolean

permissions:
  contents: write

concurrency:
  group: jls-${{ github.event_name == 'schedule' && 'nightly' || inputs.action }}
  cancel-in-progress: false

jobs:
  prepare:
    runs-on: ubuntu-24.04
    outputs:
      mode: ${{ steps.mode.outputs.mode }}
      should_build: ${{ steps.mode.outputs.should_build }}
      release_tag: ${{ steps.mode.outputs.release_tag }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Resolve mode
        id: mode
        shell: bash
        run: |
          set -euo pipefail
          mode=nightly
          if [[ '${{ github.event_name }}' == 'workflow_dispatch' ]]; then mode='${{ inputs.action }}'; fi
          if [[ '${{ github.ref }}' != 'refs/heads/main' ]]; then
            echo 'Build and release automation may only run from main.' >&2
            exit 1
          fi

          should_build=true
          release_tag=dev
          if [[ "$mode" == nightly ]]; then
            if [[ '${{ github.event_name }}' == 'schedule' ]]; then
              local_hour="$(TZ=America/New_York date +%H)"
              if [[ "$local_hour" != 02 ]]; then should_build=false; fi
            fi
            force='${{ github.event_name == 'workflow_dispatch' && inputs.force || false }}'
            if [[ "$should_build" == true && "$force" != true ]]; then
              git fetch origin --tags --force
              if git rev-parse -q --verify refs/tags/nightly >/dev/null; then
                mapfile -t files < <(git diff --name-only nightly..HEAD -- .github/workflows/build.yml src scripts tests package.json bun.lock catalog.json)
                if (( ${#files[@]} == 0 )); then should_build=false; fi
              fi
            fi
            release_tag=nightly
          elif [[ "$mode" == stable ]]; then
            release_tag="$(date -u +%Y.%m.%d-%H%MZ)"
            git fetch origin --tags --force
            if git rev-parse -q --verify "refs/tags/$release_tag" >/dev/null; then
              echo "Tag $release_tag already exists." >&2
              exit 1
            fi
          elif [[ "$mode" != build ]]; then
            echo "Unknown build mode: $mode" >&2
            exit 1
          fi

          echo "mode=$mode" >> "$GITHUB_OUTPUT"
          echo "should_build=$should_build" >> "$GITHUB_OUTPUT"
          echo "release_tag=$release_tag" >> "$GITHUB_OUTPUT"

      - name: No release build
        if: steps.mode.outputs.should_build != 'true'
        run: echo 'Nothing to build or publish.'

  build:
    needs: prepare
    if: needs.prepare.outputs.should_build == 'true'
    strategy:
      fail-fast: false
      matrix:
        include:
          - target: windows-x64
            runner: windows-2025
            installer: jl-skills-windows-x64.exe
          - target: windows-arm64
            runner: windows-11-vs2026-arm
            installer: jl-skills-windows-arm64.exe
          - target: macos-x64
            runner: macos-15-intel
            installer: jl-skills-macos-x64
          - target: macos-arm64
            runner: macos-15
            installer: jl-skills-macos-arm64
          - target: linux-x64-gnu
            runner: ubuntu-24.04
            installer: jl-skills-linux-x64-gnu
          - target: linux-arm64-gnu
            runner: ubuntu-24.04-arm
            installer: jl-skills-linux-arm64-gnu
          - target: linux-x64-musl
            runner: ubuntu-24.04
            installer: jl-skills-linux-x64-musl
          - target: linux-arm64-musl
            runner: ubuntu-24.04-arm
            installer: jl-skills-linux-arm64-musl
    runs-on: ${{ matrix.runner }}
    env:
      JL_SKILLS_BUILD_TARGET: ${{ matrix.target }}
      JL_SKILLS_RELEASE_TAG: ${{ needs.prepare.outputs.release_tag }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.0

      - name: Install dependencies
        shell: bash
        run: bun install --frozen-lockfile

      - name: Build installer target
        shell: bash
        run: bun run build

      - name: Launch compiled installer
        if: ${{ !endsWith(matrix.target, '-musl') }}
        shell: bash
        run: './build/${{ matrix.installer }}' --version

      - name: Launch musl installer in Alpine
        if: ${{ endsWith(matrix.target, '-musl') }}
        shell: bash
        run: |
          set -euo pipefail
          docker run --rm \
            --user root \
            --entrypoint sh \
            -v "$PWD:/work" \
            -w /work \
            oven/bun:1.4.0-alpine \
            -lc "apk add --no-cache libgcc libstdc++ >/dev/null && ./build/${{ matrix.installer }} --version"

      - name: Run installer unit regressions
        if: matrix.target == 'windows-x64'
        shell: bash
        run: bun run test:installer

      - name: Run target contract tests
        shell: bash
        run: bun test --timeout 20000 tests/targets.test.ts

      - name: Upload target artifacts
        uses: actions/upload-artifact@v4
        with:
          name: target-${{ matrix.target }}
          if-no-files-found: error
          retention-days: 14
          path: |
            build/${{ matrix.installer }}
            build/manifest.json

  aggregate:
    needs: [prepare, build]
    if: needs.prepare.outputs.should_build == 'true'
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.0
      - name: Download all target artifacts
        uses: actions/download-artifact@v4
        with:
          pattern: target-*
          path: build/targets
          merge-multiple: false
      - name: Aggregate and verify complete installer release
        env:
          JL_SKILLS_RELEASE_TAG: ${{ needs.prepare.outputs.release_tag }}
          JL_SKILLS_AGGREGATE_INPUT: build/targets
          JL_SKILLS_AGGREGATE_OUTPUT: build/release
        run: bun scripts/aggregate-release.ts
      - name: Upload verified release bundle
        uses: actions/upload-artifact@v4
        with:
          name: release-bundle
          if-no-files-found: error
          retention-days: 14
          path: build/release/*

  publish:
    needs: [prepare, aggregate]
    if: needs.prepare.outputs.should_build == 'true' && needs.prepare.outputs.mode != 'build'
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/download-artifact@v4
        with:
          name: release-bundle
          path: build/release
      - name: Publish verified release bundle
        shell: bash
        env:
          GH_TOKEN: ${{ github.token }}
          GH_REPO: ${{ github.repository }}
          RELEASE_MODE: ${{ needs.prepare.outputs.mode }}
          RELEASE_TAG: ${{ needs.prepare.outputs.release_tag }}
        run: |
          set -euo pipefail
          mapfile -t assets < <(find build/release -maxdepth 1 -type f -print | sort)
          if (( ${#assets[@]} == 0 )); then echo 'Verified release bundle is empty.' >&2; exit 1; fi

          if [[ "$RELEASE_MODE" == nightly ]]; then
            if gh release view "$RELEASE_TAG" --repo "$GH_REPO" >/dev/null 2>&1; then
              gh release upload "$RELEASE_TAG" "${assets[@]}" --repo "$GH_REPO" --clobber
              mapfile -t existing < <(gh release view "$RELEASE_TAG" --repo "$GH_REPO" --json assets --jq '.assets[].name')
              for name in "${existing[@]}"; do
                if [[ ! -f "build/release/$name" ]]; then gh release delete-asset "$RELEASE_TAG" "$name" --repo "$GH_REPO" -y; fi
              done
            else
              gh release create "$RELEASE_TAG" "${assets[@]}" --repo "$GH_REPO" --title 'Nightly' --notes 'Rolling production-test build from main.' --prerelease --target "$GITHUB_SHA"
            fi
            git config user.name 'github-actions[bot]'
            git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
            git tag -f nightly "$GITHUB_SHA"
            git push origin refs/tags/nightly --force
          else
            gh release create "$RELEASE_TAG" "${assets[@]}" --repo "$GH_REPO" --title "$RELEASE_TAG" --generate-notes --target "$GITHUB_SHA"
          fi
''')

write("RELEASES.md", r'''
# JLS release contract

JLS is the `jl-skills` installer and external skill catalog. It does not own skill source code or publish skill packages.

## Ownership boundary

JLS owns:

- the compiled `jl-skills` installer;
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
jl-skills-windows-x64.exe
jl-skills-windows-arm64.exe
jl-skills-macos-x64
jl-skills-macos-arm64
jl-skills-linux-x64-gnu
jl-skills-linux-arm64-gnu
jl-skills-linux-x64-musl
jl-skills-linux-arm64-musl
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
        "url": "https://github.com/jacoblockett/jls/releases/download/<snapshot>/jl-skills-windows-x64.exe",
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

`JL_SKILLS_UPDATE_MANIFEST_URL` may override it for deterministic development/testing.

JLS release cadence is independent from skill release cadence. Updating JLS does not require rebuilding unchanged skills, and updating a skill does not require a new JLS binary release unless its catalog reference changes.
''')

write("TODO.md", r'''
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
''')

spec_path = root / "INSTALLER_SPEC.md"
spec = spec_path.read_text(encoding="utf-8")
spec = re.sub(
    r"^Status:.*$",
    "Status: accepted generic installer lifecycle contract. Skill source, packaging, runtime build details, and skill-specific behavior live in each referenced skill repository; JLS owns only installer behavior and external skill discovery.",
    spec,
    count=1,
    flags=re.M,
)
spec = spec.replace("https://github.com/jacoblockett/jl-skills/releases/latest/download/manifest.json", "https://github.com/jacoblockett/jls/releases/latest/download/manifest.json")

start = spec.index("### Target-specific and portable release packages")
end = spec.index("## Skill-generated data contract")
replacement = r'''### External skill releases and target selection

JLS does not build or package skill source. The JLS release manifest contains a reference to each skill repository's published release manifest.

Each skill repository owns whether its package is target-specific or portable, and owns the SHA-256 values and immutable URLs for those packages. For a native skill, each published package contains common skill/harness/support files plus only the runtime for one canonical target. A genuinely platform-independent skill may publish the reserved `portable` artifact key.

Artifact selection is exact-target first, then explicit `portable` fallback for skills only. Never fall back to another OS, architecture, or ABI.

The downloaded package's own manifest remains authoritative for install semantics after download. JLS validates that package metadata agrees with the external skill release manifest before installation.

'''
spec = spec[:start] + replacement + spec[end:]

spec = spec.replace('Example for Map:\n\n```json\n"generated_data": [\n  {\n    "path": ".map",\n    "marker": "project.json"\n  }\n]\n```', 'Example:\n\n```json\n"generated_data": [\n  {\n    "path": ".example-state",\n    "marker": "project.json"\n  }\n]\n```')
spec = spec.replace("For Map, selecting Map removes the selected project's `.map` directory. Neighboring project files are untouched.\n\n", "Only the selected skill's declared and positively detected generated-data paths are removed. Neighboring project files are untouched.\n\n")
spec = spec.replace(
    "Release-manifest format 2 is the active pre-stable source/build contract. Format 1 is obsolete implementation history and is no longer emitted.\n\nThe installer entry contains `version` plus `artifacts`, keyed by canonical target. Each skill entry contains `version`, `min_installer`, and `artifacts`, keyed by canonical target with optional `portable` fallback for truly platform-independent skill packages. Every artifact contains an immutable snapshot URL and SHA-256. The exact format-2 structure and publication completeness gate are authoritative in `RELEASES.md`.",
    "JLS release-manifest format 3 contains the installer `version`/target artifacts plus a `manifest_url` reference for each externally owned skill. Each referenced skill manifest contains that skill's `version`, `min_installer`, and target/portable artifacts with SHA-256 values. The exact format-3 JLS index and external skill-manifest contracts are authoritative in `RELEASES.md`."
)

map_start = spec.find("## Map runtime integration")
build_start = spec.find("## Build and smoke pipeline")
if map_start != -1 and build_start != -1 and build_start > map_start:
    spec = spec[:map_start] + spec[build_start:]

build_start = spec.index("## Build and smoke pipeline")
reg_start = spec.index("Regression coverage includes at least:", build_start)
new_build = r'''## Build and smoke pipeline

JLS builds only the installer. It does not compile skill runtimes or create skill archives.

Local smoke:

```text
bun run build
bun run test:installer
```

GitHub Actions builds all eight canonical installer targets, launches each compiled installer in its native consumer environment (musl targets in pinned Alpine), aggregates the eight installer artifacts, verifies SHA-256 and catalog-reference consistency, and publishes only the verified installer bundle plus `manifest.json`.

Skill repositories own their own runtime/package build and acceptance pipelines.

'''
spec = spec[:build_start] + new_build + spec[reg_start:]
spec = spec.replace("- release-manifest hash matching the built executable;\n- target-qualified installer/archive/runtime naming;\n- native package exclusion of foreign-target runtimes;", "- release-manifest hash matching the built executable;\n- target-qualified installer naming;\n- external skill-reference parsing and target/portable artifact selection;")
spec_path.write_text(spec.rstrip() + "\n", encoding="utf-8")

for path in [
    "tests/consumer-acceptance.test.ts",
    "tests/installer.test.ts",
    "tests/min-installer.test.ts",
    "tests/package-artifact.test.ts",
    "tests/release-fixture-server.ts",
]:
    (root / path).unlink(missing_ok=True)

skills = root / "skills"
if skills.exists():
    shutil.rmtree(skills)

# Remove temporary audit/migration machinery. The cleanup workflow removes itself after validation.
(root / ".github/workflows/audit-local-skill-assumptions.yml").unlink(missing_ok=True)

# The old repo URL should no longer be authoritative anywhere outside Git history.
for path in [root / "INSTALLER_SPEC.md", root / "RELEASES.md", root / "TODO.md"]:
    text = path.read_text(encoding="utf-8").replace("github.com/jacoblockett/jl-skills", "github.com/jacoblockett/jls")
    path.write_text(text, encoding="utf-8")
