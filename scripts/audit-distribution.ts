import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { extractZip } from '../src/archive'
import { parseReleaseManifest, parseSkillPackageManifest } from '../src/installer-updater'
import {
  installerAssetName,
  runtimeArtifactPath,
  skillArchiveName,
  targetByKey,
} from '../src/targets'

const target = targetByKey(process.env.JL_SKILLS_DISTRIBUTION_TARGET?.trim() || '')
const root = resolve(process.env.JL_SKILLS_DISTRIBUTION_ROOT?.trim() || join('build', 'distribution', target.key))
const reportPath = resolve(
  process.env.JL_SKILLS_DISTRIBUTION_REPORT?.trim()
    || join('build', 'distribution-reports', `${target.key}.json`),
)
const releaseTag = process.env.JL_SKILLS_RELEASE_TAG?.trim() || 'nightly'
const installer = join(root, installerAssetName(target))
const mapArchive = join(root, skillArchiveName('map', target))
const manifestPath = join(root, 'manifest.json')
const extractedMap = join(root, '.map-package')

type Check = {
  name: string
  ok: boolean
  detail: string
  blocker: boolean
}

const checks: Check[] = []

function record(name: string, ok: boolean, detail: string, blocker = true): void {
  checks.push({ name, ok, detail, blocker })
  console.log(`${ok ? 'PASS' : blocker ? 'FAIL' : 'INFO'} ${name}: ${detail}`)
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function command(command: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true })
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function runExecutable(path: string, args: string[]): void {
  if (target.os !== 'windows') chmodSync(path, 0o755)
  const result = command(path, args)
  record(
    `${basename(path)} launches`,
    result.status === 0,
    result.status === 0 ? 'exit 0' : `exit ${result.status}; ${result.stderr.trim() || result.stdout.trim()}`,
  )
}

function auditMac(path: string): void {
  const signature = command('/usr/bin/codesign', ['-dv', '--verbose=4', path])
  const signatureText = `${signature.stdout}\n${signature.stderr}`
  const developerId = signatureText.includes('Authority=Developer ID Application:')
  record(
    `${basename(path)} Developer ID signature`,
    developerId,
    developerId ? 'Developer ID Application authority present' : (signatureText.trim() || 'no code-signing details'),
  )

  const quarantine = command('/usr/bin/xattr', [
    '-w',
    'com.apple.quarantine',
    `0081;${Math.floor(Date.now() / 1000).toString(16)};Safari;`,
    path,
  ])
  record(
    `${basename(path)} quarantine simulation`,
    quarantine.status === 0,
    quarantine.status === 0 ? 'com.apple.quarantine applied' : quarantine.stderr.trim(),
  )

  const gatekeeper = command('/usr/sbin/spctl', ['--assess', '--type', 'execute', '-vv', path])
  const gatekeeperText = `${gatekeeper.stdout}\n${gatekeeper.stderr}`.trim()
  record(
    `${basename(path)} Gatekeeper assessment`,
    gatekeeper.status === 0,
    gatekeeperText || `spctl exit ${gatekeeper.status}`,
  )
}

function auditWindows(path: string): void {
  const escaped = path.replaceAll("'", "''")
  const signature = command('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `(Get-AuthenticodeSignature -LiteralPath '${escaped}').Status.ToString()`,
  ])
  const status = signature.stdout.trim()
  record(
    `${basename(path)} Authenticode signature`,
    signature.status === 0 && status === 'Valid',
    status || signature.stderr.trim() || `PowerShell exit ${signature.status}`,
  )
}

function binaryAbi(path: string): string {
  const file = command('file', ['-L', path])
  const readelf = command('readelf', ['-l', path])
  return `${file.stdout}\n${readelf.stdout}\n${readelf.stderr}`
}

function auditLinux(path: string): void {
  const originalExecutable = (statSync(path).mode & 0o111) !== 0
  record(
    `${basename(path)} download executable bit`,
    originalExecutable,
    originalExecutable ? 'download retained an executable bit' : 'raw GitHub Release download requires chmod +x',
    false,
  )

  const abi = binaryAbi(path)
  if (target.abi === 'musl') {
    const musl = /musl/i.test(abi) || /statically linked/i.test(abi)
    record(`${basename(path)} musl ABI`, musl, abi.trim())
  } else {
    const gnu = /ld-linux|glibc|GNU\/Linux/i.test(abi)
    record(`${basename(path)} GNU ABI`, gnu, abi.trim())
  }
}

try {
  for (const path of [manifestPath, installer, mapArchive]) {
    record(`${basename(path)} downloaded`, existsSync(path), path)
  }

  if (existsSync(manifestPath) && existsSync(installer) && existsSync(mapArchive)) {
    const manifest = parseReleaseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
    const installerEntry = manifest.installer.artifacts[target.key]
    const mapEntry = manifest.skills.map?.artifacts[target.key]
    const expectedBase = `https://github.com/jacoblockett/jl-skills/releases/download/${releaseTag}`

    record('installer manifest target', !!installerEntry, installerEntry?.url || 'missing')
    record('Map manifest target', !!mapEntry, mapEntry?.url || 'missing')
    if (installerEntry) {
      record('installer release URL', installerEntry.url === `${expectedBase}/${basename(installer)}`, installerEntry.url)
      record('installer release SHA-256', installerEntry.sha256 === sha256(installer), installerEntry.sha256)
    }
    if (mapEntry) {
      record('Map release URL', mapEntry.url === `${expectedBase}/${basename(mapArchive)}`, mapEntry.url)
      record('Map release SHA-256', mapEntry.sha256 === sha256(mapArchive), mapEntry.sha256)
    }

    runExecutable(installer, ['--version'])

    rmSync(extractedMap, { recursive: true, force: true })
    mkdirSync(extractedMap, { recursive: true })
    extractZip(mapArchive, extractedMap)
    const packageManifest = parseSkillPackageManifest(JSON.parse(readFileSync(join(extractedMap, 'manifest.json'), 'utf8')))
    const runtimeKeys = Object.keys(packageManifest.runtime_artifacts ?? {})
    record(
      'Map package runtime target',
      runtimeKeys.length === 1 && runtimeKeys[0] === target.key,
      runtimeKeys.join(', ') || 'none',
    )
    const runtimeRelative = runtimeArtifactPath('map', target)
    record(
      'Map package runtime path',
      packageManifest.runtime_artifacts?.[target.key] === runtimeRelative,
      packageManifest.runtime_artifacts?.[target.key] || 'missing',
    )
    const runtime = join(extractedMap, runtimeRelative)
    record('Map package runtime downloaded', existsSync(runtime), runtime)
    if (existsSync(runtime)) runExecutable(runtime, ['--help'])

    if (target.os === 'macos') {
      auditMac(installer)
      if (existsSync(runtime)) auditMac(runtime)
    } else if (target.os === 'windows') {
      auditWindows(installer)
      if (existsSync(runtime)) auditWindows(runtime)
    } else {
      auditLinux(installer)
      if (existsSync(runtime)) auditLinux(runtime)
    }
  }
} catch (error) {
  record('distribution audit execution', false, error instanceof Error ? error.stack || error.message : String(error))
}

mkdirSync(dirname(reportPath), { recursive: true })
const blockers = checks.filter((check) => check.blocker && !check.ok)
writeFileSync(reportPath, `${JSON.stringify({
  format: 1,
  target: target.key,
  release_tag: releaseTag,
  generated_at: new Date().toISOString(),
  ok: blockers.length === 0,
  checks,
}, null, 2)}\n`)

if (blockers.length > 0) {
  console.error(`Distribution audit failed with ${blockers.length} blocking check(s).`)
  process.exit(1)
}

console.log(`Distribution audit passed for ${target.key}.`)
