import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const repo = resolve(import.meta.dir, '..')
const installer = join(repo, 'build', 'jl-skills.exe')
const sourceMap = join(repo, 'build', 'cargo', 'map', 'release', 'map.exe')
const sourceSkill = join(repo, 'skills', 'map', 'SKILL.md')
const schema = join(repo, 'skills', 'map', 'schema.surql')
const scratch = join(repo, 'build', 'installer-tests')
const fixtureReady = join(scratch, 'release-fixture-port.txt')

const begin = '<!-- jl-skill:begin map -->'
const end = '<!-- jl-skill:end map -->'
const metadata = '<!-- jl-skills-meta: {"name":"map","version":"0.4.0","format":1} -->'
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
  localAppData: string
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
  const localAppData = join(root, 'localappdata')
  const project = join(root, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(localAppData, { recursive: true })
  mkdirSync(project, { recursive: true })
  return {
    root,
    home,
    localAppData,
    project,
    env: {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
      LOCALAPPDATA: localAppData,
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

function install(scope: string, s: Sandbox, cwd = s.project, agents = ['codex'], instructions = true): RunResult {
  const args = ['map', '--scope', scope]
  for (const agent of agents) args.push('--agent', agent)
  args.push(instructions ? '--instructions' : '--no-instructions')
  return run(installer, args, cwd, s.env)
}

function update(scope: string, s: Sandbox, agents: string[] = [], instructions?: boolean): RunResult {
  const args = ['update', 'map', '--scope', scope]
  for (const agent of agents) args.push('--agent', agent)
  if (instructions !== undefined) args.push(instructions ? '--instructions' : '--no-instructions')
  return run(installer, args, s.project, s.env)
}

function uninstall(scope: string, s: Sandbox, agents: string[] = []): RunResult {
  const args = ['uninstall', 'map', '--scope', scope]
  for (const agent of agents) args.push('--agent', agent)
  return run(installer, args, s.project, s.env)
}

function tooling(root: string): string {
  return join(root, '.jl-skills', 'map')
}

function mapCli(root: string): string {
  return join(tooling(root), 'bin', 'map.exe')
}

function mapSchema(root: string): string {
  return join(tooling(root), 'schema.surql')
}

function mapRegistry(root: string): string {
  return join(tooling(root), 'registry.json')
}

function installerRegistry(s: Sandbox): string {
  return join(s.localAppData, 'JL-Skills', 'registry.json')
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

function read(path: string): string {
  return readFileSync(path, 'utf8')
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

beforeAll(async () => {
  if (process.platform !== 'win32') throw new Error('installer regression suite currently targets Windows x64')
  if (!existsSync(installer)) throw new Error('build/jl-skills.exe is missing; run bun run build first')
  if (!existsSync(sourceMap)) throw new Error('built Map runtime is missing; run bun run build first')
  if (!existsSync(join(repo, 'build', 'map.zip'))) throw new Error('build/map.zip is missing; run bun run build first')
  if (!existsSync(join(repo, 'build', 'manifest.json'))) throw new Error('build/manifest.json is missing; run bun run build first')
  mkdirSync(scratch, { recursive: true })
  rmSync(fixtureReady, { force: true })

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
  fixtureManifestUrl = `http://127.0.0.1:${read(fixtureReady).trim()}/manifest.json`
})

afterAll(() => {
  fixtureServer?.kill()
  rmSync(fixtureReady, { force: true })
})

describe('jl-skills installer scope regressions', () => {
  test('cwd scope installs native integration and tooling inside the project scope only', () => {
    const s = sandbox('cwd-scope')
    ok(install('cwd', s))

    const skillRoot = join(s.project, '.agents', 'skills', 'map')
    expect(existsSync(join(skillRoot, 'SKILL.md'))).toBe(true)
    expect(read(join(skillRoot, 'SKILL.md'))).toContain(metadata)
    expect(existsSync(join(skillRoot, 'manifest.json'))).toBe(true)
    expect(existsSync(join(skillRoot, 'agents'))).toBe(false)
    expectCodexAgents(s.project)
    expect(existsSync(join(s.project, 'AGENTS.md'))).toBe(true)
    expect(existsSync(join(s.project, '.map'))).toBe(false)
    expect(existsSync(mapCli(s.project))).toBe(true)
    expect(existsSync(mapSchema(s.project))).toBe(true)
    expect(existsSync(tooling(s.home))).toBe(false)
    expect(existsSync(mapRegistry(s.project))).toBe(false)
    expect(existsSync(installerRegistry(s))).toBe(false)

    const instructions = read(join(s.project, 'AGENTS.md'))
    expect(instructions).toContain(mapCli(s.project))
    expect(occurrences(instructions, begin)).toBe(1)
    expect(occurrences(instructions, end)).toBe(1)
  })

  test('user scope installs user integration and user-local tooling without touching invocation project', () => {
    const s = sandbox('user-scope')
    const projectAgents = join(s.project, 'AGENTS.md')
    writeFileSync(projectAgents, 'PROJECT INSTRUCTIONS\n')

    ok(install('user', s))

    const skillRoot = join(s.home, '.agents', 'skills', 'map')
    expect(existsSync(join(skillRoot, 'SKILL.md'))).toBe(true)
    expect(read(join(skillRoot, 'SKILL.md'))).toContain(metadata)
    expect(existsSync(join(skillRoot, 'agents'))).toBe(false)
    expectCodexAgents(s.home)
    expect(existsSync(join(s.home, '.codex', 'AGENTS.md'))).toBe(true)
    expect(existsSync(mapCli(s.home))).toBe(true)
    expect(existsSync(mapSchema(s.home))).toBe(true)
    expect(existsSync(join(s.home, '.map'))).toBe(false)
    expect(existsSync(mapRegistry(s.home))).toBe(false)
    expect(existsSync(installerRegistry(s))).toBe(false)
    expect(read(projectAgents)).toBe('PROJECT INSTRUCTIONS\n')
    expect(existsSync(join(s.project, '.agents'))).toBe(false)
    expect(existsSync(tooling(s.project))).toBe(false)
  })

  test('installing into a scope with an existing Map does not initialize or mutate semantic state', () => {
    const s = sandbox('existing-map')
    ok(run(sourceMap, ['--path', s.project, 'init', '--schema', schema], repo, s.env))
    const created = JSON.parse(ok(run(
      sourceMap,
      ['--path', s.project, 'create', 'intent', 'Persistent intent'],
      repo,
      s.env,
    )).stdout)
    const before = JSON.parse(ok(run(sourceMap, ['--path', s.project, 'status'], repo, s.env)).stdout)

    ok(install(s.project, s))

    const cli = mapCli(s.project)
    const after = JSON.parse(ok(run(cli, ['--path', s.project, 'status'], repo, s.env)).stdout)
    const shown = JSON.parse(ok(run(cli, ['--path', s.project, 'show', created.id], repo, s.env)).stdout)
    const validated = JSON.parse(ok(run(cli, ['--path', s.project, 'validate'], repo, s.env)).stdout)

    expect(after.nodes).toEqual(before.nodes)
    expect(after.depth).toBe(before.depth)
    expect(after.stance).toBe(before.stance)
    expect(shown.text).toBe('Persistent intent')
    expect(validated).toEqual({ ok: true, errors: [] })
  })

  test('existing AGENTS.md content is preserved around one managed Map block', () => {
    const s = sandbox('existing-agents')
    const agents = join(s.project, 'AGENTS.md')
    writeFileSync(agents, '# Existing instructions\n\nKEEP_THIS=yes\n')

    ok(install(s.project, s))

    const text = read(agents)
    expect(text).toContain('# Existing instructions')
    expect(text).toContain('KEEP_THIS=yes')
    expect(occurrences(text, begin)).toBe(1)
    expect(occurrences(text, end)).toBe(1)
    expect(text).toContain('Managed by jl-skills')
    expect(text).toContain(mapCli(s.project))
    expect(text).not.toContain('{{JL_MAP_CLI}}')
  })

  test('reinstall replaces the existing managed block without duplication or collateral edits', () => {
    const s = sandbox('already-injected-agents')
    const agents = join(s.project, 'AGENTS.md')
    writeFileSync(agents, 'USER PREFIX\n')
    ok(install(s.project, s))

    writeFileSync(agents, `${read(agents)}\nUSER SUFFIX\n`)
    ok(install(s.project, s))

    const text = read(agents)
    expect(text).toContain('USER PREFIX')
    expect(text).toContain('USER SUFFIX')
    expect(occurrences(text, begin)).toBe(1)
    expect(occurrences(text, end)).toBe(1)
    expect(occurrences(text, 'Managed by jl-skills')).toBe(1)
  })

  test('malformed managed boundaries are rejected without rewriting AGENTS.md', () => {
    const s = sandbox('malformed-agents')
    const agents = join(s.project, 'AGENTS.md')
    const malformed = `USER CONTENT\n\n${begin}\nDO NOT GUESS\n`
    writeFileSync(agents, malformed)

    const result = install(s.project, s)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('malformed jl-skill block')
    expect(read(agents)).toBe(malformed)
  })

  test('user-scope install preserves unrelated Codex user configuration, agents, and content', () => {
    const s = sandbox('user-scope-safety')
    const codex = join(s.home, '.codex')
    const agents = join(codex, 'AGENTS.md')
    const config = join(codex, 'config.toml')
    const unrelated = join(codex, 'unrelated.txt')
    const unrelatedAgent = join(codex, 'agents', 'keep.toml')
    const projectFile = join(s.project, 'project.txt')
    mkdirSync(dirname(unrelatedAgent), { recursive: true })
    writeFileSync(agents, 'USER AGENT INSTRUCTIONS\n')
    writeFileSync(config, 'model = "keep-me"\n')
    writeFileSync(unrelated, 'DO NOT TOUCH\n')
    writeFileSync(unrelatedAgent, 'name = "keep"\n')
    writeFileSync(projectFile, 'PROJECT DATA\n')

    ok(install('user', s))

    expect(read(config)).toBe('model = "keep-me"\n')
    expect(read(unrelated)).toBe('DO NOT TOUCH\n')
    expect(read(unrelatedAgent)).toBe('name = "keep"\n')
    expect(read(projectFile)).toBe('PROJECT DATA\n')
    expect(read(agents)).toContain('USER AGENT INSTRUCTIONS')
    expect(occurrences(read(agents), begin)).toBe(1)
    expect(existsSync(join(s.home, '.agents', 'skills', 'map', 'SKILL.md'))).toBe(true)
    expectCodexAgents(s.home)
    expect(existsSync(mapCli(s.home))).toBe(true)
    expect(existsSync(join(s.project, '.agents'))).toBe(false)
    expect(existsSync(tooling(s.project))).toBe(false)
    expect(existsSync(installerRegistry(s))).toBe(false)
  })

  test('Map tooling is isolated per installation scope', () => {
    const s = sandbox('scope-local-runtime')
    const secondProject = join(s.root, 'second', 'nested', 'project')

    ok(install('cwd', s))
    ok(install(secondProject, s))
    ok(install('user', s))

    expect(existsSync(mapCli(s.project))).toBe(true)
    expect(existsSync(mapSchema(s.project))).toBe(true)
    expect(existsSync(mapCli(secondProject))).toBe(true)
    expect(existsSync(mapSchema(secondProject))).toBe(true)
    expect(existsSync(mapCli(s.home))).toBe(true)
    expect(existsSync(mapSchema(s.home))).toBe(true)
    expect(read(join(s.project, 'AGENTS.md'))).toContain(mapCli(s.project))
    expect(read(join(secondProject, 'AGENTS.md'))).toContain(mapCli(secondProject))
    expect(read(join(s.home, '.codex', 'AGENTS.md'))).toContain(mapCli(s.home))
    expect(existsSync(installerRegistry(s))).toBe(false)
  })

  test('instruction injection can be declined without touching an existing AGENTS.md', () => {
    const s = sandbox('no-instruction-injection')
    const agents = join(s.project, 'AGENTS.md')
    writeFileSync(agents, 'USER ONLY\n')

    ok(install(s.project, s, s.project, ['codex'], false))

    expect(existsSync(join(s.project, '.agents', 'skills', 'map', 'SKILL.md'))).toBe(true)
    expectCodexAgents(s.project)
    expect(existsSync(mapCli(s.project))).toBe(true)
    expect(read(agents)).toBe('USER ONLY\n')
  })

  test('update preserves instruction opt-out from actual managed-block state', () => {
    const s = sandbox('update-preserves-instruction-choice')
    const agents = join(s.project, 'AGENTS.md')
    writeFileSync(agents, 'USER ONLY\n')
    ok(install(s.project, s, s.project, ['codex'], false))

    ok(update(s.project, s))
    expect(read(agents)).toBe('USER ONLY\n')

    ok(update(s.project, s, [], true))
    expect(read(agents)).toContain('USER ONLY')
    expect(read(agents)).toContain(begin)

    ok(update(s.project, s, [], false))
    expect(read(agents)).toBe('USER ONLY\n')
  })

  test('update replaces stale skill and scope-local tooling while preserving generated and unrelated data', () => {
    const s = sandbox('update-replaces-stale-assets')
    ok(install(s.project, s))

    const skill = join(s.project, '.agents', 'skills', 'map', 'SKILL.md')
    const staleMetadata = '<!-- jl-skills-meta: {"name":"map","version":"0.1.0","format":1} -->'
    writeFileSync(skill, `${read(sourceSkill).replace(metadata, staleMetadata)}\nSTALE_INSTALL_MARKER\n`)

    const agents = join(s.project, 'AGENTS.md')
    const agentsBefore = read(agents)
    const unrelated = join(s.project, 'unrelated.txt')
    writeFileSync(unrelated, 'KEEP UNRELATED\n')

    const mapDir = join(s.project, '.map')
    mkdirSync(mapDir, { recursive: true })
    writeFileSync(join(mapDir, 'project.json'), '{"projectId":"aaaaaaaaaaaaaaaaaaaa","createdAtMs":1}\n')
    writeFileSync(join(mapDir, 'keep.txt'), 'KEEP GENERATED\n')

    writeFileSync(mapSchema(s.project), 'STALE SCHEMA\n')

    ok(update(s.project, s))

    const updatedSkill = read(skill)
    expect(updatedSkill).toContain(metadata)
    expect(updatedSkill).not.toContain(staleMetadata)
    expect(updatedSkill).not.toContain('STALE_INSTALL_MARKER')
    expectCodexAgents(s.project)
    expect(read(agents)).toBe(agentsBefore)
    expect(read(unrelated)).toBe('KEEP UNRELATED\n')
    expect(read(join(mapDir, 'keep.txt'))).toBe('KEEP GENERATED\n')
    expect(read(join(mapDir, 'project.json'))).toContain('aaaaaaaaaaaaaaaaaaaa')
    expect(read(mapSchema(s.project))).toBe(read(schema))
  })

  test('manual self-describing skill installation is discoverable without receipts', () => {
    const s = sandbox('manual-install-discovery')
    const skillDir = join(s.project, '.agents', 'skills', 'map')
    mkdirSync(skillDir, { recursive: true })
    copyFileSync(sourceSkill, join(skillDir, 'SKILL.md'))
    writeFileSync(join(s.project, 'AGENTS.md'), 'MANUAL CONTENT\n')

    ok(update(s.project, s))

    expect(read(join(skillDir, 'SKILL.md'))).toContain(metadata)
    expectCodexAgents(s.project)
    expect(existsSync(mapCli(s.project))).toBe(true)
    expect(read(join(s.project, 'AGENTS.md'))).toBe('MANUAL CONTENT\n')
    expect(existsSync(installerRegistry(s))).toBe(false)

    ok(uninstall(s.project, s))
    expect(existsSync(skillDir)).toBe(false)
    expectCodexAgents(s.project, false)
    expect(existsSync(tooling(s.project))).toBe(false)
    expect(read(join(s.project, 'AGENTS.md'))).toBe('MANUAL CONTENT\n')
  })

  test('scoped uninstall removes installed tooling but preserves generated data and unrelated integration', () => {
    const s = sandbox('scoped-uninstall')
    const agents = join(s.project, 'AGENTS.md')
    const unrelatedAgent = join(s.project, '.codex', 'agents', 'keep.toml')
    mkdirSync(dirname(unrelatedAgent), { recursive: true })
    writeFileSync(unrelatedAgent, 'name = "keep"\n')
    writeFileSync(agents, 'USER CONTENT\n')
    ok(run(sourceMap, ['--path', s.project, 'init', '--schema', schema], repo, s.env))
    ok(install(s.project, s))

    ok(uninstall(s.project, s))

    expect(existsSync(join(s.project, '.agents', 'skills', 'map'))).toBe(false)
    expectCodexAgents(s.project, false)
    expect(read(unrelatedAgent)).toBe('name = "keep"\n')
    expect(read(agents)).toBe('USER CONTENT\n')
    expect(existsSync(join(s.project, '.map'))).toBe(true)
    expect(existsSync(tooling(s.project))).toBe(false)
    expect(existsSync(tooling(s.home))).toBe(false)
    expect(existsSync(installerRegistry(s))).toBe(false)
  })

  test('uninstall retains empty instruction file and harness parent directories', () => {
    const s = sandbox('empty-instruction-retention')
    ok(install(s.project, s))

    ok(uninstall(s.project, s))

    const agents = join(s.project, 'AGENTS.md')
    expect(existsSync(agents)).toBe(true)
    expect(read(agents)).toBe('')
    expect(existsSync(join(s.project, '.agents'))).toBe(true)
    expect(existsSync(join(s.project, '.agents', 'skills'))).toBe(true)
    expect(existsSync(join(s.project, '.codex'))).toBe(true)
    expect(existsSync(join(s.project, '.codex', 'agents'))).toBe(true)
    expect(existsSync(join(s.project, '.agents', 'skills', 'map'))).toBe(false)
    expectCodexAgents(s.project, false)
    expect(existsSync(tooling(s.project))).toBe(false)
  })

  test('uninstall does not touch instruction content when injection was declined', () => {
    const s = sandbox('uninstall-no-instructions')
    const agents = join(s.project, 'AGENTS.md')
    writeFileSync(agents, 'DO NOT TOUCH\n')
    ok(install(s.project, s, s.project, ['codex'], false))

    ok(uninstall(s.project, s))

    expect(read(agents)).toBe('DO NOT TOUCH\n')
    expect(existsSync(join(s.project, '.agents', 'skills', 'map'))).toBe(false)
    expectCodexAgents(s.project, false)
    expect(existsSync(tooling(s.project))).toBe(false)
  })

  test('user uninstall removes user-local Map tooling and retains empty user instruction file', () => {
    const s = sandbox('user-uninstall')
    ok(install('user', s))
    expect(existsSync(tooling(s.home))).toBe(true)

    ok(uninstall('user', s))

    expect(existsSync(join(s.home, '.agents', 'skills', 'map'))).toBe(false)
    expectCodexAgents(s.home, false)
    expect(existsSync(tooling(s.home))).toBe(false)
    expect(existsSync(join(s.home, '.codex', 'AGENTS.md'))).toBe(true)
    expect(read(join(s.home, '.codex', 'AGENTS.md'))).toBe('')
    expect(existsSync(join(s.home, '.agents'))).toBe(true)
    expect(existsSync(join(s.home, '.codex'))).toBe(true)
  })

  test('agent-filtered uninstall keeps tooling until the final harness integration is removed', () => {
    const s = sandbox('agent-filtered-uninstall')
    ok(install(s.project, s, s.project, ['codex', 'claude']))
    expectCodexAgents(s.project)
    expectClaudeAgents(s.project)
    expect(existsSync(tooling(s.project))).toBe(true)

    ok(uninstall(s.project, s, ['codex']))

    expect(existsSync(join(s.project, '.agents', 'skills', 'map'))).toBe(false)
    expectCodexAgents(s.project, false)
    expect(existsSync(join(s.project, '.claude', 'skills', 'map', 'SKILL.md'))).toBe(true)
    expectClaudeAgents(s.project)
    expect(existsSync(join(s.project, 'AGENTS.md'))).toBe(true)
    expect(read(join(s.project, 'AGENTS.md'))).toBe('')
    expect(read(join(s.project, 'CLAUDE.md'))).toContain(begin)
    expect(existsSync(tooling(s.project))).toBe(true)

    ok(uninstall(s.project, s, ['claude']))

    expect(existsSync(join(s.project, '.claude', 'skills', 'map'))).toBe(false)
    expectClaudeAgents(s.project, false)
    expect(existsSync(tooling(s.project))).toBe(false)
    expect(existsSync(join(s.project, 'CLAUDE.md'))).toBe(true)
    expect(read(join(s.project, 'CLAUDE.md'))).toBe('')
    expect(existsSync(join(s.project, '.claude'))).toBe(true)
    expect(existsSync(join(s.project, '.claude', 'agents'))).toBe(true)
    expect(existsSync(installerRegistry(s))).toBe(false)
  })
})
