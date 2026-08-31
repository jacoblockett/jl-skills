import { expect, test } from 'bun:test'
import AdmZip from 'adm-zip'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dir, '..')
const build = join(repo, 'build')

test('Map release archive contains only its target runtime and documented installable snapshot', () => {
  const archive = join(build, 'map-windows-x64.zip')
  expect(existsSync(archive)).toBe(true)
  expect(existsSync(join(build, 'map.zip'))).toBe(false)
  expect(existsSync(join(build, 'map.exe'))).toBe(false)
  expect(existsSync(join(build, 'jl-skills-manifest.json'))).toBe(false)

  const zip = new AdmZip(archive)
  const files = zip
    .getEntries()
    .filter((entry) => !entry.isDirectory)
    .map((entry) => entry.entryName.replaceAll('\\', '/').replace(/^\.\//, ''))
    .sort()

  expect(files).toEqual([
    'AGENTS.fragment.md',
    'SKILL.md',
    'harnesses/claude/agents/map-completion-auditor.md',
    'harnesses/claude/agents/map-context.md',
    'harnesses/claude/agents/map-discovery-reviewer.md',
    'harnesses/claude/agents/map-discovery.md',
    'harnesses/claude/agents/map-linguist.md',
    'harnesses/claude/agents/map-state-reviewer.md',
    'harnesses/claude/agents/map-state-writer.md',
    'harnesses/codex/agents/map-completion-auditor.toml',
    'harnesses/codex/agents/map-context.toml',
    'harnesses/codex/agents/map-discovery-reviewer.toml',
    'harnesses/codex/agents/map-discovery.toml',
    'harnesses/codex/agents/map-linguist.toml',
    'harnesses/codex/agents/map-state-reviewer.toml',
    'harnesses/codex/agents/map-state-writer.toml',
    'manifest.json',
    'runtime/windows-x64/map.exe',
    'schema.surql',
  ].sort())

  const packagedManifest = JSON.parse(zip.readAsText('manifest.json'))
  expect(packagedManifest.version).toBe('0.5.0')
  expect(packagedManifest.runtime_artifacts).toEqual({
    'windows-x64': 'runtime/windows-x64/map.exe',
  })
})
