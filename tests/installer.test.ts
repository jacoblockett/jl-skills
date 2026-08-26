import { beforeAll, describe, expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repo = resolve(import.meta.dir, '..')
const installer = join(repo, 'build', 'jl-skills.exe')
const sourceMap = join(repo, 'build', 'cargo', 'map', 'release', 'map.exe')
const sourceSkill = join(repo, 'skills', 'map', 'SKILL.md')
const schema = join(repo, 'skills', 'map', 'schema.surql')
const scratch = join(repo, 'build', 'installer-tests')

const begin = '<!-- jl-skill:begin map -->'
const end = '<!-- jl-skill:end map -->'
const metadata = '<!-- jl-skills-meta: {"name":"map","version":"0.2.0","format":1} -->'

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

function sharedMap(home: string): string {
  return join(home, '.jl-skills', 'map', 'bin', 'map.exe')
}

function sharedSchema(home: string): string {
  return join(home, '.jl-skills', 'map', 'schema.surql')
}

function installerRegistry(s: Sandbox): string {
  return join(s.localAppData, 'JL-Skills', 'registry.json')
}

function mapRegistry(home: string): string {
  return join(home, '.jl-skills', 'map', 'registry.json')
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

beforeAll(() => {
  if (process.platform !== 'win32') throw new Error('installer regression suite currently targets Windows x64')
  if (!existsSync(installer)) throw new Error('build/jl-skills.exe is missing; run bun run build first')
  if (!existsSync(sourceMap)) throw new Error('built Map runtime is missing; run bun run build first')
  mkdirSync(scratch, { recursive: true })
})

describe('jl-skills installer scope regressions', () => {
  test('cwd scope installs self-describing project discovery/instructions and shared Map support', () => {
    const s = sandbox('cwd-scope')
    ok(install('cwd', s))

    const skill = join(s.project, '.agents', 'skills', 'map', 'SKILL.md')
    expect(existsSync(skill)).toBe(true)
    expect(read(skill)).toContain(metadata)
    expect(existsSync(join(s.project, 'AGENTS.md'))).toBe(true)
    expect(existsSync(join(s.project, '.map'))).toBe(false)
    expect(existsSync(sharedMap(s.home))).toBe(true)
    expect(existsSync(sharedSchema(s.home))).toBe(true)
    expect(existsSync(mapRegistry(s.home))).toBe(false)
    expect(existsSync(installerRegistry(s))).toBe(false)
    expect(existsSync(join(s.project, '.jl-skill', 'runtime', 'map'))).toBe(false)

    const instructions = read(join(s.project, 'AGENTS.md'))
    expect(instructions).toContain(sharedMap(s.home))
    expect(occurrences(instructions, begin)).toBe(1)
    expect(occurrences(instructions, end)).toBe(1)
  })

  test('user scope installs user discovery without touching the invocation project', () => {
    const s = sandbox('user-scope')
    const projectAgents = join(s.project, 'AGENTS.md')
    writeFileSync(projectAgents, 'PROJECT INSTRUCTIONS\n')

    ok(install('user', s))

    const skill = join(s.home, '.agents', 'skills', 'map', 'SKILL.md')
    expect(existsSync(skill)).toBe(true)
    expect(read(skill)).toContain(metadata)
    expect(existsSync(join(s.home, '.codex', 'AGENTS.md'))).toBe(true)
    expect(existsSync(sharedMap(s.home))).toBe(true)
    expect(existsSync(sharedSchema(s.home))).toBe(true)
    expect(existsSync(join(s.home, '.map'))).toBe(false)
    expect(existsSync(mapRegistry(s.home))).toBe(false)
    expect(existsSync(installerRegistry(s))).toBe(false)
    expect(read(projectAgents)).toBe('PROJECT INSTRUCTIONS\n')
    expect(existsSync(join(s.project, '.agents'))).toBe(false)
    expect(existsSync(join(s.project, '.map'))).toBe(false)
  })

  test('installing into a scope with an existing Map does not initialize or mutate semantic state', () => {
    const s = sandbox('existing-map')
    ok(run(sourceMap, ['--path', s.project, 'init', '--schema', schema], repo, s.env))
    expect(existsSync(mapRegistry(s.home))).toBe(false)
    const created = JSON.parse(ok(run(
      sourceMap,
      ['--path', s.project, 'create', 'intent', 'Persistent intent'],
      repo,
      s.env,
    )).stdout)
    const before = JSON.parse(ok(run(sourceMap, ['--path', s.project, 'status'], repo, s.env)).stdout)

    ok(install(s.project, s))

    const cli = sharedMap(s.home)
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
    expect(text).toContain('Managed by jl-skill')
    expect(text).toContain(' get intents')
    expect(text).toContain(' get questions')
    expect(text).toContain(' show <id>')
    expect(text).toContain(' context <id>')
    expect(text).toContain(' search "<query>"')
    expect(text).toContain(' validate')
    expect(text).toContain(' --help')
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
    expect(occurrences(text, 'Managed by jl-skill')).toBe(1)
    expect(occurrences(text, ' get intents')).toBe(1)
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

  test('user-scope install preserves unrelated Codex user configuration and content', () => {
    const s = sandbox('user-scope-safety')
    const codex = join(s.home, '.codex')
    const agents = join(codex, 'AGENTS.md')
    const config = join(codex, 'config.toml')
    const unrelated = join(codex, 'unrelated.txt')
    const projectFile = join(s.project, 'project.txt')
    mkdirSync(codex, { recursive: true })
    writeFileSync(agents, 'USER AGENT INSTRUCTIONS\n')
    writeFileSync(config, 'model = "keep-me"\n')
    writeFileSync(unrelated, 'DO NOT TOUCH\n')
    writeFileSync(projectFile, 'PROJECT DATA\n')

    ok(install('user', s))

    expect(read(config)).toBe('model = "keep-me"\n')
    expect(read(unrelated)).toBe('DO NOT TOUCH\n')
    expect(read(projectFile)).toBe('PROJECT DATA\n')
    expect(read(agents)).toContain('USER AGENT INSTRUCTIONS')
    expect(occurrences(read(agents), begin)).toBe(1)
    expect(existsSync(join(s.home, '.agents', 'skills', 'map', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(s.project, '.agents'))).toBe(false)
    expect(existsSync(join(s.project, '.map'))).toBe(false)
    expect(existsSync(installerRegistry(s))).toBe(false)
  })

  test('Map CLI is shared at ~/.jl-skills/map/bin/map.exe for every scope without installer receipts', () => {
    const s = sandbox('shared-runtime')
    const secondProject = join(s.root, 'second', 'nested', 'project')

    ok(install('cwd', s))
    ok(install(secondProject, s))
    ok(install('user', s))

    const cli = sharedMap(s.home)
    expect(existsSync(cli)).toBe(true)
    expect(existsSync(join(s.project, '.jl-skill', 'runtime', 'map'))).toBe(false)
    expect(existsSync(join(secondProject, '.jl-skill', 'runtime', 'map'))).toBe(false)
    expect(existsSync(join(s.localAppData, 'JL-Skills', 'map', 'runtime'))).toBe(false)
    expect(existsSync(installerRegistry(s))).toBe(false)

    expect(read(join(s.project, 'AGENTS.md'))).toContain(cli)
    expect(read(join(secondProject, 'AGENTS.md'))).toContain(cli)
    expect(read(join(s.home, '.codex', 'AGENTS.md'))).toContain(cli)
  })

  test('instruction injection can be declined without touching an existing AGENTS.md', () => {
    const s = sandbox('no-instruction-injection')
    const agents = join(s.project, 'AGENTS.md')
    writeFileSync(agents, 'USER ONLY\n')

    ok(install(s.project, s, s.project, ['codex'], false))

    expect(existsSync(join(s.project, '.agents', 'skills', 'map', 'SKILL.md'))).toBe(true)
    expect(read(agents)).toBe('USER ONLY\n')
    expect(existsSync(installerRegistry(s))).toBe(false)
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
    expect(existsSync(installerRegistry(s))).toBe(false)
  })

  test('manual self-describing skill installation is discoverable without receipts', () => {
    const s = sandbox('manual-install-discovery')
    const skillDir = join(s.project, '.agents', 'skills', 'map')
    mkdirSync(skillDir, { recursive: true })
    copyFileSync(sourceSkill, join(skillDir, 'SKILL.md'))
    writeFileSync(join(s.project, 'AGENTS.md'), 'MANUAL CONTENT\n')

    ok(update(s.project, s))

    expect(read(join(skillDir, 'SKILL.md'))).toContain(metadata)
    expect(existsSync(sharedMap(s.home))).toBe(true)
    expect(read(join(s.project, 'AGENTS.md'))).toBe('MANUAL CONTENT\n')
    expect(existsSync(installerRegistry(s))).toBe(false)

    ok(uninstall(s.project, s))
    expect(existsSync(skillDir)).toBe(false)
    expect(read(join(s.project, 'AGENTS.md'))).toBe('MANUAL CONTENT\n')
  })

  test('scoped uninstall removes only owned integration and preserves Map data and shared tooling', () => {
    const s = sandbox('scoped-uninstall')
    const agents = join(s.project, 'AGENTS.md')
    writeFileSync(agents, 'USER CONTENT\n')
    ok(run(sourceMap, ['--path', s.project, 'init', '--schema', schema], repo, s.env))
    ok(install(s.project, s))

    ok(uninstall(s.project, s))

    expect(existsSync(join(s.project, '.agents', 'skills', 'map'))).toBe(false)
    expect(read(agents)).toBe('USER CONTENT\n')
    expect(existsSync(join(s.project, '.map'))).toBe(true)
    expect(existsSync(sharedMap(s.home))).toBe(true)
    expect(existsSync(sharedSchema(s.home))).toBe(true)
    expect(existsSync(mapRegistry(s.home))).toBe(false)
    expect(existsSync(installerRegistry(s))).toBe(false)
  })

  test('uninstall does not touch instruction files when injection was declined', () => {
    const s = sandbox('uninstall-no-instructions')
    const agents = join(s.project, 'AGENTS.md')
    writeFileSync(agents, 'DO NOT TOUCH\n')
    ok(install(s.project, s, s.project, ['codex'], false))

    ok(uninstall(s.project, s))

    expect(read(agents)).toBe('DO NOT TOUCH\n')
    expect(existsSync(join(s.project, '.agents', 'skills', 'map'))).toBe(false)
  })

  test('agent-filtered uninstall removes only the requested harness integration', () => {
    const s = sandbox('agent-filtered-uninstall')
    ok(install(s.project, s, s.project, ['codex', 'claude']))

    ok(uninstall(s.project, s, ['codex']))

    expect(existsSync(join(s.project, '.agents', 'skills', 'map'))).toBe(false)
    expect(existsSync(join(s.project, '.claude', 'skills', 'map', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(s.project, 'AGENTS.md'))).toBe(false)
    expect(read(join(s.project, 'CLAUDE.md'))).toContain(begin)
    expect(existsSync(installerRegistry(s))).toBe(false)
  })
})