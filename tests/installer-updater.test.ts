import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  checkInstallerUpdate,
  compareVersions,
  downloadSkillPackage,
  downloadVerifiedInstaller,
  fetchStableReleaseManifest,
  parseReleaseManifest,
  parseSkillPackageManifest,
  stageInstallerUpdate,
  windowsReplacementCommand,
  type InstallerUpdate,
  type ReleasedSkill,
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

function releaseManifest(installerVersion = '0.6.0', mapVersion = '0.3.0', mapSha = '1'.repeat(64)) {
  return {
    format: 1,
    installer: {
      version: installerVersion,
      url: 'https://fixture.invalid/jl-skills.exe',
      sha256: '0'.repeat(64),
    },
    skills: {
      map: {
        version: mapVersion,
        min_installer: '0.5.0',
        url: 'https://fixture.invalid/map.zip',
        sha256: mapSha,
      },
    },
  }
}

function fixtureFetcher(
  manifest: unknown,
  installer: Uint8Array | string = 'replacement-exe',
  mapArchive?: Uint8Array,
): typeof fetch {
  return (async (input: any) => {
    const url = String(input)
    if (url === 'https://fixture.invalid/manifest.json') {
      return new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://fixture.invalid/jl-skills.exe') return new Response(installer, { status: 200 })
    if (url === 'https://fixture.invalid/map.zip' && mapArchive) return new Response(mapArchive, { status: 200 })
    return new Response('missing', { status: 404 })
  }) as typeof fetch
}

describe('release metadata', () => {
  test('semantic versions compare deterministically', () => {
    expect(compareVersions('0.5.0', '0.5.0')).toBe(0)
    expect(compareVersions('0.5.0', '0.6.0')).toBe(-1)
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
    expect(() => compareVersions('0.5.0-nightly', '0.5.0')).toThrow('invalid semantic version comparison')
  })

  test('release manifest requires the locked installer and skill schema', () => {
    const parsed = parseReleaseManifest(releaseManifest())
    expect(parsed.installer.version).toBe('0.6.0')
    expect(parsed.skills.map.version).toBe('0.3.0')
    expect(parsed.skills.map.min_installer).toBe('0.5.0')
    expect(parsed.skills.map.url).toBe('https://fixture.invalid/map.zip')

    expect(() => parseReleaseManifest({ ...releaseManifest(), format: 2 })).toThrow('unsupported release manifest format')
    expect(() => parseReleaseManifest({
      ...releaseManifest(),
      skills: { map: { ...releaseManifest().skills.map, sha256: 'BAD' } },
    })).toThrow('invalid SHA-256')
  })

  test('skill package manifest validates install semantics independently', () => {
    const parsed = parseSkillPackageManifest({
      format: 1,
      name: 'map',
      version: '0.3.0',
      min_installer: '0.5.0',
      description: 'Map',
      skill_files: ['SKILL.md', 'agents'],
      runtime: 'rust',
      runtime_artifacts: { 'windows-x64': 'runtime/windows-x64/map.exe' },
      runtime_shared_files: { 'schema.surql': '~/.jl-skills/map/schema.surql' },
      generated_data: [{ path: '.map', marker: 'project.json' }],
    })
    expect(parsed.name).toBe('map')
    expect(parsed.runtime_artifacts?.['windows-x64']).toBe('runtime/windows-x64/map.exe')
    expect(parsed.generated_data?.[0]).toEqual({ path: '.map', marker: 'project.json' })

    expect(() => parseSkillPackageManifest({
      format: 1,
      name: 'map',
      version: '0.3.0',
      min_installer: '0.5.0',
      description: 'Map',
      skill_files: ['../escape'],
    })).toThrow('relative contained path')
  })

  test('stable release fetch exposes skill versions and minimum installer', async () => {
    const parsed = await fetchStableReleaseManifest(
      'https://fixture.invalid/manifest.json',
      fixtureFetcher(releaseManifest()),
    )
    expect(parsed?.installer.version).toBe('0.6.0')
    expect(parsed?.skills.map.version).toBe('0.3.0')
    expect(parsed?.skills.map.min_installer).toBe('0.5.0')
  })

  test('release build emits installer, skill archive, and matching manifest hashes', () => {
    const executable = join(repo, 'build', 'jl-skills.exe')
    const mapArchive = join(repo, 'build', 'map.zip')
    const manifestPath = join(repo, 'build', 'manifest.json')
    expect(existsSync(executable)).toBe(true)
    expect(existsSync(mapArchive)).toBe(true)
    expect(existsSync(manifestPath)).toBe(true)

    const manifest = parseReleaseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
    expect(manifest.installer.sha256).toBe(sha256(readFileSync(executable)))
    expect(manifest.installer.url).toEndWith('/jl-skills.exe')
    expect(manifest.skills.map.sha256).toBe(sha256(readFileSync(mapArchive)))
    expect(manifest.skills.map.url).toEndWith('/map.zip')
  })

  test('no-update path returns null for equal or older installer releases', async () => {
    const manifest = releaseManifest('0.5.0')
    const update = await checkInstallerUpdate('0.5.0', 'https://fixture.invalid/manifest.json', fixtureFetcher(manifest))
    expect(update).toBeNull()
  })

  test('missing published manifest is treated as no update', async () => {
    const fetcher = (async () => new Response('missing', { status: 404 })) as typeof fetch
    expect(await checkInstallerUpdate('0.5.0', 'https://fixture.invalid/missing.json', fetcher)).toBeNull()
  })

  test('newer installer selects the manifest artifact directly', async () => {
    const bytes = 'replacement-exe'
    const manifest = releaseManifest('0.6.0')
    manifest.installer.sha256 = sha256(bytes)
    const update = await checkInstallerUpdate(
      '0.5.0',
      'https://fixture.invalid/manifest.json',
      fixtureFetcher(manifest, bytes),
    )
    expect(update?.version).toBe('0.6.0')
    expect(update?.artifact.url).toBe('https://fixture.invalid/jl-skills.exe')
  })
})

describe('skill package download', () => {
  test('verified archive is extracted and must match release index metadata', async () => {
    const root = reset('skill-package')
    const packageRoot = join(root, 'package')
    mkdirSync(packageRoot, { recursive: true })
    const manifest = {
      format: 1,
      name: 'map',
      version: '0.3.0',
      min_installer: '0.5.0',
      description: 'Map',
      skill_files: ['SKILL.md'],
    }
    writeFileSync(join(packageRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    writeFileSync(join(packageRoot, 'SKILL.md'), '<!-- jl-skills-meta: {"name":"map","version":"0.3.0","format":1} -->\n')

    const archive = join(root, 'map.zip')
    const packed = spawnSync('tar', ['-a', '-c', '-f', archive, '-C', packageRoot, 'manifest.json', 'SKILL.md'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    expect(packed.status).toBe(0)
    const bytes = new Uint8Array(readFileSync(archive))
    const released: ReleasedSkill = {
      version: '0.3.0',
      min_installer: '0.5.0',
      url: 'https://fixture.invalid/map.zip',
      sha256: sha256(bytes),
    }

    const downloaded = await downloadSkillPackage('map', released, fixtureFetcher({}, 'unused', bytes))
    try {
      expect(downloaded.manifest.name).toBe('map')
      expect(downloaded.manifest.version).toBe('0.3.0')
      expect(existsSync(join(downloaded.root, 'SKILL.md'))).toBe(true)
    } finally {
      downloaded.cleanup()
    }
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
    const staged = await stageInstallerUpdate(executable, update, fixtureFetcher({}, bytes))

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
