import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { harnessAdapter, normalizeHarnessId } from '../src/harnesses'

const home = join('C:', 'Users', 'test')
const project = join('C:', 'work', 'project')

test('harness adapters resolve user and project resources from one table', () => {
  const codex = harnessAdapter('codex')
  expect(codex.paths({ kind: 'user', root: home }, home)).toEqual({
    skillRoot: join(home, '.agents', 'skills'),
    instruction: join(home, '.codex', 'AGENTS.md'),
    resources: { agents: join(home, '.codex', 'agents') },
  })
  expect(codex.paths({ kind: 'project', root: project }, home)).toEqual({
    skillRoot: join(project, '.agents', 'skills'),
    instruction: join(project, 'AGENTS.md'),
    resources: { agents: join(project, '.codex', 'agents') },
  })

  const claude = harnessAdapter('claude')
  expect(claude.paths({ kind: 'user', root: home }, home).resources.agents).toBe(join(home, '.claude', 'agents'))
  expect(claude.paths({ kind: 'project', root: project }, home).resources.agents).toBe(join(project, '.claude', 'agents'))
  expect(normalizeHarnessId('claude-code')).toBe('claude')
})
