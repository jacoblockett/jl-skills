import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseReleaseManifest } from '../src/installer-updater'
import {
  TARGET_KEYS,
  installerAssetName,
  skillArchiveName,
  targetByKey,
} from '../src/targets'

const repo = resolve(import.meta.dir, '..')
const input = resolve(process.env.JL_SKILLS_PROMOTION_INPUT?.trim() || join(repo, 'build', 'promotion-source'))
const output = resolve(process.env.JL_SKILLS_PROMOTION_OUTPUT?.trim() || join(repo, 'build', 'release'))
const stableTag = process.env.JL_SKILLS_RELEASE_TAG?.trim()
if (!stableTag || !/^\d{4}\.\d{2}\.\d{2}-\d{4}Z$/.test(stableTag)) {
  throw new Error('JL_SKILLS_RELEASE_TAG must be a timestamp Stable tag')
}

const sourceManifestPath = join(input, 'manifest.json')
if (!existsSync(sourceManifestPath)) throw new Error('validated Nightly manifest.json is missing')
const manifest = parseReleaseManifest(JSON.parse(readFileSync(sourceManifestPath, 'utf8')))
const sourceSkillsRoot = join(repo, 'skills')
const stableBase = `https://github.com/jacoblockett/jl-skills/releases/download/${stableTag}`

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function requireArtifact(name: string, expectedSha: string): void {
  const path = join(input, name)
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`validated Nightly asset is missing: ${name}`)
  const actual = sha256(path)
  if (actual !== expectedSha) throw new Error(`${name} SHA-256 does not match validated Nightly manifest`)
}

const installerKeys = Object.keys(manifest.installer.artifacts).sort()
if (installerKeys.length !== TARGET_KEYS.length || !TARGET_KEYS.every((key) => installerKeys.includes(key))) {
  throw new Error(`validated Nightly installer target set is incomplete: ${installerKeys.join(', ')}`)
}

const promoted = structuredClone(manifest)
for (const key of TARGET_KEYS) {
  const target = targetByKey(key)
  const artifact = manifest.installer.artifacts[key]
  if (!artifact) throw new Error(`validated Nightly is missing installer ${key}`)
  const name = installerAssetName(target)
  requireArtifact(name, artifact.sha256)
  promoted.installer.artifacts[key] = {
    ...artifact,
    url: `${stableBase}/${name}`,
  }
}

const sourceSkillNames = readdirSync(sourceSkillsRoot)
  .filter((directoryName) => {
    const root = join(sourceSkillsRoot, directoryName)
    return statSync(root).isDirectory() && existsSync(join(root, 'manifest.json'))
  })
  .sort()
const releaseSkillNames = Object.keys(manifest.skills).sort()
if (sourceSkillNames.join('\0') !== releaseSkillNames.join('\0')) {
  throw new Error(`validated Nightly skill catalog does not match source: expected ${sourceSkillNames.join(', ')}, got ${releaseSkillNames.join(', ')}`)
}

for (const name of sourceSkillNames) {
  const source = JSON.parse(readFileSync(join(sourceSkillsRoot, name, 'manifest.json'), 'utf8')) as { runtime?: string }
  const released = manifest.skills[name]
  const promotedSkill = promoted.skills[name]
  if (source.runtime) {
    const keys = Object.keys(released.artifacts).sort()
    if (keys.length !== TARGET_KEYS.length || !TARGET_KEYS.every((key) => keys.includes(key))) {
      throw new Error(`validated Nightly native skill ${name} target set is incomplete: ${keys.join(', ')}`)
    }
    for (const key of TARGET_KEYS) {
      const target = targetByKey(key)
      const artifact = released.artifacts[key]
      if (!artifact) throw new Error(`validated Nightly ${name} is missing ${key}`)
      const archive = skillArchiveName(name, target)
      requireArtifact(archive, artifact.sha256)
      promotedSkill.artifacts[key] = {
        ...artifact,
        url: `${stableBase}/${archive}`,
      }
    }
  } else {
    const keys = Object.keys(released.artifacts)
    if (keys.length !== 1 || keys[0] !== 'portable' || !released.artifacts.portable) {
      throw new Error(`validated Nightly portable skill ${name} must publish only portable`)
    }
    const archive = skillArchiveName(name, 'portable')
    requireArtifact(archive, released.artifacts.portable.sha256)
    promotedSkill.artifacts.portable = {
      ...released.artifacts.portable,
      url: `${stableBase}/${archive}`,
    }
  }
}

rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })
for (const entry of readdirSync(input).sort()) {
  if (entry === 'manifest.json' || entry === 'validation.json') continue
  const source = join(input, entry)
  if (statSync(source).isFile()) copyFileSync(source, join(output, entry))
}
writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(promoted, null, 2)}\n`)

console.log(`Promoted validated Nightly assets to Stable snapshot ${stableTag}`)
