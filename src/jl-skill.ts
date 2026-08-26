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
import { basename, dirname, join, normalize, resolve } from 'node:path'
import { Buffer } from 'node:buffer'
import { styleText } from 'node:util'
import { catalog } from './catalog.generated'
import { exclusiveMultiselect, type ExclusiveOption } from './exclusive-multiselect'

const VERSION = '0.5.0'
const PROMPTS_VERSION = '1.7.0'
const isWindows = platform() === 'win32'
const CANCEL = '__jl_cancel__'
const BACK = '__jl_back__'
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
  instructions?: boolean
  runtime_root: string
  updated_at: string
}

type Registry = { installations: Receipt[] }
type AgentSpec = { id: string; label: string; command: string }
type AgentInfo = AgentSpec & { detected: boolean }
type ParsedAction = { skills: string[]; scope?: string; agents: string[]; instructions?: boolean }
type InstallGroup = { key: string; skill: string; scope: Scope; receipts: Receipt[] }
type Intro = { shown: boolean; selections?: Map<string, string[]> }
type NavResult<T> = T | typeof BACK
type ChoiceItem = { value: string; label: string; disabled?: boolean }

type MapProjectRegistry = {
  projects?: Array<{ projectId?: string; path?: string }>
}

const agentCatalog: AgentSpec[] = [
  { id: 'codex', label: 'OpenAI Codex', command: 'codex' },
  { id: 'claude', label: 'Claude Code', command: 'claude' },
]

function cancel(): never {
  prompts.cancel('Cancelled & exited')
  process.exit(0)
}

function checked<T>(value: T | symbol): T {
  if (prompts.isCancel(value)) cancel()
  return value as T
}

function ensureIntro(state: Intro, title = 'jl-skills'): void {
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

function agentLabel(id: string, agents: AgentSpec[] = agentCatalog): string {
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
  if (!next.trim()) rmSync(path, { force: true })
  else atomicWrite(path, `${next.replace(/[\r\n]+$/, '')}\n`)
}

function registryPath(): string {
  return join(installerDataRoot(), 'registry.json')
}

function normalizeReceipt(receipt: Receipt): Receipt {
  if (receipt.instructions === undefined) {
    receipt.instructions = true
    receipt.instruction_path ??= agentPaths(receipt.agent, receipt.scope).instruction
  }
  if (!receipt.instructions) receipt.instruction_path = undefined
  return receipt
}

function loadRegistry(): Registry {
  const path = registryPath()
  if (!existsSync(path)) return { installations: [] }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Registry
  if (!Array.isArray(parsed.installations)) parsed.installations = []
  parsed.installations = parsed.installations.map(normalizeReceipt)
  return parsed
}

function saveRegistry(registry: Registry): void {
  atomicWrite(registryPath(), `${JSON.stringify(registry, null, 2)}\n`)
}

function findReceipt(skill: string, scope: Scope, agent: string): Receipt | undefined {
  return loadRegistry().installations.find((receipt) =>
    receipt.skill === skill && receipt.scope.identity === scope.identity && receipt.agent === agent
  )
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

type InstallTarget = { agent: string; instructions: boolean }

function installTargets(
  manifest: Manifest,
  scope: Scope,
  targets: InstallTarget[],
  interactive = false,
): void {
  if (scope.kind === 'project') mkdirSync(scope.root, { recursive: true })
  const runtime = provisionRuntime(manifest, scope)
  const tokenName = manifest.cli_token || 'JL_SKILL_CLI'
  const tokens = { [`{{${tokenName}}}`]: normalize(runtime.cli) }
  const fragment = manifest.instruction_fragment
    ? render(new TextDecoder().decode(decodeAsset(manifest.name, manifest.instruction_fragment)), tokens)
    : ''

  for (const target of targets) {
    const paths = agentPaths(target.agent, scope)
    const dest = join(paths.skillRoot, manifest.name)
    for (const rel of manifest.skill_files) extractAsset(manifest.name, rel, join(dest, rel), tokens)

    const existing = findReceipt(manifest.name, scope, target.agent)
    if (target.instructions && fragment) managedBlock(paths.instruction, manifest.name, fragment)
    else if (existing?.instructions) removeManagedBlock(existing.instruction_path || paths.instruction, manifest.name)

    saveReceipt({
      skill: manifest.name,
      version: manifest.version,
      scope,
      agent: target.agent,
      skill_path: dest,
      instruction_path: target.instructions && fragment ? paths.instruction : undefined,
      instructions: target.instructions && !!fragment,
      runtime_root: runtime.root,
      updated_at: new Date().toISOString(),
    })
    if (interactive) {
      prompts.log.step(`Installed ${displaySkillName(manifest.name)} ${manifest.version} for ${agentLabel(target.agent)}`)
    } else {
      console.log(`Installed ${manifest.name} ${manifest.version} for ${target.agent} at ${dest}`)
    }
  }
}

function uninstallGroup(group: InstallGroup, showHarness = false): void {
  const registry = loadRegistry()
  const removeAgents = new Set(group.receipts.map((receipt) => receipt.agent))
  const receipts = registry.installations.filter((receipt) =>
    receipt.skill === group.skill
      && receipt.scope.identity === group.scope.identity
      && removeAgents.has(receipt.agent)
  )

  for (const receipt of receipts) {
    rmSync(receipt.skill_path, { recursive: true, force: true })
    if (receipt.instructions && receipt.instruction_path) removeManagedBlock(receipt.instruction_path, receipt.skill)
  }

  registry.installations = registry.installations.filter((receipt) => !(
    receipt.skill === group.skill
      && receipt.scope.identity === group.scope.identity
      && removeAgents.has(receipt.agent)
  ))
  saveRegistry(registry)

  if (showHarness && receipts.length === 1) {
    console.log(`Uninstalled ${group.skill} for ${receipts[0].agent} from ${group.scope.identity}`)
  } else {
    console.log(`Uninstalled ${group.skill} from ${group.scope.identity}`)
  }
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
    else if (arg === '--instructions') {
      if (command === 'uninstall') throw new Error('--instructions is not valid for uninstall')
      out.instructions = true
    } else if (arg === '--no-instructions') {
      if (command === 'uninstall') throw new Error('--no-instructions is not valid for uninstall')
      out.instructions = false
    } else if (arg.startsWith('-')) throw new Error(`unknown ${command} option ${arg}`)
    else out.skills.push(arg)
  }
  return out
}

function groupInstallations(registry: Registry): InstallGroup[] {
  const groups = new Map<string, InstallGroup>()
  for (const receipt of registry.installations.map(normalizeReceipt)) {
    const key = `${receipt.skill}\u0000${receipt.scope.kind}\u0000${receipt.scope.identity}`
    const group = groups.get(key) ?? { key, skill: receipt.skill, scope: receipt.scope, receipts: [] }
    group.receipts.push(receipt)
    groups.set(key, group)
  }
  return [...groups.values()]
    .map((group) => ({ ...group, receipts: group.receipts.sort((a, b) => a.agent.localeCompare(b.agent)) }))
    .sort((a, b) => a.key.localeCompare(b.key))
}

function groupsAtScope(scope: Scope): InstallGroup[] {
  return groupInstallations(loadRegistry()).filter((group) => group.scope.identity === scope.identity)
}

function matchingGroups(parsed: ParsedAction, scope?: Scope): InstallGroup[] {
  const requestedAgents = normalizeAgents(parsed.agents)
  return groupInstallations(loadRegistry()).map((group) => ({
    ...group,
    receipts: requestedAgents.length > 0
      ? group.receipts.filter((receipt) => requestedAgents.includes(receipt.agent))
      : group.receipts,
  })).filter((group) => {
    if (parsed.skills.length > 0 && !parsed.skills.includes(group.skill)) return false
    if (scope && group.scope.identity !== scope.identity) return false
    return group.receipts.length > 0
  })
}

function installedVersions(group: InstallGroup): string[] {
  return [...new Set(group.receipts.map((receipt) => receipt.version))].sort()
}

function updateStatus(group: InstallGroup): string {
  const available = loadManifest(group.skill).version
  const installed = installedVersions(group)
  if (installed.length === 1 && installed[0] === available) return 'up to date'
  return `${installed.join(' / ')} -> ${available}`
}

function installedSummary(groups: InstallGroup[]): string {
  return groups.map((group) => `${displaySkillName(group.skill)} ${installedVersions(group).join(' / ')}`).join('\n')
}

function displaySkillName(name: string): string {
  return name ? `${name[0].toUpperCase()}${name.slice(1)}` : name
}

function scopeDisplay(scope: Scope): string {
  return scope.kind === 'user' ? 'User account' : scope.identity
}

function humanList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? ''
  if (values.length === 2) return `${values[0]} and ${values[1]}`
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`
}

function bulletList(values: string[]): string {
  return values.map((value) => `  • ${value}`).join('\n')
}

function navOptions(allowBack: boolean): ChoiceItem[] {
  return [
    ...(allowBack ? [{ value: BACK, label: 'Go back' }] : []),
    { value: CANCEL, label: 'Cancel & exit' },
  ]
}

function selectionKey(
  message: string,
  items: ChoiceItem[],
  allowAll: boolean,
  allowBack: boolean,
): string {
  const shape = items.map((item) => `${item.value}:${item.disabled ? 'disabled' : 'enabled'}`).join('\u0000')
  return `${message}\u0000${shape}\u0000${allowAll ? 'all' : 'no-all'}\u0000${allowBack ? 'back' : 'no-back'}`
}

async function chooseMany(
  state: Intro,
  message: string,
  items: ChoiceItem[],
  {
    allowAll = true,
    allowBack = true,
    initialValues = [],
    required = true,
  }: {
    allowAll?: boolean
    allowBack?: boolean
    initialValues?: string[]
    required?: boolean
  } = {},
): Promise<NavResult<string[]>> {
  ensureIntro(state)
  const selectable = items.filter((item) => !item.disabled).map((item) => item.value)
  const options: ExclusiveOption<string>[] = [
    ...items,
    ...(allowAll && selectable.length > 0
      ? [{ value: ALL, label: 'All of the above', exclusive: true }]
      : []),
    ...(allowBack ? [{ value: BACK, label: 'Go back', exclusive: true }] : []),
    { value: CANCEL, label: 'Cancel & exit', exclusive: true },
  ]
  const key = selectionKey(message, items, allowAll, allowBack)
  const remembered = state.selections?.get(key)
  const startingValues = (remembered ?? initialValues).filter((value) => selectable.includes(value))

  const selected = checked<string[]>(await exclusiveMultiselect({
    message,
    options,
    initialValues: startingValues,
    required,
  }))

  if (selected.includes(CANCEL)) cancel()
  if (selected.includes(BACK)) return BACK
  const resolved = selected.includes(ALL) ? selectable : selected
  state.selections ??= new Map()
  state.selections.set(key, [...resolved])
  return resolved
}

async function chooseScope(
  state: Intro,
  message: string,
  allowBack = false,
): Promise<NavResult<Scope>> {
  ensureIntro(state)
  const choice = checked<string>(await prompts.select({
    message,
    options: [
      { value: 'cwd', label: 'Current directory' },
      { value: 'user', label: 'User account' },
      { value: 'custom', label: 'Custom path' },
      ...navOptions(allowBack),
    ],
    initialValue: 'cwd',
  }))
  if (choice === CANCEL) cancel()
  if (choice === BACK) return BACK
  if (choice !== 'custom') return resolveScope(choice)

  const path = checked<string>(await prompts.text({
    message: 'Custom path',
    placeholder: process.cwd(),
    validate: (value: string) => value.trim() ? undefined : 'Path is required',
  })).trim()
  return resolveScope(path)
}

async function chooseInstallSkills(
  scope: Scope,
  state: Intro,
  allowBack = true,
): Promise<NavResult<string[]>> {
  const installed = new Set(groupsAtScope(scope).map((group) => group.skill))
  return chooseMany(
    state,
    'Select skills to install',
    catalogManifests().map((item) => ({
      value: item.name,
      label: installed.has(item.name)
        ? `${displaySkillName(item.name)} — already installed`
        : displaySkillName(item.name),
      disabled: installed.has(item.name),
    })),
    { allowAll: true, allowBack },
  )
}

async function chooseAgents(
  explicit: string[],
  state: Intro,
  allowBack = true,
): Promise<NavResult<{ values: string[]; prompted: boolean; all: AgentInfo[] }>> {
  const all = detectedAgents()
  if (explicit.length > 0) return { values: normalizeAgents(explicit), prompted: false, all }

  if (!process.stdin.isTTY) {
    const detected = all.filter((item) => item.detected).map((item) => item.id)
    if (detected.length === 0) throw new Error('no supported harness detected; specify --agent')
    return { values: detected, prompted: false, all }
  }

  const values = await chooseMany(
    state,
    'Which AI harnesses should receive these skills?',
    all.map((item) => ({ value: item.id, label: item.label })),
    { allowAll: true, allowBack },
  )
  if (values === BACK) return BACK
  return { values: normalizeAgents(values), prompted: true, all }
}

function instructionFiles(agents: string[], scope: Scope): string[] {
  return [...new Set(agents.map((agent) => basename(agentPaths(agent, scope).instruction)))]
}

function instructionQuestion(
  agents: string[],
  scope: Scope,
  skills: string[],
): string {
  const files = instructionFiles(agents, scope)
  const fileText = humanList(files)
  const skillText = humanList(skills.map(displaySkillName))
  return `Add ${skillText} instructions to ${fileText}?`
}

function instructionExplanation(
  agents: string[],
  scope: Scope,
  skills: string[],
): { title: string; body: string } {
  const files = instructionFiles(agents, scope)
  const fileText = humanList(files)
  const skillText = humanList(skills.map(displaySkillName))
  const body = files.length === 1 && agents.length === 1
    ? `${fileText} contains general instructions that ${agentLabel(agents[0])} reads automatically. jl-skills can add a small section explaining how to use ${skillText} without changing the rest of the file.`
    : `${fileText} contain general instructions that your selected AI tools read automatically. jl-skills can add a small section explaining how to use ${skillText} without changing the rest of those files.`
  return { title: `About ${fileText}`, body }
}

async function chooseInstructionInjection(
  state: Intro,
  agents: string[],
  scope: Scope,
  skills: string[],
  allowBack = true,
): Promise<NavResult<boolean>> {
  ensureIntro(state)
  const explanation = instructionExplanation(agents, scope, skills)
  prompts.note(explanation.body, explanation.title)
  const choice = checked<string>(await prompts.select({
    message: `${instructionQuestion(agents, scope, skills)} ${styleText('dim', '(See above for more information.)')}`,
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
      ...navOptions(allowBack),
    ],
    initialValue: 'yes',
  }))
  if (choice === CANCEL) cancel()
  if (choice === BACK) return BACK
  return choice === 'yes'
}

async function chooseGroupSkills(
  scope: Scope,
  state: Intro,
  action: 'update' | 'uninstall',
): Promise<NavResult<InstallGroup[]>> {
  const available = groupsAtScope(scope)
  if (available.length === 0) throw new Error(`no installed skills at ${scope.identity}`)
  const verb = action === 'update' ? 'update' : 'uninstall'

  const selected = await chooseMany(
    state,
    `Select skills to ${verb}`,
    available.map((group) => ({
      value: group.skill,
      label: action === 'update'
        ? `${displaySkillName(group.skill)} — ${updateStatus(group)}`
        : displaySkillName(group.skill),
    })),
    { allowAll: true, allowBack: true },
  )
  if (selected === BACK) return BACK
  return available.filter((group) => selected.includes(group.skill))
}

function targetsForNewInstall(agents: string[], instructions: boolean): InstallTarget[] {
  return agents.map((agent) => ({ agent, instructions }))
}

function targetsForUpdate(group: InstallGroup, override?: boolean): InstallTarget[] {
  return group.receipts.map((receipt) => ({
    agent: receipt.agent,
    instructions: override ?? receipt.instructions ?? true,
  }))
}

function installationSummary(
  scope: Scope,
  skills: string[],
  agents: string[],
  instructions: boolean,
  allAgents: AgentSpec[],
): string {
  const skillNames = skills.map(displaySkillName)
  const harnessNames = agents.map((id) => agentLabel(id, allAgents))
  const files = instructionFiles(agents, scope)
  return [
    'Skills to Install',
    bulletList(skillNames),
    '',
    'Installation Location',
    bulletList([scopeDisplay(scope)]),
    '',
    'Affected AI Harnesses',
    bulletList(harnessNames),
    '',
    'Instruction Injection',
    instructions ? bulletList(files) : bulletList(['None']),
  ].join('\n')
}

async function installAtScope(
  scope: Scope,
  skills: string[],
  explicitAgents: string[],
  instructionOverride: boolean | undefined,
  state: Intro,
  allowBack = true,
  askInstructions = true,
): Promise<NavResult<number>> {
  let selectedSkills = skills

  skillStep:
  while (true) {
    if (selectedSkills.length === 0) {
      const chosen = await chooseInstallSkills(scope, state, allowBack)
      if (chosen === BACK) return BACK
      selectedSkills = chosen
    }
    selectedSkills.forEach(loadManifest)

    agentStep:
    while (true) {
      const agentChoice = await chooseAgents(explicitAgents, state, allowBack)
      if (agentChoice === BACK) {
        if (skills.length > 0) return BACK
        selectedSkills = []
        continue skillStep
      }

      instructionStep:
      while (true) {
        let instructions = instructionOverride
        if (instructions === undefined && askInstructions && process.stdin.isTTY) {
          const choice = await chooseInstructionInjection(
            state,
            agentChoice.values,
            scope,
            selectedSkills,
            true,
          )
          if (choice === BACK) continue agentStep
          instructions = choice
        }
        if (instructions === undefined) instructions = true

        const prompted = process.stdin.isTTY && (
          skills.length === 0
          || explicitAgents.length === 0
          || (askInstructions && instructionOverride === undefined)
        )

        if (prompted) {
          prompts.note(
            installationSummary(
              scope,
              selectedSkills,
              agentChoice.values,
              instructions,
              agentChoice.all,
            ),
            'Installation Summary',
          )
          const proceed = checked<boolean>(await prompts.confirm({ message: 'Continue?', initialValue: true }))
          if (!proceed) continue instructionStep
        } else {
          console.log(`Scope: ${scope.identity}`)
          console.log(`Agents: ${agentChoice.values.join(', ')}`)
          console.log(`Skills: ${selectedSkills.join(', ')}`)
        }

        for (const skill of selectedSkills) {
          installTargets(
            loadManifest(skill),
            scope,
            targetsForNewInstall(agentChoice.values, instructions),
            prompted,
          )
        }
        if (prompted) prompts.outro('Installation complete')
        return 0
      }
    }
  }
}

async function installWizard(args: string[]): Promise<number> {
  const parsed = parseAction(args, 'install')
  const state: Intro = { shown: false }

  if (parsed.scope) {
    const scope = resolveScope(parsed.scope)
    if (parsed.skills.length === 0 && !process.stdin.isTTY) throw new Error('no skills selected')
    const askInstructions = parsed.skills.length === 0 || parsed.agents.length === 0
    const instructionMode = parsed.instructions ?? (askInstructions ? undefined : true)
    const result = await installAtScope(scope, parsed.skills, parsed.agents, instructionMode, state, false, askInstructions)
    if (result === BACK) cancel()
    return result
  }

  if (!process.stdin.isTTY) throw new Error('--scope is required in non-interactive mode')
  while (true) {
    const chosenScope = await chooseScope(state, 'Where would you like to install skills?', false)
    if (chosenScope === BACK) cancel()
    const result = await installAtScope(
      chosenScope,
      parsed.skills,
      parsed.agents,
      parsed.instructions,
      state,
      true,
      true,
    )
    if (result === BACK) continue
    return result
  }
}

async function updateAtScope(
  scope: Scope,
  skills: string[],
  explicitAgents: string[],
  instructionOverride: boolean | undefined,
  state: Intro,
): Promise<NavResult<number>> {
  const parsed: ParsedAction = { skills, scope: scope.identity, agents: explicitAgents, instructions: instructionOverride }
  while (true) {
    let groups = matchingGroups(parsed, scope)
    if (skills.length === 0) {
      if (!process.stdin.isTTY) throw new Error('no skills selected for update')
      const selected = await chooseGroupSkills(scope, state, 'update')
      if (selected === BACK) return BACK
      groups = selected
    }
    if (groups.length === 0) throw new Error('no installations match update filters')

    if (process.stdin.isTTY) {
      prompts.note(groups.map((group) => `${displaySkillName(group.skill)}: ${updateStatus(group)}`).join('\n'), 'Planned updates')
      const proceed = checked<boolean>(await prompts.confirm({ message: 'Continue?', initialValue: true }))
      if (!proceed) {
        if (skills.length > 0) return BACK
        continue
      }
    }

    for (const group of groups) {
      installTargets(
        loadManifest(group.skill),
        group.scope,
        targetsForUpdate(group, instructionOverride),
        process.stdin.isTTY,
      )
    }
    if (process.stdin.isTTY) prompts.outro('Update complete')
    return 0
  }
}

async function updateWizard(args: string[]): Promise<number> {
  const parsed = parseAction(args, 'update')
  const state: Intro = { shown: false }

  if (parsed.scope) {
    const scope = resolveScope(parsed.scope)
    const result = await updateAtScope(scope, parsed.skills, parsed.agents, parsed.instructions, state)
    if (result === BACK) cancel()
    return result
  }

  if (!process.stdin.isTTY) throw new Error('--scope is required in non-interactive mode')
  while (true) {
    const chosenScope = await chooseScope(state, 'Where would you like to update skills?', false)
    if (chosenScope === BACK) cancel()
    const result = await updateAtScope(chosenScope, parsed.skills, parsed.agents, parsed.instructions, state)
    if (result === BACK) continue
    return result
  }
}

async function uninstallAtScope(
  scope: Scope,
  skills: string[],
  explicitAgents: string[],
  state: Intro,
): Promise<NavResult<number>> {
  const parsed: ParsedAction = { skills, scope: scope.identity, agents: explicitAgents }
  while (true) {
    let groups = matchingGroups(parsed, scope)
    if (skills.length === 0) {
      if (!process.stdin.isTTY) throw new Error('no skills selected for uninstall')
      const selected = await chooseGroupSkills(scope, state, 'uninstall')
      if (selected === BACK) return BACK
      groups = selected
    }
    if (groups.length === 0) throw new Error('no installations match uninstall filters')

    if (process.stdin.isTTY) {
      prompts.note(
        `${groups.map((group) => displaySkillName(group.skill)).join('\n')}\n\nSkill project data and shared jl-skills data & tooling will be kept.`,
        'Planned uninstall',
      )
      const proceed = checked<boolean>(await prompts.confirm({ message: 'Continue?', initialValue: false }))
      if (!proceed) {
        if (skills.length > 0) return BACK
        continue
      }
    }

    for (const group of groups) uninstallGroup(group, explicitAgents.length > 0)
    if (process.stdin.isTTY) prompts.outro('Uninstall complete')
    return 0
  }
}

async function uninstallWizard(args: string[]): Promise<number> {
  const parsed = parseAction(args, 'uninstall')
  if (parsed.skills.length === 0 && !parsed.scope && parsed.agents.length === 0) {
    if (!process.stdin.isTTY) throw new Error('uninstall requires a skill/scope in non-interactive mode')
    return uninstallEntryWizard()
  }

  const state: Intro = { shown: false }
  if (parsed.scope) {
    const scope = resolveScope(parsed.scope)
    const result = await uninstallAtScope(scope, parsed.skills, parsed.agents, state)
    if (result === BACK) cancel()
    return result
  }

  if (!process.stdin.isTTY) throw new Error('--scope is required in non-interactive mode')
  while (true) {
    const chosenScope = await chooseScope(state, 'Where would you like to uninstall skills?', false)
    if (chosenScope === BACK) cancel()
    const result = await uninstallAtScope(chosenScope, parsed.skills, parsed.agents, state)
    if (result === BACK) continue
    return result
  }
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

async function chooseMapDataRemoval(state: Intro): Promise<NavResult<string[]>> {
  const paths = knownMapProjectPaths()
  if (paths.length === 0) return []

  while (true) {
    const selected = await chooseMany(
      state,
      'Select Map project data to delete',
      paths.map((path) => ({ value: path, label: path })),
      {
        allowAll: true,
        allowBack: true,
        initialValues: paths,
        required: false,
      },
    )
    if (selected === BACK) return BACK
    if (selected.length === 0) return []

    prompts.note(selected.map((path) => `• ${path}`).join('\n'), 'Selected Map project data')
    const confirmed = checked<boolean>(await prompts.confirm({
      message: 'Permanently delete the selected Map project data?',
      initialValue: false,
    }))
    if (!confirmed) continue
    return selected
  }
}

async function chooseSkillProjectDataRemoval(
  state: Intro,
  selectAllByDefault = false,
): Promise<NavResult<string[]>> {
  const dataSkills: ChoiceItem[] = [{ value: 'map', label: 'Map' }]

  while (true) {
    const selected = await chooseMany(
      state,
      'Which skill project data would you like to remove?',
      dataSkills,
      {
        allowAll: dataSkills.length > 1,
        allowBack: true,
        initialValues: selectAllByDefault ? dataSkills.map((item) => item.value) : [],
        required: !selectAllByDefault,
      },
    )
    if (selected === BACK) return BACK
    if (selected.length === 0) return []

    if (selected.includes('map')) {
      const paths = await chooseMapDataRemoval(state)
      if (paths === BACK) continue
      return paths
    }
    return []
  }
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

async function executeMachineRemoval(
  removeIntegrations: boolean,
  removePrograms: boolean,
  projectPaths: string[],
  state: Intro,
): Promise<NavResult<number>> {
  if (removePrograms) removeIntegrations = true
  prompts.note(
    [
      removeIntegrations ? 'Skills added to my AI tools' : null,
      removePrograms ? 'jl-skills data & tooling' : null,
      projectPaths.length > 0 ? `Map project data (${projectPaths.length} selected)` : null,
    ].filter(Boolean).join('\n'),
    'Planned removal',
  )
  const proceed = checked<boolean>(await prompts.confirm({ message: 'Continue?', initialValue: false }))
  if (!proceed) return BACK

  if (projectPaths.length > 0) removeMapProjectData(projectPaths)
  if (removeIntegrations) removeAllIntegrations()
  if (removePrograms) removeProgramFiles()
  prompts.outro('Removal complete')
  return 0
}

async function chooseMachineParts(
  state: Intro,
): Promise<NavResult<{ integrations: boolean; programs: boolean; projectData: boolean }>> {
  const selected = await chooseMany(
    state,
    'Select what to remove',
    [
      { value: 'integrations', label: 'Skills added to my AI tools' },
      { value: 'programs', label: 'jl-skills data & tooling' },
      { value: 'project-data', label: 'Skill project data' },
    ],
    { allowAll: true, allowBack: true },
  )
  if (selected === BACK) return BACK
  return {
    integrations: selected.includes('integrations'),
    programs: selected.includes('programs'),
    projectData: selected.includes('project-data'),
  }
}

async function machineRemovalWizard(state: Intro = { shown: false }): Promise<NavResult<number>> {
  ensureIntro(state)

  while (true) {
    const choice = checked<string>(await prompts.select({
      message: 'How would you like to remove jl-skills?',
      options: [
        { value: 'keep-data', label: 'Remove jl-skills data & tooling, but keep skill project data' },
        { value: 'with-data', label: 'Remove jl-skills data & tooling and skill project data' },
        { value: 'choose', label: 'Choose what to remove' },
        ...navOptions(true),
      ],
      initialValue: 'keep-data',
    }))
    if (choice === CANCEL) cancel()
    if (choice === BACK) return BACK

    if (choice === 'keep-data') {
      const result = await executeMachineRemoval(true, true, [], state)
      if (result === BACK) continue
      return result
    }

    if (choice === 'with-data') {
      const projectPaths = await chooseSkillProjectDataRemoval(state, true)
      if (projectPaths === BACK) continue
      const result = await executeMachineRemoval(true, true, projectPaths, state)
      if (result === BACK) continue
      return result
    }

    while (true) {
      const parts = await chooseMachineParts(state)
      if (parts === BACK) break

      let projectPaths: string[] = []
      if (parts.projectData) {
        const selected = await chooseSkillProjectDataRemoval(state)
        if (selected === BACK) continue
        projectPaths = selected
      }

      const result = await executeMachineRemoval(parts.integrations, parts.programs, projectPaths, state)
      if (result === BACK) continue
      return result
    }
  }
}

async function uninstallEntryWizard(): Promise<number> {
  const state: Intro = { shown: false }
  ensureIntro(state, 'jl-skills uninstall')

  while (true) {
    const choice = checked<string>(await prompts.select({
      message: 'What would you like to uninstall?',
      options: [
        { value: 'skills', label: 'Skills from a project or user installation' },
        { value: 'machine', label: 'jl-skills data & tooling' },
        { value: CANCEL, label: 'Cancel & exit' },
      ],
      initialValue: 'skills',
    }))
    if (choice === CANCEL) cancel()

    if (choice === 'machine') {
      const result = await machineRemovalWizard(state)
      if (result === BACK) continue
      return result
    }

    while (true) {
      const scope = await chooseScope(state, 'Where would you like to uninstall skills?', true)
      if (scope === BACK) break
      const result = await uninstallAtScope(scope, [], [], state)
      if (result === BACK) continue
      return result
    }
  }
}

async function bareWizard(): Promise<number> {
  if (!process.stdin.isTTY) throw new Error('no command supplied')
  const state: Intro = { shown: false }
  ensureIntro(state)

  while (true) {
    const choice = checked<string>(await prompts.select({
      message: 'What would you like to do?',
      options: [
        { value: 'install', label: 'Install skills' },
        { value: 'update', label: 'Update skills' },
        { value: 'uninstall', label: 'Uninstall skills' },
        { value: 'remove', label: 'Remove jl-skills data & tooling' },
        { value: CANCEL, label: 'Cancel & exit' },
      ],
      initialValue: 'install',
    }))
    if (choice === CANCEL) cancel()

    if (choice === 'remove') {
      const result = await machineRemovalWizard(state)
      if (result === BACK) continue
      return result
    }

    const scopeQuestion = choice === 'install'
      ? 'Where would you like to install skills?'
      : choice === 'update'
        ? 'Where would you like to update skills?'
        : 'Where would you like to uninstall skills?'

    while (true) {
      const scope = await chooseScope(state, scopeQuestion, true)
      if (scope === BACK) break

      const installed = groupsAtScope(scope)
      if (choice !== 'install' && installed.length === 0) {
        prompts.log.warn('No skills were detected. Choose a different scope or path.')
        continue
      }

      prompts.note(
        installed.length > 0 ? installedSummary(installed) : 'None detected.',
        'Installed at selected path',
      )

      const result = choice === 'install'
        ? await installAtScope(scope, [], [], undefined, state, true, true)
        : choice === 'update'
          ? await updateAtScope(scope, [], [], undefined, state)
          : await uninstallAtScope(scope, [], [], state)

      if (result === BACK) continue
      return result
    }
  }
}

function printHelp(): void {
  console.log(`jl-skills\n\nUsage:\n  jl-skills install [skills...] [--scope user|cwd|PATH] [--agent AGENT]... [--instructions|--no-instructions]\n  jl-skills update [skills...] [--scope user|cwd|PATH] [--agent AGENT]... [--instructions|--no-instructions]\n  jl-skills uninstall [skills...] [--scope user|cwd|PATH] [--agent AGENT]...\n\nSkill-first invocations continue to mean install. Interactive prompts use @clack/prompts ${PROMPTS_VERSION}.\n`)
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.length === 0) return bareWizard()
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    console.log(`jl-skills ${VERSION}`)
    return 0
  }
  if (args.some((arg: string) => arg === '--help' || arg === '-h') || args[0] === 'help') {
    printHelp()
    return 0
  }
  if (args[0] === 'update') return updateWizard(args)
  if (args[0] === 'uninstall') return uninstallWizard(args)
  return installWizard(args)
}

main()
  .then((exitCode) => { process.exitCode = exitCode })
  .catch((error) => {
    console.error(`jl-skills: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })