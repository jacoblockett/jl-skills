import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const repo = resolve(import.meta.dir, '..')
const build = join(repo, 'build')

test('compiled installer blocks a skill whose minimum installer is newer', async () => {
  if (process.platform !== 'win32') throw new Error('installer compatibility regression currently targets Windows x64')

  const installer = join(build, 'jl-skills.exe')
  const ready = join(build, 'min-installer-fixture-port.txt')
  const root = join(build, 'min-installer-test')
  const home = join(root, 'home')
  const localAppData = join(root, 'localappdata')
  const project = join(root, 'project')
  rmSync(root, { recursive: true, force: true })
  rmSync(ready, { force: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(localAppData, { recursive: true })
  mkdirSync(project, { recursive: true })

  const server = spawn(process.execPath, [join(repo, 'tests', 'release-fixture-server.ts')], {
    cwd: repo,
    env: { ...process.env, JL_SKILLS_FIXTURE_READY: ready },
    stdio: 'ignore',
    windowsHide: true,
  })

  try {
    for (let attempt = 0; attempt < 200 && !existsSync(ready); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    if (!existsSync(ready)) throw new Error('release fixture server did not start')

    const port = readFileSync(ready, 'utf8').trim()
    const result = spawnSync(installer, ['map', '--scope', project, '--agent', 'codex', '--instructions'], {
      cwd: project,
      env: {
        ...process.env,
        USERPROFILE: home,
        HOME: home,
        LOCALAPPDATA: localAppData,
        JL_SKILLS_UPDATE_MANIFEST_URL: `http://127.0.0.1:${port}/incompatible-manifest.json`,
      },
      encoding: 'utf8',
      windowsHide: true,
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Map 0.2.0 requires jl-skills 0.6.0 or newer; running 0.5.0.')
    expect(result.stderr).toContain('jl-skills 0.6.0 is available.')
    expect(existsSync(join(project, '.agents', 'skills', 'map'))).toBe(false)
    expect(existsSync(join(home, '.jl-skills', 'map', 'bin', 'map.exe'))).toBe(false)
  } finally {
    server.kill()
    rmSync(ready, { force: true })
    rmSync(root, { recursive: true, force: true })
  }
})
