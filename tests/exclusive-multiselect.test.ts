import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  ExclusiveMultiSelectPrompt,
  applyExclusiveToggle,
  type ExclusiveOption,
} from '../src/exclusive-multiselect'

const options: ExclusiveOption<string>[] = [
  { value: 'codex', label: 'OpenAI Codex' },
  { value: 'claude', label: 'Claude Code' },
  { value: 'all', label: 'All of the above', exclusive: true },
  { value: 'back', label: 'Go back', exclusive: true },
  { value: 'cancel', label: 'Cancel & Exit', exclusive: true },
]

function prompt(initialValues: string[] = []): ExclusiveMultiSelectPrompt<string> {
  return new ExclusiveMultiSelectPrompt<string>({
    options,
    initialValues,
    render() { return '' },
  })
}

describe('exclusive multiselect policy', () => {
  test('selecting an exclusive option immediately clears ordinary selections', () => {
    expect(applyExclusiveToggle(['claude'], options[2], options)).toEqual(['all'])
  })

  test('selecting an ordinary option immediately clears exclusive selections', () => {
    expect(applyExclusiveToggle(['all'], options[1], options)).toEqual(['claude'])
  })

  test('space applies exclusivity live before the prompt is submitted', () => {
    const p = prompt(['claude'])
    p.cursor = 2
    p.emit('cursor', 'space')
    expect(p.value).toEqual(['all'])

    p.cursor = 0
    p.emit('cursor', 'space')
    expect(p.value).toEqual(['codex'])
  })

  test('Go back and Cancel & Exit are mutually exclusive with every other selection', () => {
    const p = prompt(['codex', 'claude'])
    p.cursor = 3
    p.emit('cursor', 'space')
    expect(p.value).toEqual(['back'])

    p.cursor = 4
    p.emit('cursor', 'space')
    expect(p.value).toEqual(['cancel'])
  })

  test('keyboard select-all never selects navigation sentinels', () => {
    const p = prompt()
    p.emit('key', undefined, { name: 'a' } as any)
    expect(p.value).toEqual(['codex', 'claude'])

    p.emit('key', undefined, { name: 'a' } as any)
    expect(p.value).toEqual([])
  })
})

describe('installer option presentation', () => {
  test('installer source does not use Clack option hints', () => {
    const repo = resolve(import.meta.dir, '..')
    const source = readFileSync(join(repo, 'src', 'jl-skill.ts'), 'utf8')
    expect(source).not.toContain('hint:')
  })
})
