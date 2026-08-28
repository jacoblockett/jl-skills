import { createHash } from 'node:crypto'
import { chmodSync, rmSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { arch, platform } from 'node:os'
import { spawn } from 'node:child_process'

export const DEFAULT_INSTALLER_MANIFEST_URL = 'https://github.com/jacoblockett/jl-skills/releases/latest/download/jl-skills-manifest.json'

type FetchLike = typeof fetch

export type ReleaseArtifact = {
  url: string
  sha256: string
}

export type ReleasedSkill = {
  version: string
  artifacts: Record<string, ReleaseArtifact>
}

export type InstallerUpdateManifest = {
  format?: number
  version: string
  artifacts: Record<string, ReleaseArtifact>
  skills: Record<string, ReleasedSkill>
}

export type InstallerUpdate = {
  version: string
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
  if (!left || !right) throw new Error(`invalid installer version comparison: ${a} vs ${b}`)
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1
  }
  return 0
}

export function installerPlatformKey(): string {
  if (platform() === 'win32' && arch() === 'x64') return 'windows-x64'
  if (platform() === 'linux' && arch() === 'x64') return 'linux-x64'
  if (platform() === 'darwin' && arch() === 'arm64') return 'macos-arm64'
  return `${platform()}-${arch()}`
}

function parseArtifact(value: unknown, label: string): ReleaseArtifact {
  if (!value || typeof value !== 'object') throw new Error(`invalid ${label}`)
  const raw = value as Record<string, unknown>
  if (typeof raw.url !== 'string' || !raw.url.trim()) throw new Error(`${label} is missing a URL`)
  if (typeof raw.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(raw.sha256)) {
    throw new Error(`${label} has an invalid SHA-256`)
  }
  return { url: raw.url, sha256: raw.sha256.toLowerCase() }
}

export function parseInstallerUpdateManifest(value: unknown): InstallerUpdateManifest {
  if (!value || typeof value !== 'object') throw new Error('invalid installer update manifest')
  const raw = value as Record<string, unknown>
  if (typeof raw.version !== 'string' || !semverParts(raw.version)) throw new Error('invalid installer update version')
  if (!raw.artifacts || typeof raw.artifacts !== 'object') throw new Error('installer update manifest is missing artifacts')

  const artifacts: Record<string, ReleaseArtifact> = {}
  for (const [key, artifactValue] of Object.entries(raw.artifacts as Record<string, unknown>)) {
    artifacts[key] = parseArtifact(artifactValue, `installer update artifact ${key}`)
  }

  const skills: Record<string, ReleasedSkill> = {}
  if (raw.skills !== undefined) {
    if (!raw.skills || typeof raw.skills !== 'object') throw new Error('installer update manifest has invalid skills metadata')
    for (const [name, skillValue] of Object.entries(raw.skills as Record<string, unknown>)) {
      if (!skillValue || typeof skillValue !== 'object') throw new Error(`invalid released skill ${name}`)
      const skill = skillValue as Record<string, unknown>
      if (typeof skill.version !== 'string' || !semverParts(skill.version)) throw new Error(`invalid released skill version ${name}`)
      if (!skill.artifacts || typeof skill.artifacts !== 'object') throw new Error(`released skill ${name} is missing artifacts`)
      const skillArtifacts: Record<string, ReleaseArtifact> = {}
      for (const [key, artifactValue] of Object.entries(skill.artifacts as Record<string, unknown>)) {
        skillArtifacts[key] = parseArtifact(artifactValue, `released skill ${name} artifact ${key}`)
      }
      skills[name] = { version: skill.version, artifacts: skillArtifacts }
    }
  }

  return {
    format: typeof raw.format === 'number' ? raw.format : undefined,
    version: raw.version,
    artifacts,
    skills,
  }
}

export async function fetchStableReleaseManifest(
  manifestUrl = process.env.JL_SKILLS_UPDATE_MANIFEST_URL || DEFAULT_INSTALLER_MANIFEST_URL,
  fetcher: FetchLike = fetch,
): Promise<InstallerUpdateManifest | null> {
  const response = await fetcher(manifestUrl, { headers: { 'user-agent': 'jl-skills' } })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`stable release check failed with HTTP ${response.status}`)
  return parseInstallerUpdateManifest(await response.json())
}

export async function checkInstallerUpdate(
  currentVersion: string,
  manifestUrl = process.env.JL_SKILLS_UPDATE_MANIFEST_URL || DEFAULT_INSTALLER_MANIFEST_URL,
  fetcher: FetchLike = fetch,
): Promise<InstallerUpdate | null> {
  const manifest = await fetchStableReleaseManifest(manifestUrl, fetcher)
  if (!manifest || compareVersions(manifest.version, currentVersion) <= 0) return null

  const key = installerPlatformKey()
  const artifact = manifest.artifacts[key]
  if (!artifact) throw new Error(`installer update ${manifest.version} has no artifact for ${key}`)
  return { version: manifest.version, artifact }
}

export async function downloadVerifiedInstaller(
  update: InstallerUpdate,
  destination: string,
  fetcher: FetchLike = fetch,
): Promise<string> {
  const response = await fetcher(update.artifact.url, { headers: { 'user-agent': 'jl-skills' } })
  if (!response.ok) throw new Error(`installer update download failed with HTTP ${response.status}`)

  const bytes = new Uint8Array(await response.arrayBuffer())
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== update.artifact.sha256.toLowerCase()) {
    throw new Error(`installer update SHA-256 mismatch: expected ${update.artifact.sha256}, got ${actual}`)
  }

  try {
    writeFileSync(destination, bytes)
    try { chmodSync(destination, 0o755) } catch {}
    return destination
  } catch (error) {
    try { rmSync(destination, { force: true }) } catch {}
    throw error
  }
}

export async function stageInstallerUpdate(
  executable: string,
  update: InstallerUpdate,
  fetcher: FetchLike = fetch,
): Promise<string> {
  const staged = join(dirname(executable), `.${basename(executable)}.update-${process.pid}-${Date.now()}`)
  try {
    return await downloadVerifiedInstaller(update, staged, fetcher)
  } catch (error) {
    try { rmSync(staged, { force: true }) } catch {}
    throw error
  }
}

export function windowsReplacementCommand(staged: string, executable: string): string {
  const stagedEscaped = staged.replaceAll('"', '""')
  const executableEscaped = executable.replaceAll('"', '""')
  return `ping 127.0.0.1 -n 2 >nul & move /y "${stagedEscaped}" "${executableEscaped}" >nul`
}

export function scheduleInstallerReplacement(staged: string, executable: string): void {
  if (platform() !== 'win32') {
    renameSync(staged, executable)
    return
  }

  const child = spawn('cmd.exe', ['/d', '/s', '/c', windowsReplacementCommand(staged, executable)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}
