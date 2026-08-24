import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
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

await import('./generate-catalog')

const output = join(out, 'jl-skill.exe')
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

console.log(`Built ${output}`)
