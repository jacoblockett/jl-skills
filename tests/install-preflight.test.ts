import { describe, expect, test } from 'bun:test'
import { classifyInstallTargets, staleSkills } from '../src/install-preflight'

describe('install preflight classification', () => {
  test('classifies missing, current, stale, unknown, and newer targets without downgrading', () => {
    const targets = classifyInstallTargets(
      ['map', 'other'],
      ['codex', 'claude'],
      { map: '0.2.0', other: '1.0.0' },
      [
        { skill: 'map', agent: 'codex', version: '0.2.0' },
        { skill: 'map', agent: 'claude', version: '0.1.0' },
        { skill: 'other', agent: 'codex', version: 'unknown' },
        { skill: 'other', agent: 'claude', version: '1.1.0' },
      ],
    )

    expect(targets).toEqual([
      { skill: 'map', agent: 'codex', availableVersion: '0.2.0', installedVersion: '0.2.0', state: 'current' },
      { skill: 'map', agent: 'claude', availableVersion: '0.2.0', installedVersion: '0.1.0', state: 'stale' },
      { skill: 'other', agent: 'codex', availableVersion: '1.0.0', installedVersion: 'unknown', state: 'stale' },
      { skill: 'other', agent: 'claude', availableVersion: '1.0.0', installedVersion: '1.1.0', state: 'current' },
    ])
  })

  test('groups stale targets by skill for one update choice per skill', () => {
    const targets = classifyInstallTargets(
      ['map'],
      ['codex', 'claude'],
      { map: '0.2.0' },
      [
        { skill: 'map', agent: 'codex', version: '0.1.0' },
        { skill: 'map', agent: 'claude', version: 'unknown' },
      ],
    )

    expect(staleSkills(targets)).toEqual([
      { skill: 'map', installedVersions: ['0.1.0', 'unknown'], availableVersion: '0.2.0' },
    ])
  })

  test('missing selected harness targets remain installable independently of existing harness targets', () => {
    const targets = classifyInstallTargets(
      ['map'],
      ['codex', 'claude'],
      { map: '0.2.0' },
      [{ skill: 'map', agent: 'codex', version: '0.2.0' }],
    )

    expect(targets).toEqual([
      { skill: 'map', agent: 'codex', availableVersion: '0.2.0', installedVersion: '0.2.0', state: 'current' },
      { skill: 'map', agent: 'claude', availableVersion: '0.2.0', state: 'missing' },
    ])
  })
})
