import { describe, expect, test } from 'bun:test'
import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
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

function releaseManifest(installerVersion = '0.7.0', mapVersion = '0.4.0', mapSha = '1'.repeat(64)) {
  return {
    format: 2,
    installer: {
      version: installerVersion,
      artifacts: {
        'windows-x64': {
          url: 'https://fixture.invalid/jl-skills.exe',
          sha256: '0'.repeat(64),
        },
      },
    },
    skills: {
      map: {
        version: mapVersion,
        min_installer: '0.7.0',
        artifacts: {
          'windows-x64': {
            url: 'https://fixture.invalid/map.zip',
            sha256: mapSha,
          },
        },
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

  test('release manifest requires target-aware format 2', () => {
    const parsed = parseReleaseManifest(releaseManifest())
    expect(parsed.installer.version).toBe('0.7.0')
    expect(parsed.installer.artifacts['windows-x64']?.url).toBe('https://fixture.invalid/jl-skills.exe')
    expect(parsed.skills.map.version).toBe('0.4.0')
    expect(parsed.skills.map.min_installer).toBe('0.7.0')
    expect(parsed.skills.map.artifacts['windows-x64']?.url).toBe('https://fixture.invalid/map.zip')

    expect(() => parseReleaseManifest({ ...releaseManifest(), format: 1 })).toThrow('unsupported release manifest format')
    expect(() => parseReleaseManifest({
      ...releaseManifest(),
      skills: {
        map: {
          ...releaseManifest().skills.map,
          artifacts: {
            'windows-x64': { url: 'https://fixture.invalid/map.zip', sha256: 'BAD' },
          },
        },
      },
    })).toThrow('invalid SHA-256')
  })

  test('format 2 validates target keys and portable policy', () => {
    const portable = releaseManifest()
    portable.skills.map.artifacts = {
      portable: {
        url: 'https://fixture.invalid/map.zip',
        sha256: '1'.repeat(64),
      },
    } as any
    expect(parseReleaseManifest(portable).skills.map.artifacts.portable?.url).toBe('https://fixture.invalid/map.zip')

    const invalidInstaller = releaseManifest()
    invalidInstaller.installer.artifacts = {
      portable: {
        url: 'https://fixture.invalid/jl-skills.exe',
        sha256: '0'.repeat(64),
      },
    } as any
    expect(() => parseReleaseManifest(invalidInstaller)).toThrow('cannot publish a portable artifact')

    const invalidTarget = releaseManifest()
    invalidTarget.skills.map.artifacts = {
      'linux-x86': {
        url: 'https://fixture.invalid/map.zip',
        sha256: '1'.repeat(64),
      },
    } as any
    expect(() => parseReleaseManifest(invalidTarget)).toThrow('invalid target linux-x86')
  })

  test('skill package manifest validates install semantics independently', () => {
    const parsed = parseSkillPackageManifest({
      format: 1,
      name: 'map',
      version: '0.4.0',
      min_installer: '0.7.0',
      description: 'Map',
      skill_files: ['SKILL.md'],
      runtime: 'rust',
      runtime_artifacts: { 'windows-x64': 'runtime/windows-x64/map.exe' },
      runtime_files: ['schema.surql'],
      runtime_cli: 'map',
      generated_data: [{ path: '.map', marker: 'project.json' }],
    })
    expect(parsed.name).toBe('map')
    expect(parsed.runtime_artifacts?.['windows-x64']).toBe('runtime/windows-x64/map.exe')
    expect(parsed.runtime_files).toEqual(['schema.surql'])
    expect(parsed.runtime_cli).toBe('map')
    expect(parsed.generated_data?.[0]).toEqual({ path: '.map', marker: 'project.json' })

    expect(() => parseSkillPackageManifest({
      format: 1,
      name: 'map',
      version: '0.4.0',
      min_installer: '0.7.0',
      description: 'Map',
      skill_files: ['../escape'],
    })).toThrow('relative contained path')
  })

  test('stable release fetch exposes skill versions and artifact maps', async () => {
    const parsed = await fetchStableReleaseManifest(
      'https://fixture.invalid/manifest.json',
      fixtureFetcher(releaseManifest()),
    )
    expect(parsed?.installer.version).toBe('0.7.0')
    expect(parsed?.installer.artifacts['windows-x64']?.url).toBe('https://fixture.invalid/jl-skills.exe')
    expect(parsed?.skills.map.version).toBe('0.4.0')
    expect(parsed?.skills.map.min_installer).toBe('0.7.0')
  })

  test('release build emits installer, skill archive, and matching manifest hashes', () => {
    const executable = join(repo, 'build', 'jl-skills.exe')
    const mapArchive = join(repo, 'build', 'map.zip')
    const manifestPath = join(repo, 'build', 'manifest.json')
    expect(existsSync(executable)).toBe(true)
    expect(existsSync(mapArchive)).toBe(true)
    expect(existsSync(manifestPath)).toBe(true)

    const manifest = parseReleaseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
    const installerArtifact = manifest.installer.artifacts['windows-x64']
    const mapArtifact = manifest.skills.map.artifacts['windows-x64']
    expect(installerArtifact?.sha256).toBe(sha256(readFileSync(executable)))
    expect(installerArtifact?.url).toEndWith('/jl-skills.exe')
    expect(mapArtifact?.sha256).toBe(sha256(readFileSync(mapArchive)))
    expect(mapArtifact?.url).toEndWith('/map.zip')
  })

  test('no-update path returns null for equal or older installer releases', async () => {
    const manifest = releaseManifest('0.7.0')
    const update = await checkInstallerUpdate('0.7.0', 'https://fixture.invalid/manifest.json', fixtureFetcher(manifest))
    expect(update).toBeNull()
  })

  test('missing published manifest is treated as no update', async () => {
    const fetcher = (async () => new Response('missing', { status: 404 })) as typeof fetch
    expect(await checkInstallerUpdate('0.7.0', 'https://fixture.invalid/missing.json', fetcher)).toBeNull()
  })

  test('newer installer uses the pre-matrix Windows artifact', async () => {
    const bytes = 'replacement-exe'
    const manifest = releaseManifest('0.8.0')
    manifest.installer.artifacts['windows-x64'].sha256 = sha256(bytes)
    const update = await checkInstallerUpdate(
      '0.7.0',
      'https://fixture.invalid/manifest.json',
      fixtureFetcher(manifest, bytes),
    )
    expect(update?.version).toBe('0.8.0')
    expect(update?.artifact.url).toBe('https://fixture.invalid/jl-skills.exe')
  })
})

describe('skill package download', () => {
  test('verified ZIP is extracted without relying on an archive utility in PATH', async () => {
    const root = reset('skill-package')
    const packageRoot = join(root, 'package')
    mkdirSync(packageRoot, { recursive: true })
    const manifest = {
      format: 1,
      name: 'map',
      version: '0.4.0',
      min_installer: '0.7.0',
      description: 'Map',
      skill_files: ['SKILL.md'],
    }
    writeFileSync(join(packageRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    writeFileSync(join(packageRoot, 'SKILL.md'), '<!-- jl-skills-meta: {"name":"map","version":"0.4.0","format":1} -->\n')

    const zip = new AdmZip()
    zip.addLocalFile(join(packageRoot, 'manifest.json'))
    zip.addLocalFile(join(packageRoot, 'SKILL.md'))
    const bytes = new Uint8Array(zip.toBuffer())
    const released: ReleasedSkill = {
      version: '0.4.0',
      min_installer: '0.7.0',
      artifacts: {
        'windows-x64': {
          url: 'https://fixture.invalid/map.zip',
          sha256: sha256(bytes),
        },
      },
    }

    const originalPath = process.env.PATH
    process.env.PATH = ''
    try {
      const downloaded = await downloadSkillPackage('map', released, fixtureFetcher({}, 'unused', bytes))
      try {
        expect(downloaded.manifest.name).toBe('map')
        expect(downloaded.manifest.version).toBe('0.4.0')
        expect(existsSync(join(downloaded.root, 'SKILL.md'))).toBe(true)
      } finally {
        downloaded.cleanup()
      }
    } finally {
      process.env.PATH = originalPath
    }
  })

  test('portable skill artifacts are valid during the transition', async () => {
    const root = reset('portable-skill-package')
    const packageRoot = join(root, 'package')
    mkdirSync(packageRoot, { recursive: true })
    const manifest = {
      format: 1,
      name: 'portable-test',
      version: '1.0.0',
      min_installer: '0.7.0',
      description: 'Portable test',
      skill_files: ['SKILL.md'],
    }
    writeFileSync(join(packageRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    writeFileSync(join(packageRoot, 'SKILL.md'), '<!-- jl-skills-meta: {"name":"portable-test","version":"1.0.0","format":1} -->\n')
    const zip = new AdmZip()
    zip.addLocalFile(join(packageRoot, 'manifest.json'))
    zip.addLocalFile(join(packageRoot, 'SKILL.md'))
    const bytes = new Uint8Array(zip.toBuffer())
    const released: ReleasedSkill = {
      version: '1.0.0',
      min_installer: '0.7.0',
      artifacts: {
        portable: {
          url: 'https://fixture.invalid/map.zip',
          sha256: sha256(bytes),
        },
      },
    }

    const downloaded = await downloadSkillPackage('portable-test', released, fixtureFetcher({}, 'unused', bytes))
    try {
      expect(downloaded.manifest.name).toBe('portable-test')
    } finally {
      downloaded.cleanup()
    }
  })

  test('archive entry paths cannot escape the extraction root', async () => {
    const zip = new AdmZip()
    zip.addFile('C:/escape.txt', Buffer.from('bad'))
    const bytes = new Uint8Array(zip.toBuffer())
    const released: ReleasedSkill = {
      version: '0.4.0',
      min_installer: '0.7.0',
      artifacts: {
        'windows-x64': {
          url: 'https://fixture.invalid/map.zip',
          sha256: sha256(bytes),
        },
      },
    }

    await expect(downloadSkillPackage('map', released, fixtureFetcher({}, 'unused', bytes)))
      .rejects.toThrow('relative contained path')
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
      version: '0.8.0',
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
      version: '0.8.0',
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