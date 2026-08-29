import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { arch, platform } from 'node:os'

const repo = join(import.meta.dir, '..')
const out = join(repo, 'build')
mkdirSync(out, { recursive: true })

if (platform() !== 'win32' || arch() !== 'x64') {
  throw new Error('current installer build supports Windows x64 only')
}

const cargoTarget = join(out, 'cargo', 'map')
const runtimeAssets = join(out, 'runtime-assets')
const stagedMap = join(runtimeAssets, 'map', 'runtime', 'windows-x64', 'map.exe')
const publishedMap = join(out, 'map.exe')
rmSync(runtimeAssets, { recursive: true, force: true })
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
copyFileSync(stagedMap, publishedMap)

await import('./generate-catalog')

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
const version = versionMatch[1]
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`stable release version must be plain semver: ${version}`)

const mapManifest = JSON.parse(readFileSync(join(repo, 'skills', 'map', 'jl-skill.json'), 'utf8')) as { version?: string }
if (typeof mapManifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(mapManifest.version)) {
  throw new Error('Map manifest must expose a stable semantic version')
}

const installerSha256 = createHash('sha256').update(readFileSync(output)).digest('hex')
const mapSha256 = createHash('sha256').update(readFileSync(publishedMap)).digest('hex')
const releaseBase = `https://github.com/jacoblockett/jl-skills/releases/download/v${version}`
const releaseManifest = {
  format: 1,
  version,
  artifacts: {
    'windows-x64': {
      url: `${releaseBase}/jl-skills.exe`,
      sha256: installerSha256,
    },
  },
  skills: {
    map: {
      version: mapManifest.version,
      artifacts: {
        'windows-x64': {
          url: `${releaseBase}/map.exe`,
          sha256: mapSha256,
        },
      },
    },
  },
}
const manifestOutput = join(out, 'jl-skills-manifest.json')
writeFileSync(manifestOutput, `${JSON.stringify(releaseManifest, null, 2)}\n`)

console.log(`Built ${output}`)
console.log(`Built ${publishedMap}`)
console.log(`Built ${manifestOutput}`)
