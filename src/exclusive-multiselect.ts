import { styleText } from 'node:util'
import type { Readable, Writable } from 'node:stream'
import { Prompt, settings, wrapTextWithPrefix, type PromptOptions, type State } from '@clack/core'

export type ExclusiveOption<Value> = {
  value: Value
  label: string
  disabled?: boolean
  exclusive?: boolean
}

export type ExclusiveMultiselectOptions<Value> = {
  message: string
  options: ExclusiveOption<Value>[]
  initialValues?: Value[]
  required?: boolean
  input?: Readable
  output?: Writable
  signal?: AbortSignal
  withGuide?: boolean
}

const S_STEP_ACTIVE = '◆'
const S_STEP_CANCEL = '■'
const S_STEP_ERROR = '▲'
const S_STEP_SUBMIT = '◇'
const S_BAR = '│'
const S_BAR_END = '└'
const S_CHECKBOX_ACTIVE = '◻'
const S_CHECKBOX_SELECTED = '◼'
const S_CHECKBOX_INACTIVE = '◻'

function symbol(state: State): string {
  if (state === 'cancel') return styleText('red', S_STEP_CANCEL)
  if (state === 'error') return styleText('yellow', S_STEP_ERROR)
  if (state === 'submit') return styleText('green', S_STEP_SUBMIT)
  return styleText('cyan', S_STEP_ACTIVE)
}

function symbolBar(state: State): string {
  if (state === 'cancel') return styleText('red', S_BAR)
  if (state === 'error') return styleText('yellow', S_BAR)
  if (state === 'submit') return styleText('green', S_BAR)
  return styleText('cyan', S_BAR)
}

function nextCursor<Value>(
  cursor: number,
  direction: -1 | 1,
  options: ExclusiveOption<Value>[],
): number {
  if (options.length === 0) return 0
  let candidate = cursor
  for (let i = 0; i < options.length; i++) {
    candidate = (candidate + direction + options.length) % options.length
    if (!options[candidate]?.disabled) return candidate
  }
  return cursor
}

export function applyExclusiveToggle<Value>(
  current: Value[],
  option: ExclusiveOption<Value>,
  options: ExclusiveOption<Value>[],
): Value[] {
  if (option.disabled) return [...current]
  const selected = current.includes(option.value)
  if (option.exclusive) return selected ? [] : [option.value]

  const exclusiveValues = new Set(options.filter((item) => item.exclusive).map((item) => item.value))
  const normal = current.filter((value) => !exclusiveValues.has(value))
  return selected
    ? normal.filter((value) => value !== option.value)
    : [...normal, option.value]
}

export class ExclusiveMultiSelectPrompt<Value> extends Prompt<Value[]> {
  options: ExclusiveOption<Value>[]
  cursor = 0

  private get enabledNormalValues(): Value[] {
    return this.options
      .filter((option) => !option.disabled && !option.exclusive)
      .map((option) => option.value)
  }

  constructor(
    opts: PromptOptions<Value[], ExclusiveMultiSelectPrompt<Value>> & {
      options: ExclusiveOption<Value>[]
      initialValues?: Value[]
      cursorAt?: Value
    },
  ) {
    super(opts, false)
    this.options = opts.options
    this.value = [...(opts.initialValues ?? [])]

    const requestedCursor = opts.cursorAt === undefined
      ? 0
      : Math.max(this.options.findIndex((option) => option.value === opts.cursorAt), 0)
    this.cursor = this.options[requestedCursor]?.disabled
      ? nextCursor(requestedCursor, 1, this.options)
      : requestedCursor

    this.on('cursor', (key) => {
      if (key === 'left' || key === 'up') this.cursor = nextCursor(this.cursor, -1, this.options)
      else if (key === 'down' || key === 'right') this.cursor = nextCursor(this.cursor, 1, this.options)
      else if (key === 'space') {
        const option = this.options[this.cursor]
        if (option) this._setValue(applyExclusiveToggle(this.value ?? [], option, this.options))
      }
    })

    this.on('key', (_char, key) => {
      if (key.name === 'a') {
        const normal = this.enabledNormalValues
        const current = this.value ?? []
        const allSelected = normal.length > 0 && normal.every((value) => current.includes(value))
        this._setValue(allSelected ? [] : normal)
      } else if (key.name === 'i') {
        const current = this.value ?? []
        this._setValue(this.enabledNormalValues.filter((value) => !current.includes(value)))
      }
    })
  }
}

function optionText<Value>(
  option: ExclusiveOption<Value>,
  state: 'inactive' | 'active' | 'selected' | 'active-selected' | 'submitted' | 'cancelled' | 'disabled',
): string {
  const label = option.label
  if (state === 'disabled') {
    return `${styleText('gray', S_CHECKBOX_INACTIVE)} ${styleText(['strikethrough', 'gray'], label)}`
  }
  if (state === 'active') return `${styleText('cyan', S_CHECKBOX_ACTIVE)} ${label}`
  if (state === 'selected') return `${styleText('green', S_CHECKBOX_SELECTED)} ${styleText('dim', label)}`
  if (state === 'active-selected') return `${styleText('green', S_CHECKBOX_SELECTED)} ${label}`
  if (state === 'cancelled') return styleText(['strikethrough', 'dim'], label)
  if (state === 'submitted') return styleText('dim', label)
  return `${styleText('dim', S_CHECKBOX_INACTIVE)} ${styleText('dim', label)}`
}

export function exclusiveMultiselect<Value>(
  opts: ExclusiveMultiselectOptions<Value>,
): Promise<Value[] | symbol> {
  const required = opts.required ?? true
  const output = opts.output ?? process.stdout
  const hasGuide = opts.withGuide ?? settings.withGuide

  return new ExclusiveMultiSelectPrompt<Value>({
    options: opts.options,
    input: opts.input,
    output: opts.output,
    signal: opts.signal,
    initialValues: opts.initialValues,
    validate(selected) {
      if (required && (!selected || selected.length === 0)) return 'Please select at least one option.'
    },
    render() {
      const wrappedMessage = wrapTextWithPrefix(
        output,
        opts.message,
        hasGuide ? `${symbolBar(this.state)}  ` : '',
        `${symbol(this.state)}  `,
      )
      const title = `${hasGuide ? `${styleText('gray', S_BAR)}\n` : ''}${wrappedMessage}\n`
      const value = this.value ?? []

      if (this.state === 'submit') {
        const submitted = this.options
          .filter((option) => value.includes(option.value))
          .map((option) => optionText(option, 'submitted'))
          .join(styleText('dim', ', ')) || styleText('dim', 'none')
        return `${title}${hasGuide ? `${styleText('gray', S_BAR)}  ` : ''}${submitted}`
      }

      if (this.state === 'cancel') {
        const cancelled = this.options
          .filter((option) => value.includes(option.value))
          .map((option) => optionText(option, 'cancelled'))
          .join(styleText('dim', ', '))
        return `${title}${hasGuide ? `${styleText('gray', S_BAR)}  ` : ''}${cancelled}${hasGuide ? `\n${styleText('gray', S_BAR)}` : ''}`
      }

      const prefix = hasGuide
        ? `${styleText(this.state === 'error' ? 'yellow' : 'cyan', S_BAR)}  `
        : ''
      const lines = this.options.map((option, index) => {
        if (option.disabled) return optionText(option, 'disabled')
        const selected = value.includes(option.value)
        if (index === this.cursor && selected) return optionText(option, 'active-selected')
        if (index === this.cursor) return optionText(option, 'active')
        if (selected) return optionText(option, 'selected')
        return optionText(option, 'inactive')
      })
      const footer = this.state === 'error'
        ? `${styleText('yellow', this.error)}\n${hasGuide ? styleText('yellow', S_BAR_END) : ''}`
        : `${styleText('dim', '↑/↓ to navigate • Space: select • Enter: confirm')}${hasGuide ? `\n${styleText('cyan', S_BAR_END)}` : ''}`
      return `${title}${prefix}${lines.join(`\n${prefix}`)}\n${footer}\n`
    },
  }).prompt() as Promise<Value[] | symbol>
}
