import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repo = resolve(import.meta.dir, '..')
const build = join(repo, 'build')

test('Map release archive contains only the documented installable snapshot', () => {
  const archive = join(build, 'map.zip')
  expect(existsSync(archive)).toBe(true)
  expect(existsSync(join(build, 'map.exe'))).toBe(false)
  expect(existsSync(join(build, 'jl-skills-manifest.json'))).toBe(false)

  const listed = spawnSync('tar', ['-tf', archive], { encoding: 'utf8', windowsHide: true })
  expect(listed.status).toBe(0)

  const directories = new Set([
    'agents',
    'agents/',
    'runtime',
    'runtime/',
    'runtime/windows-x64',
    'runtime/windows-x64/',
  ])
  const files = listed.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim().replaceAll('\\', '/').replace(/^\.\//, ''))
    .filter((entry) => entry && !directories.has(entry))
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
