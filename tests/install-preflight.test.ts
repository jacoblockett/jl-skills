import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { classifyInstallTargets, satisfiedSkills, staleSkills } from '../src/install-preflight'

describe('install preflight classification', () => {
  test('classifies missing, satisfied, stale, configure, unknown, and newer targets without downgrading', () => {
    const targets = classifyInstallTargets(
      ['map', 'other'],
      ['codex', 'claude'],
      { map: '0.2.0', other: '1.0.0' },
      { map: true, other: false },
      [
        { skill: 'map', agent: 'codex', version: '0.2.0', instructions: true },
        { skill: 'map', agent: 'claude', version: '0.1.0', instructions: true },
        { skill: 'other', agent: 'codex', version: 'unknown', instructions: false },
        { skill: 'other', agent: 'claude', version: '1.1.0', instructions: true },
      ],
    )

    expect(targets).toEqual([
      {
        skill: 'map',
        agent: 'codex',
        availableVersion: '0.2.0',
        requestedInstructions: true,
        installedVersion: '0.2.0',
        installedInstructions: true,
        state: 'satisfied',
      },
      {
        skill: 'map',
        agent: 'claude',
        availableVersion: '0.2.0',
        requestedInstructions: true,
        installedVersion: '0.1.0',
        installedInstructions: true,
        state: 'stale',
      },
      {
        skill: 'other',
        agent: 'codex',
        availableVersion: '1.0.0',
        requestedInstructions: false,
        installedVersion: 'unknown',
        installedInstructions: false,
        state: 'stale',
      },
      {
        skill: 'other',
        agent: 'claude',
        availableVersion: '1.0.0',
        requestedInstructions: false,
        installedVersion: '1.1.0',
        installedInstructions: true,
        state: 'configure',
      },
    ])
  })

  test('current installation with different instruction injection is configuration work', () => {
    const add = classifyInstallTargets(
      ['map'],
      ['codex'],
      { map: '0.2.0' },
      { map: true },
      [{ skill: 'map', agent: 'codex', version: '0.2.0', instructions: false }],
    )
    expect(add[0]?.state).toBe('configure')

    const remove = classifyInstallTargets(
      ['map'],
      ['codex'],
      { map: '0.2.0' },
      { map: false },
      [{ skill: 'map', agent: 'codex', version: '0.2.0', instructions: true }],
    )
    expect(remove[0]?.state).toBe('configure')
  })

  test('newer installation is satisfied only when requested configuration also matches', () => {
    const matching = classifyInstallTargets(
      ['map'],
      ['codex'],
      { map: '0.2.0' },
      { map: false },
      [{ skill: 'map', agent: 'codex', version: '0.3.0', instructions: false }],
    )
    expect(matching[0]?.state).toBe('satisfied')

    const changed = classifyInstallTargets(
      ['map'],
      ['codex'],
      { map: '0.2.0' },
      { map: true },
      [{ skill: 'map', agent: 'codex', version: '0.3.0', instructions: false }],
    )
    expect(changed[0]?.state).toBe('configure')
  })

  test('groups stale targets by skill for one update choice per skill', () => {
    const targets = classifyInstallTargets(
      ['map'],
      ['codex', 'claude'],
      { map: '0.2.0' },
      { map: true },
      [
        { skill: 'map', agent: 'codex', version: '0.1.0', instructions: false },
        { skill: 'map', agent: 'claude', version: 'unknown', instructions: true },
      ],
    )

    expect(staleSkills(targets)).toEqual([
      { skill: 'map', installedVersions: ['0.1.0', 'unknown'], availableVersion: '0.2.0' },
    ])
  })

  test('a skill is already installed only when every requested harness target is satisfied', () => {
    const complete = classifyInstallTargets(
      ['map'],
      ['codex', 'claude'],
      { map: '0.2.0' },
      { map: false },
      [
        { skill: 'map', agent: 'codex', version: '0.2.0', instructions: false },
        { skill: 'map', agent: 'claude', version: '0.3.0', instructions: false },
      ],
    )
    expect(satisfiedSkills(complete)).toEqual(['map'])

    const mixed = classifyInstallTargets(
      ['map'],
      ['codex', 'claude'],
      { map: '0.2.0' },
      { map: false },
      [{ skill: 'map', agent: 'codex', version: '0.2.0', instructions: false }],
    )
    expect(satisfiedSkills(mixed)).toEqual([])
    expect(mixed[1]?.state).toBe('missing')
  })

  test('interactive install inspection happens only after Continue confirmation', () => {
    const repo = resolve(import.meta.dir, '..')
    const source = readFileSync(join(repo, 'src', 'jl-skill.ts'), 'utf8')
    const start = source.indexOf('async function installAtScope(')
    const end = source.indexOf('\nasync function installWizard(', start)
    const installFlow = source.slice(start, end)
    const confirmation = installFlow.indexOf('chooseConfirmation(')
    const inspection = installFlow.indexOf('installPreflight(')

    expect(confirmation).toBeGreaterThan(-1)
    expect(inspection).toBeGreaterThan(confirmation)
    expect(installFlow).not.toContain('All requested skill installations are already up to date.')
    expect(installFlow).not.toContain('No changes needed')
    expect(installFlow).toContain('There is nothing to install.')
  })
})
