import * as prompts from '@clack/prompts'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { arch, homedir, platform } from 'node:os'
import { dirname, join, normalize, resolve } from 'node:path'
import { Buffer } from 'node:buffer'
import { catalog } from './catalog.generated'

const VERSION = '0.5.0'
const PROMPTS_VERSION = '1.7.0'
const isWindows = platform() === 'win32'

type Manifest = {
  name: string
  version: string
  description: string
  skill_files: string[]
  runtime_files?: string[]
  runtime?: string
  runtime_artifacts?: Record<string, string>
  runtime_shared_files?: Record<string, string>
  runtime_cli?: string
  cli_token?: string
  instruction_fragment?: string
}

type Scope = {
  kind: 'user' | 'project'
  identity: string
  root: string
}

type Receipt = {
  skill: string
  version: string
  scope: Scope
  agent: string
  skill_path: string
  runtime_root: string
  updated_at: string
}

type Registry = { installations: Receipt[] }
type AgentSpec = { id: string; label: string; command: string }
type AgentInfo = AgentSpec & { detected: boolean }
type ParsedInstall = { skills: string[]; scope?: string; agents: string[] }
type ParsedUpdate = { skills: string[]; scope?: string; agents: string[] }
type UpdateGroup = { key: string; skill: string; scope: Scope; agents: string[] }

const agentCatalog: AgentSpec[] = [
  { id: 'codex', label: 'OpenAI Codex', command: 'codex' },
  { id: 'claude', label: 'Claude Code', command: 'claude' },
]

function cancel(): never {
  prompts.cancel('Operation cancelled')
  process.exit(0)
}

function checked<T>(value: T | symbol): T {
  if (prompts.isCancel(value)) cancel()
  return value as T
}

function rawUserHome(): string {
  return process.env.USERPROFILE || process.env.HOME || homedir()
}

function expandPath(raw: string): string {
  let value = raw.trim()
  value = value.replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? whole)
  value = value.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, braced, plain) => {
    const name = braced || plain
    return process.env[name] ?? whole
  })
  if (value === '~') return rawUserHome()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(rawUserHome(), value.slice(2))
  return value
}

function canonicalPath(raw: string): string {
  const absolute = resolve(expandPath(raw))
  if (existsSync(absolute)) {
    try {
      return normalize(realpathSync.native(absolute))
    } catch {}
  }
  return normalize(absolute)
}

function userHome(): string {
  return canonicalPath(rawUserHome())
}

function installerDataRoot(): string {
  if (isWindows) {
    const local = process.env.LOCALAPPDATA || join(userHome(), 'AppData', 'Local')
    return canonicalPath(join(local, 'JL-Skills'))
  }
  const data = process.env.XDG_DATA_HOME || join(userHome(), '.local', 'share')
  return canonicalPath(join(data, 'JL-Skills'))
}

function resolveScope(raw: string): Scope {
  const value = raw.trim()
  if (value === 'user') return { kind: 'user', identity: 'user', root: userHome() }
  if (value === 'cwd') {
    const root = canonicalPath(process.cwd())
    return { kind: 'project', identity: root, root }
  }
  if (!value) throw new Error('empty scope')
  const root = canonicalPath(value)
  if (existsSync(root) && !statSync(root).isDirectory()) throw new Error(`scope path is not a directory: ${root}`)
  return { kind: 'project', identity: root, root }
}

function commandExists(command: string): boolean {
  const result = spawnSync(isWindows ? 'where' : 'which', [command], { stdio: 'ignore', windowsHide: true })
  return result.status === 0
}

function normalizeAgents(raw: string[]): string[] {
  const out = new Set<string>()
  for (const item of raw) {
    let id = item.trim().toLowerCase()
    if (id === 'claude-code') id = 'claude'
    if (!agentCatalog.some((agent) => agent.id === id)) throw new Error(`unsupported agent "${item}"`)
    out.add(id)
  }
  return [...out].sort()
}

function harnessDetected(spec: AgentSpec): boolean {
  if (commandExists(spec.command)) return true
  const home = userHome()
  if (spec.id === 'codex') {
    return [join(home, '.codex', 'config.toml'), join(home, '.codex', 'sessions'), join(home, '.codex', 'AGENTS.md')]
      .some(existsSync)
  }
  if (spec.id === 'claude') {
    return [join(home, '.claude', 'settings.json'), join(home, '.claude', 'projects'), join(home, '.claude.json')]
      .some(existsSync)
  }
  return false
}

function detectedAgents(): AgentInfo[] {
  return agentCatalog.map((agent) => ({ ...agent, detected: harnessDetected(agent) }))
}

function agentPaths(agent: string, scope: Scope): { skillRoot: string; instruction: string } {
  const home = userHome()
  if (agent === 'codex') {
    if (scope.kind === 'user') {
      return { skillRoot: join(home, '.agents', 'skills'), instruction: join(home, '.codex', 'AGENTS.md') }
    }
    return { skillRoot: join(scope.root, '.agents', 'skills'), instruction: join(scope.root, 'AGENTS.md') }
  }
  if (agent === 'claude') {
    if (scope.kind === 'user') {
      return { skillRoot: join(home, '.claude', 'skills'), instruction: join(home, '.claude', 'CLAUDE.md') }
    }
    return { skillRoot: join(scope.root, '.claude', 'skills'), instruction: join(scope.root, 'CLAUDE.md') }
  }
  throw new Error(`unsupported agent "${agent}"`)
}

function loadManifest(name: string): Manifest {
  const item = catalog[name]
  if (!item) throw new Error(`unknown skill "${name}"`)
  const manifest = item.manifest as Manifest
  if (!manifest.name || !manifest.version || !Array.isArray(manifest.skill_files) || manifest.skill_files.length === 0) {
    throw new Error(`invalid manifest for ${name}`)
  }
  return manifest
}

function catalogManifests(): Manifest[] {
  return Object.keys(catalog).sort().map(loadManifest)
}

function decodeAsset(skill: string, rel: string): Uint8Array {
  const item = catalog[skill]
  const encoded = item?.files?.[rel.replaceAll('\\', '/')]
  if (encoded === undefined) throw new Error(`missing embedded asset ${skill}/${rel}`)
  return Uint8Array.from(Buffer.from(encoded, 'base64'))
}

function atomicWrite(path: string, data: string | Uint8Array, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.jl-skill-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  try {
    writeFileSync(tmp, data)
    try { chmodSync(tmp, mode) } catch {}
    if (isWindows && existsSync(path)) rmSync(path, { force: true })
    renameSync(tmp, path)
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch {}
    throw error
  }
}

function render(text: string, tokens: Record<string, string>): string {
  let result = text
  for (const [from, to] of Object.entries(tokens)) result = result.replaceAll(from, to)
  return result
}

function extractAsset(skill: string, rel: string, dest: string, tokens?: Record<string, string>, mode = 0o644): void {
  const bytes = decodeAsset(skill, rel)
  if (!tokens) return atomicWrite(dest, bytes, mode)
  atomicWrite(dest, render(new TextDecoder().decode(bytes), tokens), mode)
}

function managedBlock(path: string, skill: string, fragment: string): void {
  const begin = `<!-- jl-skill:begin ${skill} -->`
  const end = `<!-- jl-skill:end ${skill} -->`
  const block = `${begin}\n${fragment.trim()}\n${end}`
  let current = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const beginIndex = current.indexOf(begin)
  const endIndex = current.indexOf(end)
  if ((beginIndex >= 0) !== (endIndex >= 0)) throw new Error(`malformed jl-skill block in ${path}`)
  if (beginIndex >= 0) {
    if (current.split(begin).length !== 2 || current.split(end).length !== 2 || endIndex < beginIndex) {
      throw new Error(`ambiguous jl-skill block in ${path}`)
    }
    current = current.slice(0, beginIndex) + block + current.slice(endIndex + end.length)
  } else if (!current.trim()) {
    current = `${block}\n`
  } else {
    current = `${current.replace(/[\r\n]+$/, '')}\n\n${block}\n`
  }
  atomicWrite(path, current)
}

function registryPath(): string {
  return join(installerDataRoot(), 'registry.json')
}

function loadRegistry(): Registry {
  const path = registryPath()
  if (!existsSync(path)) return { installations: [] }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Registry
  if (!Array.isArray(parsed.installations)) parsed.installations = []
  return parsed
}

function saveReceipt(receipt: Receipt): void {
  const registry = loadRegistry()
  registry.installations = registry.installations.filter((old) => !(
    old.skill === receipt.skill && old.scope.identity === receipt.scope.identity && old.agent === receipt.agent
  ))
  registry.installations.push(receipt)
  atomicWrite(registryPath(), `${JSON.stringify(registry, null, 2)}\n`)
}

function runtimePlatformKey(): string {
  if (platform() === 'win32' && arch() === 'x64') return 'windows-x64'
  if (platform() === 'linux' && arch() === 'x64') return 'linux-x64'
  if (platform() === 'darwin' && arch() === 'arm64') return 'macos-arm64'
  return `${platform()}-${arch()}`
}

function runtimeRoot(manifest: Manifest, scope: Scope): string {
  if (scope.kind === 'user') return join(installerDataRoot(), manifest.name, 'runtime', manifest.version)
  return join(scope.root, '.jl-skill', 'runtime', manifest.name, manifest.version)
}

function provisionRuntime(manifest: Manifest, scope: Scope): { cli: string; root: string } {
  if (manifest.runtime !== 'rust') throw new Error(`unsupported runtime "${manifest.runtime ?? ''}"`)
  if (!manifest.runtime_cli) throw new Error(`${manifest.name} manifest is missing runtime_cli`)
  const artifact = manifest.runtime_artifacts?.[runtimePlatformKey()]
  if (!artifact) throw new Error(`${manifest.name} has no bundled runtime for ${runtimePlatformKey()}`)
  const root = runtimeRoot(manifest, scope)
  mkdirSync(root, { recursive: true })
  const cli = join(root, isWindows ? `${manifest.runtime_cli}.exe` : manifest.runtime_cli)
  extractAsset(manifest.name, artifact, cli, undefined, 0o755)
  for (const rel of manifest.runtime_files ?? []) extractAsset(manifest.name, rel, join(root, rel))
  for (const [rel, destination] of Object.entries(manifest.runtime_shared_files ?? {})) {
    extractAsset(manifest.name, rel, canonicalPath(destination))
  }
  return { cli, root }
}

function installOne(manifest: Manifest, scope: Scope, agents: string[]): void {
  if (scope.kind === 'project') mkdirSync(scope.root, { recursive: true })
  const runtime = provisionRuntime(manifest, scope)
  const tokenName = manifest.cli_token || 'JL_SKILL_CLI'
  const tokens = { [`{{${tokenName}}}`]: normalize(runtime.cli) }
  const fragment = manifest.instruction_fragment
    ? render(new TextDecoder().decode(decodeAsset(manifest.name, manifest.instruction_fragment)), tokens)
    : ''

  for (const agent of agents) {
    const paths = agentPaths(agent, scope)
    const dest = join(paths.skillRoot, manifest.name)
    for (const rel of manifest.skill_files) extractAsset(manifest.name, rel, join(dest, rel), tokens)
    if (fragment) managedBlock(paths.instruction, manifest.name, fragment)
    saveReceipt({
      skill: manifest.name,
      version: manifest.version,
      scope,
      agent,
      skill_path: dest,
      runtime_root: runtime.root,
      updated_at: new Date().toISOString(),
    })
    console.log(`Installed ${manifest.name} ${manifest.version} for ${agent} at ${dest}`)
  }
}

function parseInstall(args: string[]): ParsedInstall {
  const out: ParsedInstall = { skills: [], agents: [] }
  const body = args[0] === 'install' ? args.slice(1) : args
  for (let i = 0; i < body.length; i++) {
    const arg = body[i]
    if (arg === '--scope') {
      if (i + 1 >= body.length) throw new Error('--scope requires user, cwd, or a path')
      out.scope = body[++i]
    } else if (arg.startsWith('--scope=')) out.scope = arg.slice('--scope='.length)
    else if (arg === '--agent') {
      if (i + 1 >= body.length) throw new Error('--agent requires a harness name')
      out.agents.push(body[++i])
    } else if (arg.startsWith('--agent=')) out.agents.push(arg.slice('--agent='.length))
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`)
    else out.skills.push(arg)
  }
  return out
}

function parseUpdate(args: string[]): ParsedUpdate {
  const out: ParsedUpdate = { skills: [], agents: [] }
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--scope') {
      if (i + 1 >= args.length) throw new Error('--scope requires user, cwd, or a path')
      out.scope = args[++i]
    } else if (arg.startsWith('--scope=')) out.scope = arg.slice('--scope='.length)
    else if (arg === '--agent') {
      if (i + 1 >= args.length) throw new Error('--agent requires a harness name')
      out.agents.push(args[++i])
    } else if (arg.startsWith('--agent=')) out.agents.push(arg.slice('--agent='.length))
    else if (arg.startsWith('-')) throw new Error(`unknown update option ${arg}`)
    else out.skills.push(arg)
  }
  return out
}

function agentLabel(id: string, agents: AgentInfo[]): string {
  return agents.find((item) => item.id === id)?.label ?? id
}

async function chooseAgents(explicit: string[], ensureIntro: () => void): Promise<{ values: string[]; prompted: boolean; all: AgentInfo[] }> {
  const all = detectedAgents()
  if (explicit.length > 0) return { values: normalizeAgents(explicit), prompted: false, all }
  const detected = all.filter((item) => item.detected).map((item) => item.id)
  if (detected.length === 1) return { values: detected, prompted: false, all }
  if (!process.stdin.isTTY) {
    if (detected.length === 0) throw new Error('no supported harness detected; specify --agent')
    return { values: detected, prompted: false, all }
  }
  ensureIntro()
  const values = checked<string[]>(await prompts.multiselect({
    message: detected.length > 1 ? 'Select AI harnesses' : 'Select AI harnesses to target',
    options: all.map((item) => ({ value: item.id, label: item.label, hint: item.detected ? 'detected' : undefined })),
    initialValues: detected,
    required: true,
  }))
  return { values: normalizeAgents(values), prompted: true, all }
}

async function installWizard(args: string[]): Promise<number> {
  const parsed = parseInstall(args)
  let prompted = false
  let introShown = false
  const ensureIntro = () => {
    if (!introShown) {
      prompts.intro('jl-skill')
      introShown = true
    }
  }

  let skills = parsed.skills
  if (skills.length === 0) {
    if (!process.stdin.isTTY) throw new Error('no skills selected')
    ensureIntro()
    const available = catalogManifests()
    skills = checked<string[]>(await prompts.multiselect({
      message: 'Select skills to install',
      options: available.map((item) => ({ value: item.name, label: item.name, hint: item.description || undefined })),
      initialValues: available.length === 1 ? [available[0].name] : undefined,
      required: true,
    }))
    prompted = true
  }
  skills.forEach(loadManifest)

  let scopeRaw = parsed.scope
  if (!scopeRaw) {
    if (!process.stdin.isTTY) throw new Error('--scope is required in non-interactive mode')
    ensureIntro()
    const choice = checked<string>(await prompts.select({
      message: 'Where should the selected skills be installed?',
      options: [
        { value: 'cwd', label: 'Current directory', hint: process.cwd() },
        { value: 'user', label: 'User' },
        { value: 'custom', label: 'Custom path' },
      ],
      initialValue: 'cwd',
    }))
    scopeRaw = choice === 'custom'
      ? checked<string>(await prompts.text({
          message: 'Custom path',
          placeholder: process.cwd(),
          validate: (value) => value.trim() ? undefined : 'Path is required',
        })).trim()
      : choice
    prompted = true
  }

  const scope = resolveScope(scopeRaw)
  const agentChoice = await chooseAgents(parsed.agents, ensureIntro)
  const agents = agentChoice.values
  prompted = prompted || agentChoice.prompted

  if (prompted) {
    prompts.note(
      `Skills: ${skills.join(', ')}\nHarnesses: ${agents.map((id) => agentLabel(id, agentChoice.all)).join(', ')}\nScope: ${scope.identity}\nMap state: not initialized by installer`,
      'Planned installation',
    )
    const proceed = checked<boolean>(await prompts.confirm({ message: 'Continue?', initialValue: true }))
    if (!proceed) cancel()
  } else {
    console.log(`Scope: ${scope.identity}`)
    console.log(`Agents: ${agents.join(', ')}`)
    console.log(`Skills: ${skills.join(', ')}`)
  }

  for (const skill of skills) installOne(loadManifest(skill), scope, agents)
  if (prompted) prompts.outro('Installation complete')
  return 0
}

function groupInstallations(registry: Registry): UpdateGroup[] {
  const groups = new Map<string, UpdateGroup>()
  for (const receipt of registry.installations) {
    const key = `${receipt.skill}\u0000${receipt.scope.kind}\u0000${receipt.scope.identity}`
    const group = groups.get(key) ?? { key, skill: receipt.skill, scope: receipt.scope, agents: [] }
    if (!group.agents.includes(receipt.agent)) group.agents.push(receipt.agent)
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key))
}

function matchingUpdateGroups(parsed: ParsedUpdate): UpdateGroup[] {
  const requestedAgents = normalizeAgents(parsed.agents)
  const scope = parsed.scope ? resolveScope(parsed.scope) : undefined
  return groupInstallations(loadRegistry()).map((group) => ({
    ...group,
    agents: requestedAgents.length > 0 ? group.agents.filter((agent) => requestedAgents.includes(agent)) : group.agents,
  })).filter((group) => {
    if (parsed.skills.length > 0 && !parsed.skills.includes(group.skill)) return false
    if (scope && group.scope.identity !== scope.identity) return false
    return group.agents.length > 0
  })
}

async function updateWizard(args: string[]): Promise<number> {
  const parsed = parseUpdate(args)
  let groups = matchingUpdateGroups(parsed)
  if (groups.length === 0) throw new Error('no installations match update filters')
  const hasFilters = parsed.skills.length > 0 || !!parsed.scope || parsed.agents.length > 0
  const agents = detectedAgents()

  if (!hasFilters) {
    if (!process.stdin.isTTY) throw new Error('update requires filters in non-interactive mode')
    prompts.intro('jl-skill update')
    const selected = checked<string[]>(await prompts.multiselect({
      message: 'Select installations to update',
      options: groups.map((group) => ({
        value: group.key,
        label: group.skill,
        hint: `${group.scope.identity} • ${group.agents.map((id) => agentLabel(id, agents)).join(', ')}`,
      })),
      initialValues: groups.map((group) => group.key),
      required: true,
    }))
    groups = groups.filter((group) => selected.includes(group.key))
    prompts.note(
      groups.map((group) => `${group.skill} at ${group.scope.identity} [${group.agents.map((id) => agentLabel(id, agents)).join(', ')}]`).join('\n'),
      'Planned updates',
    )
    const proceed = checked<boolean>(await prompts.confirm({ message: 'Continue?', initialValue: true }))
    if (!proceed) cancel()
  }

  for (const group of groups) installOne(loadManifest(group.skill), group.scope, normalizeAgents(group.agents))
  if (!hasFilters) prompts.outro('Update complete')
  return 0
}

function printHelp(): void {
  console.log(`jl-skill\n\nUsage:\n  jl-skill [skills...] --scope user|cwd|PATH [--agent AGENT]...\n  jl-skill update [skills...] [--scope user|cwd|PATH] [--agent AGENT]...\n\nInteractive prompts use @clack/prompts ${PROMPTS_VERSION}, the same prompt package used by create-vite.\n`)
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    console.log(`jl-skill ${VERSION}`)
    return 0
  }
  if (args.some((arg) => arg === '--help' || arg === '-h') || args[0] === 'help') {
    printHelp()
    return 0
  }
  if (args[0] === 'update') return updateWizard(args)
  return installWizard(args)
}

main()
  .then((code) => { process.exitCode = code })
  .catch((error) => {
    console.error(`jl-skill: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
