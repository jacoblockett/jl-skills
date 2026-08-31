import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
  TARGET_KEYS,
  installerAssetName,
  skillArchiveName,
  targetByKey,
  type TargetKey,
} from '../src/targets'

const repo = resolve(import.meta.dir, '..')
const portableBuildTarget: TargetKey = 'windows-x64'
const semver = /^\d+\.\d+\.\d+$/
const sha256Pattern = /^[a-f0-9]{64}$/

type Artifact = { url: string; sha256: string }
type FragmentSkill = {
  version: string
  min_installer: string
  artifacts: Record<string, Artifact>
}
type Fragment = {
  format: number
  installer: { version: string; artifacts: Record<string, Artifact> }
  skills: Record<string, FragmentSkill>
}
type SourceSkill = {
  name: string
  version: string
  minInstaller: string
  native: boolean
}

export type AggregateOptions = {
  inputRoot: string
  outputRoot: string
  releaseTag: string
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
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

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} keys must be exactly: ${wanted.join(', ')}`)
  }
}

function sourceSkills(): SourceSkill[] {
  const root = join(repo, 'skills')
  const skills: SourceSkill[] = []
  for (const directory of readdirSync(root).sort()) {
    const skillRoot = join(root, directory)
    if (!statSync(skillRoot).isDirectory()) continue
    const manifestPath = join(skillRoot, 'manifest.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    if (manifest.name !== directory) throw new Error(`${directory} source manifest name mismatch`)
    if (typeof manifest.version !== 'string' || !semver.test(manifest.version)) {
      throw new Error(`${directory} source manifest version must be plain semver`)
    }
    if (typeof manifest.min_installer !== 'string' || !semver.test(manifest.min_installer)) {
      throw new Error(`${directory} source manifest min_installer must be plain semver`)
    }
    skills.push({
      name: directory,
      version: manifest.version,
      minInstaller: manifest.min_installer,
      native: typeof manifest.runtime === 'string' && manifest.runtime.length > 0,
    })
  }
  return skills
}

function readFragment(path: string, target: TargetKey): Fragment {
  if (!existsSync(path)) throw new Error(`missing ${target} manifest fragment: ${path}`)
  const fragment = JSON.parse(readFileSync(path, 'utf8')) as Fragment
  if (fragment.format !== 2) throw new Error(`${target} manifest fragment must use format 2`)
  if (!fragment.installer || typeof fragment.installer !== 'object') throw new Error(`${target} fragment is missing installer metadata`)
  if (typeof fragment.installer.version !== 'string' || !semver.test(fragment.installer.version)) {
    throw new Error(`${target} fragment has invalid installer version`)
  }
  if (!fragment.installer.artifacts || typeof fragment.installer.artifacts !== 'object') {
    throw new Error(`${target} fragment is missing installer artifacts`)
  }
  if (!fragment.skills || typeof fragment.skills !== 'object') throw new Error(`${target} fragment is missing skills metadata`)
  return fragment
}

export function aggregateRelease({ inputRoot, outputRoot, releaseTag }: AggregateOptions): string {
  if (!/^[A-Za-z0-9._-]+$/.test(releaseTag)) throw new Error(`invalid release tag: ${releaseTag}`)
  const releaseBase = `https://github.com/jacoblockett/jl-skills/releases/download/${releaseTag}`
  const skills = sourceSkills()
  const nativeSkills = skills.filter((skill) => skill.native)
  const portableSkills = skills.filter((skill) => !skill.native)
  const fragments = new Map<TargetKey, { root: string; manifest: Fragment }>()

  let installerVersion: string | undefined
  for (const key of TARGET_KEYS) {
    const targetRoot = join(inputRoot, `target-${key}`)
    if (!existsSync(targetRoot) || !statSync(targetRoot).isDirectory()) {
      throw new Error(`required target artifact directory is missing: target-${key}`)
    }
    const manifest = readFragment(join(targetRoot, 'manifest.json'), key)
    if (installerVersion === undefined) installerVersion = manifest.installer.version
    else if (manifest.installer.version !== installerVersion) {
      throw new Error(`${key} installer version ${manifest.installer.version} does not match ${installerVersion}`)
    }

    exactKeys(manifest.installer.artifacts, [key], `${key} installer artifact map`)
    const expectedSkills = [
      ...nativeSkills.map((skill) => skill.name),
      ...(key === portableBuildTarget ? portableSkills.map((skill) => skill.name) : []),
    ].sort()
    exactKeys(manifest.skills, expectedSkills, `${key} skill set`)
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

  const releasedSkills: Record<string, { version: string; min_installer: string; artifacts: Record<string, Artifact> }> = {}
  for (const skill of skills) {
    const artifacts: Record<string, Artifact> = {}
    if (skill.native) {
      for (const key of TARGET_KEYS) {
        const target = targetByKey(key)
        const fragment = fragments.get(key)!
        const released = fragment.manifest.skills[skill.name]
        if (!released) throw new Error(`${skill.name} is missing from ${key}`)
        if (released.version !== skill.version || released.min_installer !== skill.minInstaller) {
          throw new Error(`${skill.name} metadata in ${key} does not match its source manifest`)
        }
        exactKeys(released.artifacts, [key], `${skill.name} ${key} artifact map`)
        const name = skillArchiveName(skill.name, target)
        const source = join(fragment.root, name)
        const expectedUrl = `${releaseBase}/${name}`
        artifacts[key] = assertArtifact(released.artifacts[key], source, expectedUrl, `${skill.name} ${key}`)
        copyFileSync(source, join(outputRoot, name))
      }
    } else {
      const fragment = fragments.get(portableBuildTarget)!
      const released = fragment.manifest.skills[skill.name]
      if (!released) throw new Error(`${skill.name} portable package is missing from ${portableBuildTarget}`)
      if (released.version !== skill.version || released.min_installer !== skill.minInstaller) {
        throw new Error(`${skill.name} portable metadata does not match its source manifest`)
      }
      exactKeys(released.artifacts, ['portable'], `${skill.name} portable artifact map`)
      const name = skillArchiveName(skill.name, 'portable')
      const source = join(fragment.root, name)
      const expectedUrl = `${releaseBase}/${name}`
      artifacts.portable = assertArtifact(released.artifacts.portable, source, expectedUrl, `${skill.name} portable`)
      copyFileSync(source, join(outputRoot, name))
    }

    releasedSkills[skill.name] = {
      version: skill.version,
      min_installer: skill.minInstaller,
      artifacts,
    }
  }

  exactKeys(installerArtifacts, [...TARGET_KEYS], 'aggregated installer target set')
  for (const skill of nativeSkills) exactKeys(releasedSkills[skill.name].artifacts, [...TARGET_KEYS], `${skill.name} aggregated target set`)
  for (const skill of portableSkills) exactKeys(releasedSkills[skill.name].artifacts, ['portable'], `${skill.name} aggregated portable set`)

  const output = join(outputRoot, 'manifest.json')
  writeFileSync(output, `${JSON.stringify({
    format: 2,
    installer: {
      version: installerVersion,
      artifacts: installerArtifacts,
    },
    skills: releasedSkills,
  }, null, 2)}\n`)

  console.log(`Aggregated ${TARGET_KEYS.length} required targets into ${outputRoot}`)
  return output
}

if (import.meta.main) {
  const inputRoot = resolve(process.env.JL_SKILLS_AGGREGATE_INPUT?.trim() || join(repo, 'build', 'targets'))
  const outputRoot = resolve(process.env.JL_SKILLS_AGGREGATE_OUTPUT?.trim() || join(repo, 'build', 'release'))
  const releaseTag = process.env.JL_SKILLS_RELEASE_TAG?.trim()
  if (!releaseTag) throw new Error('JL_SKILLS_RELEASE_TAG is required for release aggregation')
  aggregateRelease({ inputRoot, outputRoot, releaseTag })
}
