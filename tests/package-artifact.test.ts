import { expect, test } from 'bun:test'
import AdmZip from 'adm-zip'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dir, '..')
const build = join(repo, 'build')

test('Map release archive contains only the documented installable snapshot', () => {
  const archive = join(build, 'map.zip')
  expect(existsSync(archive)).toBe(true)
  expect(existsSync(join(build, 'map.exe'))).toBe(false)
  expect(existsSync(join(build, 'jl-skills-manifest.json'))).toBe(false)

  const files = new AdmZip(archive)
    .getEntries()
    .filter((entry) => !entry.isDirectory)
    .map((entry) => entry.entryName.replaceAll('\\', '/').replace(/^\.\//, ''))
    .sort()

  expect(files).toEqual([
    'AGENTS.fragment.md',
    'SKILL.md',
    'agents/map-completion-auditor.toml',
    'agents/map-context.toml',
    'agents/map-discovery-reviewer.toml',
    'agents/map-discovery.toml',
    'agents/map-linguist.toml',
    'agents/map-state-reviewer.toml',
    'agents/map-state-writer.toml',
    'manifest.json',
    'runtime/windows-x64/map.exe',
    'schema.surql',
  ].sort())
})
