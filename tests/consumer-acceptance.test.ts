import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  installerAssetName,
  skillArchiveName,
  targetByKey,
} from '../src/targets'

const repo = resolve(import.meta.dir, '..')
const build = join(repo, 'build')
const target = targetByKey(process.env.JL_SKILLS_BUILD_TARGET?.trim() || 'windows-x64')
const installer = join(build, installerAssetName(target))
const mapArchive = join(build, skillArchiveName('map', target))
const sourceSkill = join(repo, 'skills', 'map', 'SKILL.md')
const sourceSchema = join(repo, 'skills', 'map', 'schema.surql')
const scratch = join(build, 'consumer-acceptance', target.key)
const fixtureReady = join(scratch, 'release-fixture-port.txt')
const metadata = '<!-- jl-skills-meta: {"name":"map","version":"0.5.0","format":1} -->'
const staleMetadata = '<!-- jl-skills-meta: {"name":"map","version":"0.1.0","format":1} -->'
const mapAgentNames = [
  'map-completion-auditor',
  'map-context',
  'map-discovery-reviewer',
  'map-discovery',
  'map-linguist',
  'map-state-reviewer',
  'map-state-writer',
]

let fixtureServer: ReturnType<typeof spawn> | undefined
let fixtureManifestUrl = ''

type Sandbox = {
  root: string
  home: string
  project: string
  env: NodeJS.ProcessEnv
}

type RunResult = {
  status: number
  stdout: string
  stderr: string
}

function sandbox(name: string): Sandbox {
  const root = join(scratch, name)
  rmSync(root, { recursive: true, force: true })
  const home = join(root, 'home')
  const project = join(root, 'project')
  const localAppData = join(root, 'localappdata')
  const xdgData = join(root, 'xdg-data')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  mkdirSync(localAppData, { recursive: true })
  mkdirSync(xdgData, { recursive: true })
  return {
    root,
    home,
    project,
    env: {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
      LOCALAPPDATA: localAppData,
      XDG_DATA_HOME: xdgData,
      JL_SKILLS_UPDATE_MANIFEST_URL: fixtureManifestUrl,
    },
  }
}

function run(exe: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): RunResult {
  const result = spawnSync(exe, args, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error) throw result.error
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function ok(result: RunResult): RunResult {
  if (result.status !== 0) {
    throw new Error(`command failed (${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
  return result
}

function installerRun(args: string[], s: Sandbox, cwd = s.project): RunResult {
  return run(installer, args, cwd, s.env)
}

function install(scope: string, s: Sandbox, agents: string[]): RunResult {
  const args = ['map', '--scope', scope]
  for (const agent of agents) args.push('--agent', agent)
  args.push('--instructions')
  return installerRun(args, s)
}

function update(scope: string, s: Sandbox, agents: string[]): RunResult {
  const args = ['update', 'map', '--scope', scope]
  for (const agent of agents) args.push('--agent', agent)
  return installerRun(args, s)
}

function uninstall(scope: string, s: Sandbox, agents: string[]): RunResult {
  const args = ['uninstall', 'map', '--scope', scope]
  for (const agent of agents) args.push('--agent', agent)
  return installerRun(args, s)
}

function tooling(root: string): string {
  return join(root, '.jl-skills', 'map')
}

function mapCli(root: string): string {
  return join(tooling(root), 'bin', `map${target.executableSuffix}`)
}

function mapSchema(root: string): string {
  return join(tooling(root), 'schema.surql')
}

function codexSkill(root: string): string {
  return join(root, '.agents', 'skills', 'map')
}

function claudeSkill(root: string): string {
  return join(root, '.claude', 'skills', 'map')
}

function expectCodexAgents(root: string, present = true): void {
  for (const name of mapAgentNames) {
    expect(existsSync(join(root, '.codex', 'agents', `${name}.toml`))).toBe(present)
  }
}

function expectClaudeAgents(root: string, present = true): void {
  for (const name of mapAgentNames) {
    expect(existsSync(join(root, '.claude', 'agents', `${name}.md`))).toBe(present)
  }
}

function expectTargetRuntimeManifest(skillRoot: string): void {
  const manifest = JSON.parse(readFileSync(join(skillRoot, 'manifest.json'), 'utf8'))
  expect(Object.keys(manifest.runtime_artifacts ?? {})).toEqual([target.key])
  expect(manifest.runtime_artifacts[target.key]).toBe(
    `runtime/${target.key}/map${target.executableSuffix}`,
  )
}

function expectOnlyTargetRuntimeInstalled(root: string): void {
  const bin = join(tooling(root), 'bin')
  expect(readdirSync(bin).sort()).toEqual([`map${target.executableSuffix}`])
}

beforeAll(async () => {
  if (!existsSync(installer)) throw new Error(`missing compiled installer: ${installer}`)
  if (!existsSync(mapArchive)) throw new Error(`missing Map target package: ${mapArchive}`)
  if (!existsSync(join(build, 'manifest.json'))) throw new Error('missing target release manifest')

  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true })
  fixtureServer = spawn(process.execPath, [join(repo, 'tests', 'release-fixture-server.ts')], {
    cwd: repo,
    env: { ...process.env, JL_SKILLS_FIXTURE_READY: fixtureReady },
    stdio: 'ignore',
    windowsHide: true,
  })

  for (let attempt = 0; attempt < 200 && !existsSync(fixtureReady); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  if (!existsSync(fixtureReady)) throw new Error('release fixture server did not start')
  fixtureManifestUrl = `http://127.0.0.1:${readFileSync(fixtureReady, 'utf8').trim()}/manifest.json`
})

afterAll(() => {
  fixtureServer?.kill()
  rmSync(fixtureReady, { force: true })
})

describe(`consumer acceptance: ${target.key}`, () => {
  test('compiled installer and Map package complete the project lifecycle for the exact target', () => {
    const s = sandbox('project-lifecycle')
    expect(ok(installerRun(['--version'], s)).stdout).toContain('jl-skills 0.7.0')

    ok(install(s.project, s, ['codex', 'claude']))

    expect(existsSync(join(codexSkill(s.project), 'SKILL.md'))).toBe(true)
    expect(existsSync(join(claudeSkill(s.project), 'SKILL.md'))).toBe(true)
    expectCodexAgents(s.project)
    expectClaudeAgents(s.project)
    expect(existsSync(join(s.project, 'AGENTS.md'))).toBe(true)
    expect(existsSync(join(s.project, 'CLAUDE.md'))).toBe(true)
    expect(existsSync(mapCli(s.project))).toBe(true)
    expect(existsSync(mapSchema(s.project))).toBe(true)
    expect(existsSync(join(s.project, '.map'))).toBe(false)
    expectTargetRuntimeManifest(codexSkill(s.project))
    expectTargetRuntimeManifest(claudeSkill(s.project))
    expectOnlyTargetRuntimeInstalled(s.project)
    ok(run(mapCli(s.project), ['--help'], s.project, s.env))

    ok(run(
      mapCli(s.project),
      ['--path', s.project, 'init', '--schema', mapSchema(s.project)],
      s.project,
      s.env,
    ))
    expect(existsSync(join(s.project, '.map', 'project.json'))).toBe(true)
    writeFileSync(join(s.project, 'unrelated.txt'), 'KEEP\n')

    for (const skillRoot of [codexSkill(s.project), claudeSkill(s.project)]) {
      const path = join(skillRoot, 'SKILL.md')
      writeFileSync(path, readFileSync(path, 'utf8').replace(metadata, staleMetadata))
    }
    writeFileSync(mapSchema(s.project), 'STALE SCHEMA\n')

    ok(update(s.project, s, ['codex', 'claude']))

    expect(readFileSync(join(codexSkill(s.project), 'SKILL.md'), 'utf8')).toContain(metadata)
    expect(readFileSync(join(claudeSkill(s.project), 'SKILL.md'), 'utf8')).toContain(metadata)
    expect(readFileSync(mapSchema(s.project), 'utf8')).toBe(readFileSync(sourceSchema, 'utf8'))
    expect(existsSync(join(s.project, '.map', 'project.json'))).toBe(true)
    expect(readFileSync(join(s.project, 'unrelated.txt'), 'utf8')).toBe('KEEP\n')
    expectTargetRuntimeManifest(codexSkill(s.project))
    expectOnlyTargetRuntimeInstalled(s.project)
    ok(run(mapCli(s.project), ['--help'], s.project, s.env))

    ok(uninstall(s.project, s, ['codex']))
    expect(existsSync(codexSkill(s.project))).toBe(false)
    expectCodexAgents(s.project, false)
    expect(existsSync(claudeSkill(s.project))).toBe(true)
    expectClaudeAgents(s.project)
    expect(existsSync(tooling(s.project))).toBe(true)
    expect(existsSync(join(s.project, '.map', 'project.json'))).toBe(true)

    ok(uninstall(s.project, s, ['claude']))
    expect(existsSync(claudeSkill(s.project))).toBe(false)
    expectClaudeAgents(s.project, false)
    expect(existsSync(tooling(s.project))).toBe(false)
    expect(existsSync(join(s.project, '.map', 'project.json'))).toBe(true)
    expect(readFileSync(join(s.project, 'unrelated.txt'), 'utf8')).toBe('KEEP\n')
    expect(existsSync(join(s.project, 'AGENTS.md'))).toBe(true)
    expect(existsSync(join(s.project, 'CLAUDE.md'))).toBe(true)
  })

  test('user scope stays isolated from the invocation project', () => {
    const s = sandbox('user-scope')
    const projectAgents = join(s.project, 'AGENTS.md')
    const projectClaude = join(s.project, 'CLAUDE.md')
    writeFileSync(projectAgents, 'PROJECT AGENTS\n')
    writeFileSync(projectClaude, 'PROJECT CLAUDE\n')

    ok(install('user', s, ['codex', 'claude']))

    expect(existsSync(codexSkill(s.home))).toBe(true)
    expect(existsSync(claudeSkill(s.home))).toBe(true)
    expectCodexAgents(s.home)
    expectClaudeAgents(s.home)
    expect(existsSync(mapCli(s.home))).toBe(true)
    expectTargetRuntimeManifest(codexSkill(s.home))
    expectOnlyTargetRuntimeInstalled(s.home)
    ok(run(mapCli(s.home), ['--help'], s.home, s.env))

    expect(readFileSync(projectAgents, 'utf8')).toBe('PROJECT AGENTS\n')
    expect(readFileSync(projectClaude, 'utf8')).toBe('PROJECT CLAUDE\n')
    expect(existsSync(join(s.project, '.agents'))).toBe(false)
    expect(existsSync(join(s.project, '.claude', 'skills'))).toBe(false)
    expect(existsSync(tooling(s.project))).toBe(false)

    ok(uninstall('user', s, ['codex', 'claude']))
    expect(existsSync(codexSkill(s.home))).toBe(false)
    expect(existsSync(claudeSkill(s.home))).toBe(false)
    expect(existsSync(tooling(s.home))).toBe(false)
    expect(readFileSync(projectAgents, 'utf8')).toBe('PROJECT AGENTS\n')
    expect(readFileSync(projectClaude, 'utf8')).toBe('PROJECT CLAUDE\n')
  })
})
