import { createHash } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { arch, platform } from 'node:os'
import { containedPath, createZipFromDirectory } from '../src/archive'

const repo = join(import.meta.dir, '..')
const out = join(repo, 'build')
const skillsRoot = join(repo, 'skills')
const runtimeAssets = join(out, 'runtime-assets')
const packageStages = join(out, 'packages')
const semver = /^\d+\.\d+\.\d+$/
const skillMetaPrefix = 'jl-skills-meta:'

mkdirSync(out, { recursive: true })

if (platform() !== 'win32' || arch() !== 'x64') {
  throw new Error('current installer build supports Windows x64 only')
}

type SkillManifest = {
  format: number
  name: string
  version: string
  min_installer: string
  description: string
  skill_files: string[]
  harness_resources?: Record<string, Record<string, string[]>>
  runtime_files?: string[]
  runtime?: string
  runtime_artifacts?: Record<string, string>
  runtime_cli?: string
  cli_token?: string
  instruction_fragment?: string
  generated_data?: { path: string; marker?: string }[]
}

type ReleasedSkill = {
  version: string
  min_installer: string
  url: string
  sha256: string
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function packagePath(rel: string, label: string): string {
  return containedPath(rel, label)
}

function readManifest(skillRoot: string, directoryName: string): SkillManifest {
  const path = join(skillRoot, 'manifest.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as SkillManifest
  if (manifest.format !== 1) throw new Error(`${directoryName} manifest format must be 1`)
  if (manifest.name !== directoryName) throw new Error(`${directoryName} manifest name must match its directory`)
  if (!semver.test(manifest.version)) throw new Error(`${directoryName} manifest version must be plain semver`)
  if (!semver.test(manifest.min_installer)) throw new Error(`${directoryName} min_installer must be plain semver`)
  if (typeof manifest.description !== 'string' || !manifest.description.trim()) {
    throw new Error(`${directoryName} manifest requires a description`)
  }
  if (!Array.isArray(manifest.skill_files) || manifest.skill_files.length === 0) {
    throw new Error(`${directoryName} manifest requires skill_files`)
  }
  return manifest
}

function validateSkillMetadata(skillRoot: string, manifest: SkillManifest): void {
  const skillFile = manifest.skill_files.find((rel) => basename(rel).toLowerCase() === 'skill.md')
  if (!skillFile) throw new Error(`${manifest.name} manifest must include SKILL.md`)
  const text = readFileSync(join(skillRoot, packagePath(skillFile, `${manifest.name} skill file`)), 'utf8')
  const line = text.split(/\r?\n/).find((candidate) => candidate.includes(skillMetaPrefix))
  if (!line) throw new Error(`${manifest.name} SKILL.md is missing jl-skills metadata`)
  const marker = line.indexOf(skillMetaPrefix)
  const end = line.lastIndexOf('-->')
  if (marker < 0 || end < marker) throw new Error(`${manifest.name} SKILL.md has malformed jl-skills metadata`)

  let metadata: { name?: string; version?: string; format?: number }
  try {
    metadata = JSON.parse(line.slice(marker + skillMetaPrefix.length, end).trim())
  } catch {
    throw new Error(`${manifest.name} SKILL.md has invalid jl-skills metadata JSON`)
  }
  if (metadata.name !== manifest.name || metadata.version !== manifest.version || metadata.format !== 1) {
    throw new Error(`${manifest.name} SKILL.md metadata must match manifest name/version and format 1`)
  }
}

function copyDeclared(sourceRoot: string, stageRoot: string, rel: string, label: string): void {
  const safe = packagePath(rel, label)
  const source = join(sourceRoot, safe)
  const destination = join(stageRoot, safe)
  if (!existsSync(source)) throw new Error(`missing ${label}: ${source}`)
  mkdirSync(dirname(destination), { recursive: true })
  if (statSync(source).isDirectory()) cpSync(source, destination, { recursive: true })
  else copyFileSync(source, destination)
}

function buildSkillArchive(
  directoryName: string,
  manifest: SkillManifest,
  releaseBase: string,
): ReleasedSkill {
  const skillRoot = join(skillsRoot, directoryName)
  const stageRoot = join(packageStages, directoryName)
  const archive = join(out, `${manifest.name}.zip`)
  rmSync(stageRoot, { recursive: true, force: true })
  rmSync(archive, { force: true })
  mkdirSync(stageRoot, { recursive: true })

  validateSkillMetadata(skillRoot, manifest)
  copyFileSync(join(skillRoot, 'manifest.json'), join(stageRoot, 'manifest.json'))

  const declared = new Set<string>([
    ...manifest.skill_files,
    ...Object.values(manifest.harness_resources ?? {}).flatMap((resources) => Object.values(resources).flat()),
    ...(manifest.runtime_files ?? []),
    ...(manifest.instruction_fragment ? [manifest.instruction_fragment] : []),
  ])
  for (const rel of declared) copyDeclared(skillRoot, stageRoot, rel, `${manifest.name} package asset`)

  for (const rel of Object.values(manifest.runtime_artifacts ?? {})) {
    copyDeclared(join(runtimeAssets, directoryName), stageRoot, rel, `${manifest.name} runtime artifact`)
  }

  const entries = readdirSync(stageRoot)
  if (entries.length === 0) throw new Error(`${manifest.name} package is empty`)
  createZipFromDirectory(stageRoot, archive)

  return {
    version: manifest.version,
    min_installer: manifest.min_installer,
    url: `${releaseBase}/${manifest.name}.zip`,
    sha256: sha256(archive),
  }
}

const cargoTarget = join(out, 'cargo', 'map')
const stagedMap = join(runtimeAssets, 'map', 'runtime', 'windows-x64', 'map.exe')
rmSync(runtimeAssets, { recursive: true, force: true })
rmSync(packageStages, { recursive: true, force: true })
mkdirSync(dirname(stagedMap), { recursive: true })

const suppliedMap = process.env.JL_SKILL_MAP_EXE?.trim()
if (suppliedMap) {
  const source = resolve(suppliedMap)
  if (!existsSync(source)) throw new Error(`prebuilt Map runtime does not exist: ${source}`)
  copyFileSync(source, stagedMap)
} else {
  const cargo = Bun.which('cargo')
  if (!cargo) throw new Error('cargo is required on the build machine when JL_SKILL_MAP_EXE is not supplied')

  const mapBuild = Bun.spawnSync([
    cargo,
    'build',
    '--manifest-path',
    join(repo, 'skills', 'map', 'Cargo.toml'),
    '--release',
    '--target-dir',
    cargoTarget,
  ], {
    cwd: repo,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (mapBuild.exitCode !== 0) process.exit(mapBuild.exitCode)

  copyFileSync(join(cargoTarget, 'release', 'map.exe'), stagedMap)
}

const output = join(out, 'jl-skills.exe')
rmSync(join(out, 'jl-skill.exe'), { force: true })
rmSync(output, { force: true })
const installerBuild = Bun.spawnSync([
  process.execPath,
  'build',
  join(repo, 'src', 'jl-skill.ts'),
  '--compile',
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
const releaseBase = `https://github.com/jacoblockett/jl-skills/releases/download/${releaseTag}`

mkdirSync(packageStages, { recursive: true })
const releasedSkills: Record<string, ReleasedSkill> = {}
for (const directoryName of readdirSync(skillsRoot).sort()) {
  const skillRoot = join(skillsRoot, directoryName)
  if (!statSync(skillRoot).isDirectory()) continue
  const manifestPath = join(skillRoot, 'manifest.json')
  if (!existsSync(manifestPath)) continue
  const manifest = readManifest(skillRoot, directoryName)
  releasedSkills[manifest.name] = buildSkillArchive(directoryName, manifest, releaseBase)
}

const releaseManifest = {
  format: 1,
  installer: {
    version: installerVersion,
    url: `${releaseBase}/jl-skills.exe`,
    sha256: sha256(output),
  },
  skills: releasedSkills,
}
const manifestOutput = join(out, 'manifest.json')
rmSync(join(out, 'jl-skills-manifest.json'), { force: true })
rmSync(join(out, 'map.exe'), { force: true })
writeFileSync(manifestOutput, `${JSON.stringify(releaseManifest, null, 2)}\n`)

console.log(`Built ${output}`)
for (const skill of Object.keys(releasedSkills)) console.log(`Built ${join(out, `${skill}.zip`)}`)
console.log(`Built ${manifestOutput}`)
