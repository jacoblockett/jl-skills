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
const CANCEL = '__jl_cancel__'
const ALL = '__jl_all__'

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
  runtime_cli_destination?: string
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
  instruction_path?: string
  runtime_root: string
  updated_at: string
}

type Registry = { installations: Receipt[] }
type AgentSpec = { id: string; label: string; command: string }
type AgentInfo = AgentSpec & { detected: boolean }
type ParsedAction = { skills: string[]; scope?: string; agents: string[] }
type InstallGroup = { key: string; skill: string; scope: Scope; agents: string[] }
type Intro = { shown: boolean }

type MapProjectRegistry = {
  projects?: Array<{ projectId?: string; path?: string }>
}

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

function ensureIntro(state: Intro, title = 'jl-skill'): void {
  if (!state.shown) {
    prompts.intro(title)
    state.shown = true
  }
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

function jlSkillsRoot(): string {
  return join(userHome(), '.jl-skills')
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

function agentLabel(id: string, agents: AgentInfo[]): string {
  return agents.find((item) => item.id === id)?.label ?? id
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

function removeManagedBlock(path: string, skill: string): void {
  if (!existsSync(path)) return
  const begin = `<!-- jl-skill:begin ${skill} -->`
  const end = `<!-- jl-skill:end ${skill} -->`
  const current = readFileSync(path, 'utf8')
  const beginIndex = current.indexOf(begin)
  const endIndex = current.indexOf(end)
  if (beginIndex < 0 && endIndex < 0) return
  if ((beginIndex >= 0) !== (endIndex >= 0)) throw new Error(`malformed jl-skill block in ${path}`)
  if (current.split(begin).length !== 2 || current.split(end).length !== 2 || endIndex < beginIndex) {
    throw new Error(`ambiguous jl-skill block in ${path}`)
  }
  const before = current.slice(0, beginIndex).replace(/[\r\n]+$/, '')
  const after = current.slice(endIndex + end.length).replace(/^[\r\n]+/, '')
  const next = [before, after].filter((part) => part.length > 0).join('\n\n')
  if (!next.trim()) {
    rmSync(path, { force: true })
  } else {
    atomicWrite(path, `${next.replace(/[\r\n]+$/, '')}\n`)
  }
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

function saveRegistry(registry: Registry): void {
  atomicWrite(registryPath(), `${JSON.stringify(registry, null, 2)}\n`)
}

function saveReceipt(receipt: Receipt): void {
  const registry = loadRegistry()
  registry.installations = registry.installations.filter((old) => !(
    old.skill === receipt.skill && old.scope.identity === receipt.scope.identity && old.agent === receipt.agent
  ))
  registry.installations.push(receipt)
  saveRegistry(registry)
}

function runtimePlatformKey(): string {
  if (platform() === 'win32' && arch() === 'x64') return 'windows-x64'
  if (platform() === 'linux' && arch() === 'x64') return 'linux-x64'
  if (platform() === 'darwin' && arch() === 'arm64') return 'macos-arm64'
  return `${platform()}-${arch()}`
}

function runtimeRoot(manifest: Manifest, scope: Scope): string {
  if (manifest.runtime_cli_destination) return dirname(canonicalPath(manifest.runtime_cli_destination))
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
  const cli = manifest.runtime_cli_destination
    ? canonicalPath(manifest.runtime_cli_destination)
    : join(root, isWindows ? `${manifest.runtime_cli}.exe` : manifest.runtime_cli)
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
      instruction_path: fragment ? paths.instruction : undefined,
      runtime_root: runtime.root,
      updated_at: new Date().toISOString(),
    })
    console.log(`Installed ${manifest.name} ${manifest.version} for ${agent} at ${dest}`)
  }
}

function uninstallGroup(group: InstallGroup): void {
  const registry = loadRegistry()
  const removeAgents = new Set(group.agents)
  const receipts = registry.installations.filter((receipt) =>
    receipt.skill === group.skill
      && receipt.scope.identity === group.scope.identity
      && removeAgents.has(receipt.agent)
  )

  for (const receipt of receipts) {
    rmSync(receipt.skill_path, { recursive: true, force: true })
    const instruction = receipt.instruction_path || agentPaths(receipt.agent, receipt.scope).instruction
    removeManagedBlock(instruction, receipt.skill)
    console.log(`Uninstalled ${receipt.skill} for ${receipt.agent} from ${receipt.scope.identity}`)
  }

  registry.installations = registry.installations.filter((receipt) => !(
    receipt.skill === group.skill
      && receipt.scope.identity === group.scope.identity
      && removeAgents.has(receipt.agent)
  ))
  saveRegistry(registry)
}

function parseAction(args: string[], command: 'install' | 'update' | 'uninstall'): ParsedAction {
  const out: ParsedAction = { skills: [], agents: [] }
  const body = args[0] === command ? args.slice(1) : args
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
    else if (arg.startsWith('-')) throw new Error(`unknown ${command} option ${arg}`)
    else out.skills.push(arg)
  }
  return out
}

function groupInstallations(registry: Registry): InstallGroup[] {
  const groups = new Map<string, InstallGroup>()
  for (const receipt of registry.installations) {
    const key = `${receipt.skill}\u0000${receipt.scope.kind}\u0000${receipt.scope.identity}`
    const group = groups.get(key) ?? { key, skill: receipt.skill, scope: receipt.scope, agents: [] }
    if (!group.agents.includes(receipt.agent)) group.agents.push(receipt.agent)
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => ({ ...group, agents: group.agents.sort() }))
    .sort((a, b) => a.key.localeCompare(b.key))
}

function groupsAtScope(scope: Scope): InstallGroup[] {
  return groupInstallations(loadRegistry()).filter((group) => group.scope.identity === scope.identity)
}

function matchingGroups(parsed: ParsedAction, scope?: Scope): InstallGroup[] {
  const requestedAgents = normalizeAgents(parsed.agents)
  return groupInstallations(loadRegistry()).map((group) => ({
    ...group,
    agents: requestedAgents.length > 0 ? group.agents.filter((agent) => requestedAgents.includes(agent)) : group.agents,
  })).filter((group) => {
    if (parsed.skills.length > 0 && !parsed.skills.includes(group.skill)) return false
    if (scope && group.scope.identity !== scope.identity) return false
    return group.agents.length > 0
  })
}

async function chooseScope(state: Intro, message = 'Where would you like to manage skills?'): Promise<Scope> {
  ensureIntro(state)
  const choice = checked<string>(await prompts.select({
    message,
    options: [
      { value: 'cwd', label: 'Current directory', hint: process.cwd() },
      { value: 'user', label: 'User' },
      { value: 'custom', label: 'Custom path' },
      { value: CANCEL, label: 'Cancel' },
    ],
    initialValue: 'cwd',
  }))
  if (choice === CANCEL) cancel()
  if (choice !== 'custom') return resolveScope(choice)
  const path = checked<string>(await prompts.text({
    message: 'Custom path',
    placeholder: process.cwd(),
    validate: (value) => value.trim() ? undefined : 'Path is required',
  })).trim()
  return resolveScope(path)
}

async function chooseAgents(explicit: string[], state: Intro): Promise<{ values: string[]; prompted: boolean; all: AgentInfo[] }> {
  const all = detectedAgents()
  if (explicit.length > 0) return { values: normalizeAgents(explicit), prompted: false, all }
  const detected = all.filter((item) => item.detected).map((item) => item.id)
  if (detected.length === 1) return { values: detected, prompted: false, all }
  if (!process.stdin.isTTY) {
    if (detected.length === 0) throw new Error('no supported harness detected; specify --agent')
    return { values: detected, prompted: false, all }
  }
  ensureIntro(state)
  const values = checked<string[]>(await prompts.multiselect({
    message: detected.length > 1 ? 'Select AI harnesses' : 'Select AI harnesses to target',
    options: [
      ...all.map((item) => ({ value: item.id, label: item.label, hint: item.detected ? 'detected' : undefined })),
      { value: CANCEL, label: 'Cancel' },
    ],
    initialValues: detected,
    required: true,
  }))
  if (values.includes(CANCEL)) cancel()
  return { values: normalizeAgents(values), prompted: true, all }
}

async function exclusiveMultiselect(
  state: Intro,
  message: string,
  items: Array<{ value: string; label: string; hint?: string }>,
  allLabel: string,
): Promise<string[]> {
  ensureIntro(state)
  const selected = checked<string[]>(await prompts.multiselect({
    message,
    options: [
      ...items,
      { value: ALL, label: allLabel },
      { value: CANCEL, label: 'Cancel' },
    ],
    required: true,
  }))
  const hasAll = selected.includes(ALL)
  const hasCancel = selected.includes(CANCEL)
  if (hasAll && hasCancel) {
    const choice = checked<string>(await prompts.select({
      message: 'Choose one',
      options: [
        { value: ALL, label: allLabel },
        { value: CANCEL, label: 'Cancel' },
      ],
      initialValue: ALL,
    }))
    if (choice === CANCEL) cancel()
    return items.map((item) => item.value)
  }
  if (hasCancel) cancel()
  if (hasAll) return items.map((item) => item.value)
  return selected.filter((value) => value !== ALL && value !== CANCEL)
}

async function chooseInstallSkills(scope: Scope, state: Intro): Promise<string[]> {
  ensureIntro(state)
  const installed = new Set(groupsAtScope(scope).map((group) => group.skill))
  const selected = checked<string[]>(await prompts.multiselect({
    message: 'Select skills to install',
    options: [
      ...catalogManifests().map((item) => ({
        value: item.name,
        label: item.name,
        hint: installed.has(item.name) ? 'already installed' : item.description || undefined,
        disabled: installed.has(item.name),
      })),
      { value: CANCEL, label: 'Cancel' },
    ],
    required: true,
  }))
  if (selected.includes(CANCEL)) cancel()
  return selected
}

function installedSummary(groups: InstallGroup[]): string {
  const agents = detectedAgents()
  return groups.map((group) =>
    `${group.skill} ${loadManifest(group.skill).version} · ${group.agents.map((id) => agentLabel(id, agents)).join(', ')}`
  ).join('\n')
}

async function installAtScope(scope: Scope, skills: string[], explicitAgents: string[], state: Intro, alreadyPrompted: boolean): Promise<number> {
  if (skills.length === 0) skills = await chooseInstallSkills(scope, state)
  skills.forEach(loadManifest)
  const agentChoice = await chooseAgents(explicitAgents, state)
  const prompted = alreadyPrompted || agentChoice.prompted
  if (prompted) {
    prompts.note(
      `Skills: ${skills.join(', ')}\nHarnesses: ${agentChoice.values.map((id) => agentLabel(id, agentChoice.all)).join(', ')}\nScope: ${scope.identity}\nMap state: not initialized by installer`,
      'Planned installation',
    )
    const proceed = checked<boolean>(await prompts.confirm({ message: 'Continue?', initialValue: true }))
    if (!proceed) cancel()
  } else {
    console.log(`Scope: ${scope.identity}`)
    console.log(`Agents: ${agentChoice.values.join(', ')}`)
    console.log(`Skills: ${skills.join(', ')}`)
  }
  for (const skill of skills) installOne(loadManifest(skill), scope, agentChoice.values)
  if (prompted) prompts.outro('Installation complete')
  return 0
}

async function installWizard(args: string[]): Promise<number> {
  const parsed = parseAction(args, 'install')
  const state: Intro = { shown: false }
  let prompted = false
  let scope: Scope
  if (parsed.scope) scope = resolveScope(parsed.scope)
  else {
    if (!process.stdin.isTTY) throw new Error('--scope is required in non-interactive mode')
    scope = await chooseScope(state, 'Where should the selected skills be installed?')
    prompted = true
  }
  if (parsed.skills.length === 0 && !process.stdin.isTTY) throw new Error('no skills selected')
  if (parsed.skills.length === 0) prompted = true
  return installAtScope(scope, parsed.skills, parsed.agents, state, prompted)
}

async function updateAtScope(scope: Scope, skills: string[], explicitAgents: string[], state: Intro, prompted: boolean): Promise<number> {
  const parsed: ParsedAction = { skills, scope: scope.identity, agents: explicitAgents }
  let groups = matchingGroups(parsed, scope)
  if (skills.length === 0) {
    if (!process.stdin.isTTY) throw new Error('no skills selected for update')
    const available = groupsAtScope(scope)
    if (available.length === 0) throw new Error(`no installed skills at ${scope.identity}`)
    const selected = await exclusiveMultiselect(
      state,
      'Select skills to update',
      available.map((group) => ({
        value: group.skill,
        label: group.skill,
        hint: group.agents.join(', '),
      })),
      'Update all',
    )
    groups = available.filter((group) => selected.includes(group.skill))
    prompted = true
  }
  if (groups.length === 0) throw new Error('no installations match update filters')
  if (prompted) {
    prompts.note(groups.map((group) => `${group.skill} at ${group.scope.identity} [${group.agents.join(', ')}]`).join('\n'), 'Planned updates')
    const proceed = checked<boolean>(await prompts.confirm({ message: 'Continue?', initialValue: true }))
    if (!proceed) cancel()
  }
  for (const group of groups) installOne(loadManifest(group.skill), group.scope, normalizeAgents(group.agents))
  if (prompted) prompts.outro('Update complete')
  return 0
}

async function updateWizard(args: string[]): Promise<number> {
  const parsed = parseAction(args, 'update')
  const state: Intro = { shown: false }
  let prompted = false
  let scope: Scope
  if (parsed.scope) scope = resolveScope(parsed.scope)
  else {
    if (!process.stdin.isTTY) throw new Error('--scope is required in non-interactive mode')
    scope = await chooseScope(state, 'Where would you like to update skills?')
    prompted = true
  }
  if (parsed.skills.length === 0 && process.stdin.isTTY) prompted = true
  return updateAtScope(scope, parsed.skills, parsed.agents, state, prompted)
}

async function uninstallAtScope(scope: Scope, skills: string[], explicitAgents: string[], state: Intro, prompted: boolean): Promise<number> {
  const parsed: ParsedAction = { skills, scope: scope.identity, agents: explicitAgents }
  let groups = matchingGroups(parsed, scope)
  if (skills.length === 0) {
    if (!process.stdin.isTTY) throw new Error('no skills selected for uninstall')
    const available = groupsAtScope(scope)
    if (available.length === 0) throw new Error(`no installed skills at ${scope.identity}`)
    const selected = await exclusiveMultiselect(
      state,
      'Select skills to uninstall',
      available.map((group) => ({
        value: group.skill,
        label: group.skill,
        hint: group.agents.join(', '),
      })),
      'Uninstall all',
    )
    groups = available.filter((group) => selected.includes(group.skill))
    prompted = true
  }
  if (groups.length === 0) throw new Error('no installations match uninstall filters')
  if (prompted) {
    prompts.note(
      `${groups.map((group) => `${group.skill} at ${group.scope.identity}`).join('\n')}\n\nKeeps Map project data and shared JL-Skills program files.`,
      'Planned uninstall',
    )
    const proceed = checked<boolean>(await prompts.confirm({ message: 'Continue?', initialValue: false }))
    if (!proceed) cancel()
  }
  for (const group of groups) uninstallGroup(group)
  if (prompted) prompts.outro('Uninstall complete')
  return 0
}

async function uninstallWizard(args: string[]): Promise<number> {
  const parsed = parseAction(args, 'uninstall')
  if (parsed.skills.length === 0 && !parsed.scope && parsed.agents.length === 0) {
    if (!process.stdin.isTTY) throw new Error('uninstall requires a skill/scope in non-interactive mode')
    return uninstallEntryWizard()
  }
  const state: Intro = { shown: false }
  let prompted = false
  let scope: Scope
  if (parsed.scope) scope = resolveScope(parsed.scope)
  else {
    if (!process.stdin.isTTY) throw new Error('--scope is required in non-interactive mode')
    scope = await chooseScope(state, 'Where would you like to uninstall skills?')
    prompted = true
  }
  if (parsed.skills.length === 0 && process.stdin.isTTY) prompted = true
  return uninstallAtScope(scope, parsed.skills, parsed.agents, state, prompted)
}

function mapRegistryPath(): string {
  return join(jlSkillsRoot(), 'map', 'registry.json')
}

function knownMapProjectPaths(): string[] {
  const path = mapRegistryPath()
  if (!existsSync(path)) return []
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as MapProjectRegistry
  const paths = new Set<string>()
  for (const project of parsed.projects ?? []) {
    if (typeof project.path === 'string' && project.path.trim()) paths.add(canonicalPath(project.path))
  }
  return [...paths].sort()
}

async function confirmMapDataRemoval(state: Intro): Promise<string[]> {
  const paths = knownMapProjectPaths()
  if (paths.length === 0) return []
  ensureIntro(state)
  prompts.note(paths.map((path) => `• ${path}`).join('\n'), 'Map project data that will be deleted')
  const confirmed = checked<boolean>(await prompts.confirm({
    message: 'Permanently delete the Map data at these locations?',
    initialValue: false,
  }))
  if (!confirmed) cancel()
  return paths
}

function removeAllIntegrations(): void {
  const groups = groupInstallations(loadRegistry())
  for (const group of groups) uninstallGroup(group)
}

function removeMapProjectData(paths: string[]): void {
  for (const project of paths) {
    const mapDir = join(project, '.map')
    if (!existsSync(mapDir)) {
      console.log(`Skipped missing Map project data at ${mapDir}`)
      continue
    }
    rmSync(mapDir, { recursive: true, force: true })
    console.log(`Removed Map project data at ${mapDir}`)
  }
}

function removeProgramFiles(): void {
  rmSync(jlSkillsRoot(), { recursive: true, force: true })
  rmSync(installerDataRoot(), { recursive: true, force: true })
}

async function executeMachineRemoval(removeIntegrations: boolean, removePrograms: boolean, removeMapData: boolean, state: Intro): Promise<number> {
  if (removePrograms) removeIntegrations = true
  const projectPaths = removeMapData ? await confirmMapDataRemoval(state) : []
  prompts.note(
    [
      removeIntegrations ? 'Skills added to AI tools' : null,
      removePrograms ? 'JL-Skills program files' : null,
      removeMapData ? `Map project data (${projectPaths.length} known project${projectPaths.length === 1 ? '' : 's'})` : null,
    ].filter(Boolean).join('\n'),
    'Planned removal',
  )
  const proceed = checked<boolean>(await prompts.confirm({ message: 'Continue?', initialValue: false }))
  if (!proceed) cancel()
  if (removeMapData) removeMapProjectData(projectPaths)
  if (removeIntegrations) removeAllIntegrations()
  if (removePrograms) removeProgramFiles()
  prompts.outro('Removal complete')
  return 0
}

async function machineRemovalWizard(state: Intro = { shown: false }): Promise<number> {
  ensureIntro(state)
  const choice = checked<string>(await prompts.select({
    message: 'Remove JL-Skills from this computer',
    options: [
      { value: 'keep-data', label: 'Remove JL-Skills but keep my Map project data' },
      { value: 'with-data', label: 'Remove JL-Skills and my Map project data' },
      { value: 'choose', label: 'Choose what to remove' },
      { value: CANCEL, label: 'Cancel' },
    ],
    initialValue: 'keep-data',
  }))
  if (choice === CANCEL) cancel()
  if (choice === 'keep-data') return executeMachineRemoval(true, true, false, state)
  if (choice === 'with-data') return executeMachineRemoval(true, true, true, state)

  const selected = await exclusiveMultiselect(
    state,
    'Select what to remove',
    [
      { value: 'integrations', label: 'Skills added to my AI tools' },
      { value: 'programs', label: 'JL-Skills program files' },
      { value: 'map-data', label: 'Map project data' },
    ],
    'Remove everything',
  )
  const everything = selected.length === 3
    && ['integrations', 'programs', 'map-data'].every((value) => selected.includes(value))
  return executeMachineRemoval(
    everything || selected.includes('integrations'),
    everything || selected.includes('programs'),
    everything || selected.includes('map-data'),
    state,
  )
}

async function uninstallEntryWizard(): Promise<number> {
  const state: Intro = { shown: false }
  ensureIntro(state, 'jl-skill uninstall')
  const choice = checked<string>(await prompts.select({
    message: 'What would you like to uninstall?',
    options: [
      { value: 'skills', label: 'Skills from a project or user installation' },
      { value: 'machine', label: 'JL-Skills from this computer' },
      { value: CANCEL, label: 'Cancel' },
    ],
    initialValue: 'skills',
  }))
  if (choice === CANCEL) cancel()
  if (choice === 'machine') return machineRemovalWizard(state)
  const scope = await chooseScope(state, 'Where would you like to uninstall skills?')
  return uninstallAtScope(scope, [], [], state, true)
}

async function bareWizard(): Promise<number> {
  if (!process.stdin.isTTY) throw new Error('no command supplied')
  const state: Intro = { shown: false }
  ensureIntro(state)
  const choice = checked<string>(await prompts.select({
    message: 'What would you like to do?',
    options: [
      { value: 'manage', label: 'Manage skills' },
      { value: 'remove', label: 'Remove JL-Skills from this computer' },
      { value: CANCEL, label: 'Cancel' },
    ],
    initialValue: 'manage',
  }))
  if (choice === CANCEL) cancel()
  if (choice === 'remove') return machineRemovalWizard(state)

  const scope = await chooseScope(state)
  const installed = groupsAtScope(scope)
  if (installed.length === 0) return installAtScope(scope, [], [], state, true)

  prompts.note(installedSummary(installed), `Installed at ${scope.identity}`)
  const action = checked<string>(await prompts.select({
    message: 'What would you like to do?',
    options: [
      { value: 'install', label: 'Install new skills' },
      { value: 'update', label: 'Update installed skills' },
      { value: 'uninstall', label: 'Uninstall installed skills' },
      { value: CANCEL, label: 'Cancel' },
    ],
    initialValue: 'install',
  }))
  if (action === CANCEL) cancel()
  if (action === 'install') return installAtScope(scope, [], [], state, true)
  if (action === 'update') return updateAtScope(scope, [], [], state, true)
  return uninstallAtScope(scope, [], [], state, true)
}

function printHelp(): void {
  console.log(`jl-skill\n\nUsage:\n  jl-skill install [skills...] [--scope user|cwd|PATH] [--agent AGENT]...\n  jl-skill update [skills...] [--scope user|cwd|PATH] [--agent AGENT]...\n  jl-skill uninstall [skills...] [--scope user|cwd|PATH] [--agent AGENT]...\n\nSkill-first invocations continue to mean install. Interactive prompts use @clack/prompts ${PROMPTS_VERSION}.\n`)
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.length === 0) return bareWizard()
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    console.log(`jl-skill ${VERSION}`)
    return 0
  }
  if (args.some((arg) => arg === '--help' || arg === '-h') || args[0] === 'help') {
    printHelp()
    return 0
  }
  if (args[0] === 'update') return updateWizard(args)
  if (args[0] === 'uninstall') return uninstallWizard(args)
  return installWizard(args)
}

main()
  .then((code) => { process.exitCode = code })
  .catch((error) => {
    console.error(`jl-skill: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
