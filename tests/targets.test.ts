import { describe, expect, test } from 'bun:test'
import {
  TARGET_KEYS,
  TARGETS,
  installerAssetName,
  runtimeArtifactPath,
  skillArchiveName,
  targetByKey,
} from '../src/targets'

describe('distribution targets', () => {
  test('locks the required public target set', () => {
    expect(TARGET_KEYS).toEqual([
      'windows-x64',
      'windows-arm64',
      'macos-x64',
      'macos-arm64',
      'linux-x64-gnu',
      'linux-arm64-gnu',
      'linux-x64-musl',
      'linux-arm64-musl',
    ])
    expect(Object.keys(TARGETS)).toEqual([...TARGET_KEYS])
  })

  test('owns compiler/runtime facts for every target', () => {
    for (const key of TARGET_KEYS) {
      const target = targetByKey(key)
      expect(target.key).toBe(key)
      expect(['windows', 'macos', 'linux']).toContain(target.os)
      expect(['x64', 'arm64']).toContain(target.arch)
      expect(['msvc', 'darwin', 'gnu', 'musl']).toContain(target.abi)
      expect(typeof target.bunCompileTarget).toBe('string')
      expect(target.bunCompileTarget.startsWith('bun-')).toBe(true)
      expect(typeof target.rustTargetTriple).toBe('string')
      expect(target.rustTargetTriple.length).toBeGreaterThan(0)
      expect(target.executableSuffix).toBe(target.os === 'windows' ? '.exe' : '')
    }
  })

  test('uses the intended toolchain targets', () => {
    expect(TARGETS['windows-x64']).toMatchObject({
      bunCompileTarget: 'bun-windows-x64-baseline',
      rustTargetTriple: 'x86_64-pc-windows-msvc',
    })
    expect(TARGETS['windows-arm64']).toMatchObject({
      bunCompileTarget: 'bun-windows-arm64',
      rustTargetTriple: 'aarch64-pc-windows-msvc',
    })
    expect(TARGETS['macos-x64']).toMatchObject({
      bunCompileTarget: 'bun-darwin-x64-baseline',
      rustTargetTriple: 'x86_64-apple-darwin',
    })
    expect(TARGETS['macos-arm64']).toMatchObject({
      bunCompileTarget: 'bun-darwin-arm64',
      rustTargetTriple: 'aarch64-apple-darwin',
    })
    expect(TARGETS['linux-x64-gnu']).toMatchObject({
      bunCompileTarget: 'bun-linux-x64-baseline',
      rustTargetTriple: 'x86_64-unknown-linux-gnu',
    })
    expect(TARGETS['linux-arm64-gnu']).toMatchObject({
      bunCompileTarget: 'bun-linux-arm64',
      rustTargetTriple: 'aarch64-unknown-linux-gnu',
    })
    expect(TARGETS['linux-x64-musl']).toMatchObject({
      bunCompileTarget: 'bun-linux-x64-musl',
      rustTargetTriple: 'x86_64-unknown-linux-musl',
    })
    expect(TARGETS['linux-arm64-musl']).toMatchObject({
      bunCompileTarget: 'bun-linux-arm64-musl',
      rustTargetTriple: 'aarch64-unknown-linux-musl',
    })
  })

  test('owns exact public artifact and runtime names', () => {
    for (const key of TARGET_KEYS) {
      const target = TARGETS[key]
      expect(installerAssetName(target)).toBe(`jl-skills-${key}${target.executableSuffix}`)
      expect(skillArchiveName('map', target)).toBe(`map-${key}.zip`)
      expect(runtimeArtifactPath('map', target)).toBe(`runtime/${key}/map${target.executableSuffix}`)
    }
    expect(skillArchiveName('portable-test', 'portable')).toBe('portable-test-portable.zip')
  })

  test('rejects unknown targets', () => {
    expect(() => targetByKey('linux-x64')).toThrow('unsupported jl-skills target')
  })
})
