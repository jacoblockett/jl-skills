import { arch, platform } from 'node:os'

export const TARGET_KEYS = [
  'windows-x64',
  'windows-arm64',
  'macos-x64',
  'macos-arm64',
  'linux-x64-gnu',
  'linux-arm64-gnu',
  'linux-x64-musl',
  'linux-arm64-musl',
] as const

export type TargetKey = typeof TARGET_KEYS[number]
export type TargetOS = 'windows' | 'macos' | 'linux'
export type TargetArch = 'x64' | 'arm64'
export type TargetAbi = 'msvc' | 'darwin' | 'gnu' | 'musl'

export type DistributionTarget = {
  key: TargetKey
  os: TargetOS
  arch: TargetArch
  abi: TargetAbi
  executableSuffix: '' | '.exe'
  bunCompileTarget: string
  rustTargetTriple: string
}

export const TARGETS: Record<TargetKey, DistributionTarget> = {
  'windows-x64': {
    key: 'windows-x64',
    os: 'windows',
    arch: 'x64',
    abi: 'msvc',
    executableSuffix: '.exe',
    bunCompileTarget: 'bun-windows-x64-baseline',
    rustTargetTriple: 'x86_64-pc-windows-msvc',
  },
  'windows-arm64': {
    key: 'windows-arm64',
    os: 'windows',
    arch: 'arm64',
    abi: 'msvc',
    executableSuffix: '.exe',
    bunCompileTarget: 'bun-windows-arm64',
    rustTargetTriple: 'aarch64-pc-windows-msvc',
  },
  'macos-x64': {
    key: 'macos-x64',
    os: 'macos',
    arch: 'x64',
    abi: 'darwin',
    executableSuffix: '',
    bunCompileTarget: 'bun-darwin-x64-baseline',
    rustTargetTriple: 'x86_64-apple-darwin',
  },
  'macos-arm64': {
    key: 'macos-arm64',
    os: 'macos',
    arch: 'arm64',
    abi: 'darwin',
    executableSuffix: '',
    bunCompileTarget: 'bun-darwin-arm64',
    rustTargetTriple: 'aarch64-apple-darwin',
  },
  'linux-x64-gnu': {
    key: 'linux-x64-gnu',
    os: 'linux',
    arch: 'x64',
    abi: 'gnu',
    executableSuffix: '',
    bunCompileTarget: 'bun-linux-x64-baseline',
    rustTargetTriple: 'x86_64-unknown-linux-gnu',
  },
  'linux-arm64-gnu': {
    key: 'linux-arm64-gnu',
    os: 'linux',
    arch: 'arm64',
    abi: 'gnu',
    executableSuffix: '',
    bunCompileTarget: 'bun-linux-arm64',
    rustTargetTriple: 'aarch64-unknown-linux-gnu',
  },
  'linux-x64-musl': {
    key: 'linux-x64-musl',
    os: 'linux',
    arch: 'x64',
    abi: 'musl',
    executableSuffix: '',
    bunCompileTarget: 'bun-linux-x64-musl',
    rustTargetTriple: 'x86_64-unknown-linux-musl',
  },
  'linux-arm64-musl': {
    key: 'linux-arm64-musl',
    os: 'linux',
    arch: 'arm64',
    abi: 'musl',
    executableSuffix: '',
    bunCompileTarget: 'bun-linux-arm64-musl',
    rustTargetTriple: 'aarch64-unknown-linux-musl',
  },
}

export function isTargetKey(value: string): value is TargetKey {
  return Object.hasOwn(TARGETS, value)
}

export function targetByKey(value: string): DistributionTarget {
  if (!isTargetKey(value)) throw new Error(`unsupported jl-skills target: ${value}`)
  return TARGETS[value]
}

export function hostMatchesTarget(target: DistributionTarget): boolean {
  const hostOs = platform() === 'win32' ? 'windows' : platform() === 'darwin' ? 'macos' : platform()
  return hostOs === target.os && arch() === target.arch
}

declare const JL_SKILLS_COMPILED_TARGET: string | undefined

export function compiledTarget(): DistributionTarget {
  const value = typeof JL_SKILLS_COMPILED_TARGET === 'string' ? JL_SKILLS_COMPILED_TARGET : undefined
  if (!value) throw new Error('jl-skills compiled target was not injected at build time')
  return targetByKey(value)
}
