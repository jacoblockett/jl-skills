
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
