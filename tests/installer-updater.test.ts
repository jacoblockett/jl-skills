import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  checkInstallerUpdate,
  compareVersions,
  downloadVerifiedInstaller,
  fetchStableReleaseManifest,
  installerPlatformKey,
  parseInstallerUpdateManifest,
  stageInstallerUpdate,
  windowsReplacementCommand,
  type InstallerUpdate,
} from '../src/installer-updater'

const repo = resolve(import.meta.dir, '..')
const scratch = join(repo, 'build', 'installer-updater-tests')

function reset(name: string): string {
  const root = join(scratch, name)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  return root
}

function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function fixtureFetcher(manifest: unknown, artifact: Uint8Array | string = 'replacement-exe'): typeof fetch {
  return (async (input: any) => {
    const url = String(input)
    if (url === 'https://fixture.invalid/manifest.json') {
      return new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://fixture.invalid/jl-skills.exe') return new Response(artifact, { status: 200 })
    return new Response('missing', { status: 404 })
  }) as typeof fetch
}

describe('installer update metadata', () => {
  test('semantic versions compare deterministically', () => {
    expect(compareVersions('0.5.0', '0.5.0')).toBe(0)
    expect(compareVersions('0.5.0', '0.6.0')).toBe(-1)
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
    expect(() => compareVersions('0.5.0-nightly', '0.5.0')).toThrow('invalid installer version comparison')
  })

  test('manifest requires stable semver and SHA-256 metadata', () => {
    expect(() => parseInstallerUpdateManifest({ version: 'wat', artifacts: {} })).toThrow('invalid installer update version')
    expect(() => parseInstallerUpdateManifest({ version: '0.6.0-nightly', artifacts: {} })).toThrow('invalid installer update version')
    expect(() => parseInstallerUpdateManifest({
      version: '0.6.0',
      artifacts: { 'windows-x64': { url: 'x', sha256: 'bad' } },
    })).toThrow('invalid SHA-256')
  })

  test('stable release manifest exposes skill versions and runtime hashes', async () => {
    const manifest = {
      format: 1,
      version: '0.6.0',
      artifacts: { 'windows-x64': { url: 'https://fixture.invalid/jl-skills.exe', sha256: '0'.repeat(64) } },
      skills: {
        map: {
          version: '0.3.0',
          artifacts: { 'windows-x64': { url: 'https://fixture.invalid/map.exe', sha256: '1'.repeat(64) } },
        },
      },
    }
    const parsed = await fetchStableReleaseManifest('https://fixture.invalid/manifest.json', fixtureFetcher(manifest))
    expect(parsed?.version).toBe('0.6.0')
    expect(parsed?.skills.map.version).toBe('0.3.0')
  })

  test('release build emits a manifest matching all built binaries', () => {
    const executable = join(repo, 'build', 'jl-skills.exe')
    const mapExecutable = join(repo, 'build', 'map.exe')
    const manifestPath = join(repo, 'build', 'jl-skills-manifest.json')
    expect(existsSync(executable)).toBe(true)
    expect(existsSync(mapExecutable)).toBe(true)
    expect(existsSync(manifestPath)).toBe(true)

    const manifest = parseInstallerUpdateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
    const artifact = manifest.artifacts['windows-x64']
    const mapArtifact = manifest.skills.map.artifacts['windows-x64']
    expect(artifact).toBeDefined()
    expect(artifact.sha256).toBe(sha256(readFileSync(executable)))
    expect(artifact.url).toContain(`/releases/download/v${manifest.version}/jl-skills.exe`)
    expect(mapArtifact.sha256).toBe(sha256(readFileSync(mapExecutable)))
    expect(mapArtifact.url).toContain(`/releases/download/v${manifest.version}/map.exe`)
  })

  test('no-update path returns null for equal or older releases', async () => {
    const key = installerPlatformKey()
    const manifest = {
      version: '0.5.0',
      artifacts: { [key]: { url: 'https://fixture.invalid/jl-skills.exe', sha256: '0'.repeat(64) } },
    }
    const update = await checkInstallerUpdate('0.5.0', 'https://fixture.invalid/manifest.json', fixtureFetcher(manifest))
    expect(update).toBeNull()
  })

  test('missing published manifest is treated as no update', async () => {
    const fetcher = (async () => new Response('missing', { status: 404 })) as typeof fetch
    expect(await checkInstallerUpdate('0.5.0', 'https://fixture.invalid/missing.json', fetcher)).toBeNull()
  })

  test('newer compatible release selects the current platform artifact', async () => {
    const bytes = 'replacement-exe'
    const key = installerPlatformKey()
    const manifest = {
      version: '0.6.0',
      artifacts: { [key]: { url: 'https://fixture.invalid/jl-skills.exe', sha256: sha256(bytes) } },
    }
    const update = await checkInstallerUpdate('0.5.0', 'https://fixture.invalid/manifest.json', fixtureFetcher(manifest, bytes))
    expect(update?.version).toBe('0.6.0')
    expect(update?.artifact.url).toBe('https://fixture.invalid/jl-skills.exe')
  })
})

describe('installer update artifact staging', () => {
  test('verified replacement is staged without modifying the running executable or neighboring data', async () => {
    const root = reset('stage-success')
    const executable = join(root, 'jl-skills.exe')
    const neighboring = join(root, 'keep.txt')
    const bytes = 'replacement-exe'
    writeFileSync(executable, 'current-exe')
    writeFileSync(neighboring, 'KEEP')

    const update: InstallerUpdate = {
      version: '0.6.0',
      artifact: { url: 'https://fixture.invalid/jl-skills.exe', sha256: sha256(bytes) },
    }
    const fetcher = fixtureFetcher({}, bytes)
    const staged = await stageInstallerUpdate(executable, update, fetcher)

    expect(staged).not.toBe(executable)
    expect(existsSync(staged)).toBe(true)
    expect(readFileSync(staged, 'utf8')).toBe(bytes)
    expect(readFileSync(executable, 'utf8')).toBe('current-exe')
    expect(readFileSync(neighboring, 'utf8')).toBe('KEEP')
  })

  test('hash mismatch is rejected without leaving a destination artifact', async () => {
    const root = reset('hash-mismatch')
    const destination = join(root, 'replacement.exe')
    const update: InstallerUpdate = {
      version: '0.6.0',
      artifact: { url: 'https://fixture.invalid/jl-skills.exe', sha256: '0'.repeat(64) },
    }

    await expect(downloadVerifiedInstaller(update, destination, fixtureFetcher({}, 'wrong-bytes'))).rejects.toThrow('SHA-256 mismatch')
    expect(existsSync(destination)).toBe(false)
  })

  test('Windows replacement command waits and replaces the executable from the staged sibling', () => {
    const command = windowsReplacementCommand('C:\\Tools\\.jl-skills.exe.update-1', 'C:\\Tools\\jl-skills.exe')
    expect(command).toContain('ping 127.0.0.1 -n 2')
    expect(command).toContain('move /y')
    expect(command).toContain('.jl-skills.exe.update-1')
    expect(command).toContain('jl-skills.exe')
  })

  test('installer self-uninstall delegates silent cleanup and exits without an outro', () => {
    const source = readFileSync(join(repo, 'src', 'jl-skill.ts'), 'utf8').replace(/\r\n/g, '\n')

    const helperStart = source.indexOf('function scheduleInstallerUninstall(')
    const helperEnd = source.indexOf('\nasync function updateInstallerWizard(', helperStart)
    const helper = source.slice(helperStart, helperEnd)
    expect(helper).toContain("spawn('cmd.exe'")
    expect(helper).toContain("spawn('/bin/sh'")
    expect(helper).toContain("stdio: 'ignore'")
    expect(helper).toContain('rmdir /s /q')
    expect(helper).toContain('rm -rf --')

    const wizardStart = source.indexOf('async function uninstallInstallerWizard(')
    const wizardEnd = source.indexOf('\nasync function bareWizard(', wizardStart)
    const wizard = source.slice(wizardStart, wizardEnd)
    expect(wizard).toContain('scheduleInstallerUninstall(executable, installerDataRoot())')
    expect(wizard).not.toContain('rmSync(installerDataRoot()')
    expect(wizard).not.toContain('prompts.outro(')
    expect(wizard).not.toContain('scheduled')
  })
})
