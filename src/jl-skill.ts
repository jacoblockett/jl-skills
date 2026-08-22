import * as prompts from '@clack/prompts'
import { chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import coreAsset from '../build/jl-skill-core.exe' with { type: 'file' }

const VERSION = '0.2.0'
const PROMPTS_VERSION = '1.7.0'

type Manifest = {
  name: string
  version: string
  description: string
}

type AgentInfo = {
  id: string
  label: string
  detected: boolean
}

type Scope = {
  kind: string
  identity: string
  root: string
}

type Receipt = {
  skill: string
  version: string
  scope: Scope
  agent: string
}

type Registry = {
  installations?: Receipt[]
}

type ParsedInstall = {
  skills: string[]
  scope?: string
  agents: string[]
  invalid: boolean
}

let materializedCore: string | undefined

function cancel(): never {
  prompts.cancel('Operation cancelled')
  process.exit(0)
}

function checked<T>(value: T | symbol): T {
  if (prompts.isCancel(value)) cancel()
  return value as T
}

async function corePath(): Promise<string> {
  if (materializedCore) return materializedCore
  const path = join(tmpdir(), `jl-skill-core-${process.pid}-${Date.now()}.exe`)
  await Bun.write(path, Bun.file(coreAsset))
  chmodSync(path, 0o755)
  materializedCore = path
  process.on('exit', () => {
    try {
      rmSync(path, { force: true })
    } catch {}
  })
  return path
}

async function runCore(args: string[], capture = false): Promise<{ code: number; stdout: string; stderr: string }> {
  const exe = await corePath()
  const result = Bun.spawnSync([exe, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdin: 'inherit',
    stdout: capture ? 'pipe' : 'inherit',
    stderr: capture ? 'pipe' : 'inherit',
  })
  const decoder = new TextDecoder()
  return {
    code: result.exitCode,
    stdout: capture ? decoder.decode(result.stdout) : '',
    stderr: capture ? decoder.decode(result.stderr) : '',
  }
}

async function coreJSON<T>(arg: string): Promise<T> {
  const result = await runCore([arg], true)
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `installer core failed with exit ${result.code}`)
  }
  return JSON.parse(result.stdout) as T
}

function parseInstall(args: string[]): ParsedInstall {
  const out: ParsedInstall = { skills: [], agents: [], invalid: false }
  const body = args[0] === 'install' ? args.slice(1) : args
  for (let i = 0; i < body.length; i++) {
    const arg = body[i]
    if (arg === '--scope') {
      if (i + 1 >= body.length) {
        out.invalid = true
        break
      }
      out.scope = body[++i]
    } else if (arg.startsWith('--scope=')) {
      out.scope = arg.slice('--scope='.length)
    } else if (arg === '--agent') {
      if (i + 1 >= body.length) {
        out.invalid = true
        break
      }
      out.agents.push(body[++i])
    } else if (arg.startsWith('--agent=')) {
      out.agents.push(arg.slice('--agent='.length))
    } else if (arg.startsWith('-')) {
      out.invalid = true
      break
    } else {
      out.skills.push(arg)
    }
  }
  return out
}

function agentLabel(id: string, agents: AgentInfo[]): string {
  return agents.find((item) => item.id === id)?.label ?? id
}

async function chooseAgents(explicit: string[]): Promise<{ values: string[]; prompted: boolean; all: AgentInfo[] }> {
  const all = await coreJSON<AgentInfo[]>('__agents')
  if (explicit.length > 0) return { values: explicit, prompted: false, all }

  const detected = all.filter((item) => item.detected).map((item) => item.id)
  if (detected.length === 1) return { values: detected, prompted: false, all }

  const values = checked<string[]>(await prompts.multiselect({
    message: detected.length > 1 ? 'Select AI harnesses' : 'Select AI harnesses to target',
    options: all.map((item) => ({
      value: item.id,
      label: item.label,
      hint: item.detected ? 'detected' : undefined,
    })),
    initialValues: detected,
    required: true,
  }))
  return { values, prompted: true, all }
}

async function installWizard(originalArgs: string[]): Promise<number> {
  const parsed = parseInstall(originalArgs)
  if (parsed.invalid) return (await runCore(originalArgs)).code
  if (!process.stdin.isTTY) return (await runCore(originalArgs)).code

  let prompted = false
  let skills = parsed.skills
  if (skills.length === 0) {
    const catalog = await coreJSON<Manifest[]>('__catalog')
    skills = checked<string[]>(await prompts.multiselect({
      message: 'Select skills to install',
      options: catalog.map((item) => ({
        value: item.name,
        label: item.name,
        hint: item.description || undefined,
      })),
      required: true,
    }))
    prompted = true
  }

  let scope = parsed.scope
  if (!scope) {
    const scopeChoice = checked<string>(await prompts.select({
      message: 'Where should the selected skills be installed?',
      options: [
        { value: 'cwd', label: 'Current directory', hint: process.cwd() },
        { value: 'user', label: 'User' },
        { value: 'custom', label: 'Custom path' },
      ],
      initialValue: 'cwd',
    }))
    if (scopeChoice === 'custom') {
      scope = checked<string>(await prompts.text({
        message: 'Custom path:',
        placeholder: process.cwd(),
        validate: (value) => value.trim() ? undefined : 'Path is required',
      })).trim()
    } else {
      scope = scopeChoice
    }
    prompted = true
  }

  const agentChoice = await chooseAgents(parsed.agents)
  const agents = agentChoice.values
  prompted = prompted || agentChoice.prompted

  if (prompted) {
    const scopeDisplay = scope === 'cwd' ? process.cwd() : scope
    prompts.note(
      `Skills: ${skills.join(', ')}\nHarnesses: ${agents.map((id) => agentLabel(id, agentChoice.all)).join(', ')}\nScope: ${scopeDisplay}`,
      'Planned installation',
    )
    const proceed = checked<boolean>(await prompts.confirm({
      message: 'Continue?',
      initialValue: true,
    }))
    if (!proceed) cancel()
  }

  const args = [...skills, '--scope', scope]
  for (const agent of agents) args.push('--agent', agent)
  const result = await runCore(args)
  if (prompted && result.code === 0) prompts.outro('Installation complete')
  return result.code
}

type UpdateGroup = {
  key: string
  skill: string
  scope: Scope
  agents: string[]
}

function groupInstallations(registry: Registry): UpdateGroup[] {
  const groups = new Map<string, UpdateGroup>()
  for (const rec of registry.installations ?? []) {
    const key = `${rec.skill}\u0000${rec.scope.kind}\u0000${rec.scope.identity}`
    const group = groups.get(key) ?? { key, skill: rec.skill, scope: rec.scope, agents: [] }
    if (!group.agents.includes(rec.agent)) group.agents.push(rec.agent)
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key))
}

async function updateWizard(originalArgs: string[]): Promise<number> {
  const filters = originalArgs.slice(1)
  if (filters.length > 0) return (await runCore(originalArgs)).code
  if (!process.stdin.isTTY) {
    console.error('jl-skill: update requires filters in non-interactive mode')
    return 1
  }

  const registry = await coreJSON<Registry>('__registry')
  const groups = groupInstallations(registry)
  if (groups.length === 0) {
    console.error('jl-skill: no installer-managed skill installations found')
    return 1
  }
  const agentInfo = await coreJSON<AgentInfo[]>('__agents')

  const selected = checked<string[]>(await prompts.multiselect({
    message: 'Select installations to update',
    options: groups.map((group) => ({
      value: group.key,
      label: group.skill,
      hint: `${group.scope.identity} • ${group.agents.map((id) => agentLabel(id, agentInfo)).join(', ')}`,
    })),
    initialValues: groups.map((group) => group.key),
    required: true,
  }))

  const chosen = groups.filter((group) => selected.includes(group.key))
  prompts.note(
    chosen.map((group) => `${group.skill} at ${group.scope.identity} [${group.agents.map((id) => agentLabel(id, agentInfo)).join(', ')}]`).join('\n'),
    'Planned updates',
  )
  const proceed = checked<boolean>(await prompts.confirm({ message: 'Continue?', initialValue: true }))
  if (!proceed) cancel()

  for (const group of chosen) {
    const args = ['update', group.skill, '--scope', group.scope.identity]
    for (const agent of group.agents) args.push('--agent', agent)
    const result = await runCore(args)
    if (result.code !== 0) return result.code
  }
  prompts.outro('Update complete')
  return 0
}

function printHelp(): void {
  console.log(`jl-skill

Usage:
  jl-skill [skills...] --scope user|cwd|PATH [--agent AGENT]...
  jl-skill update [skills...] [--scope user|cwd|PATH] [--agent AGENT]...

Bare or incomplete interactive invocations use the same prompt package as Vite:
  @clack/prompts ${PROMPTS_VERSION}
`)
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    console.log(`jl-skill ${VERSION} (@clack/prompts ${PROMPTS_VERSION})`)
    return 0
  }
  if (args.some((arg) => arg === '--help' || arg === '-h') || args[0] === 'help') {
    printHelp()
    return 0
  }
  if (args[0] === 'update') return updateWizard(args)
  return installWizard(args)
}

try {
  process.exitCode = await main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`jl-skill: ${message}`)
  process.exitCode = 1
}
