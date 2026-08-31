import { join } from 'node:path'

export type HarnessScope = {
  kind: 'user' | 'project'
  root: string
}

export type HarnessPaths = {
  skillRoot: string
  instruction: string
  resources: Record<string, string>
}

export type HarnessAdapter = {
  id: string
  aliases?: string[]
  label: string
  command: string
  detectionPaths: (home: string) => string[]
  paths: (scope: HarnessScope, home: string) => HarnessPaths
}

export const HARNESS_ADAPTERS: HarnessAdapter[] = [
  {
    id: 'codex',
    label: 'OpenAI Codex',
    command: 'codex',
    detectionPaths: (home) => [
      join(home, '.codex', 'config.toml'),
      join(home, '.codex', 'sessions'),
      join(home, '.codex', 'AGENTS.md'),
    ],
    paths: (scope, home) => {
      const root = scope.kind === 'user' ? home : scope.root
      return {
        skillRoot: join(root, '.agents', 'skills'),
        instruction: scope.kind === 'user' ? join(home, '.codex', 'AGENTS.md') : join(scope.root, 'AGENTS.md'),
        resources: {
          agents: scope.kind === 'user' ? join(home, '.codex', 'agents') : join(scope.root, '.codex', 'agents'),
        },
      }
    },
  },
  {
    id: 'claude',
    aliases: ['claude-code'],
    label: 'Claude Code',
    command: 'claude',
    detectionPaths: (home) => [
      join(home, '.claude', 'settings.json'),
      join(home, '.claude', 'projects'),
      join(home, '.claude.json'),
    ],
    paths: (scope, home) => {
      const root = scope.kind === 'user' ? home : scope.root
      return {
        skillRoot: join(root, '.claude', 'skills'),
        instruction: scope.kind === 'user' ? join(home, '.claude', 'CLAUDE.md') : join(scope.root, 'CLAUDE.md'),
        resources: {
          agents: join(root, '.claude', 'agents'),
        },
      }
    },
  },
]

export function normalizeHarnessId(raw: string): string {
  const value = raw.trim().toLowerCase()
  const adapter = HARNESS_ADAPTERS.find((item) => item.id === value || item.aliases?.includes(value))
  if (!adapter) throw new Error(`unsupported agent "${raw}"`)
  return adapter.id
}

export function harnessAdapter(id: string): HarnessAdapter {
  const adapter = HARNESS_ADAPTERS.find((item) => item.id === id)
  if (!adapter) throw new Error(`unsupported agent "${id}"`)
  return adapter
}
