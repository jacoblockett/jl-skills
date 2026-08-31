import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { TARGET_KEYS } from '../src/targets'

const SIGNING_POLICY = 'unsigned-accepted' as const

type DistributionReport = {
  format: 1
  target: string
  release_tag: string
  signing_policy: typeof SIGNING_POLICY
  generated_at: string
  ok: boolean
}

type ValidationReceipt = {
  format: 1
  sha: string
  run_id: string
  release_tag: 'nightly'
  signing_policy: typeof SIGNING_POLICY
  manifest_sha256: string
  validated_at: string
  targets: string[]
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function exactTargets(values: string[]): boolean {
  return values.length === TARGET_KEYS.length && TARGET_KEYS.every((target) => values.includes(target))
}

function collectJson(root: string): string[] {
  const found: string[] = []
  const queue = [root]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (!existsSync(current)) continue
    if (statSync(current).isDirectory()) {
      for (const entry of readdirSync(current)) queue.push(join(current, entry))
    } else if (current.endsWith('.json')) found.push(current)
  }
  return found.sort()
}

function createReceipt(): void {
  const reportsRoot = resolve(process.env.JL_SKILLS_VALIDATION_REPORTS?.trim() || 'build/distribution-reports')
  const manifest = resolve(process.env.JL_SKILLS_VALIDATION_MANIFEST?.trim() || 'build/validation/manifest.json')
  const output = resolve(process.env.JL_SKILLS_VALIDATION_OUTPUT?.trim() || 'build/validation/validation.json')
  const sha = process.env.JL_SKILLS_VALIDATION_SHA?.trim()
  const runId = process.env.JL_SKILLS_VALIDATION_RUN_ID?.trim()
  if (!sha) throw new Error('JL_SKILLS_VALIDATION_SHA is required')
  if (!runId) throw new Error('JL_SKILLS_VALIDATION_RUN_ID is required')
  if (!existsSync(manifest)) throw new Error(`validated Nightly manifest is missing: ${manifest}`)

  const reports = collectJson(reportsRoot)
    .map((path) => JSON.parse(readFileSync(path, 'utf8')) as DistributionReport)
    .filter((report) => report?.format === 1 && typeof report.target === 'string')
  const targets = reports.map((report) => report.target).sort()
  if (!exactTargets(targets)) {
    throw new Error(`distribution validation receipt requires exact targets: expected ${TARGET_KEYS.join(', ')}, got ${targets.join(', ')}`)
  }
  for (const report of reports) {
    if (report.release_tag !== 'nightly') throw new Error(`${report.target} report is not for nightly`)
    if (report.signing_policy !== SIGNING_POLICY) {
      throw new Error(`${report.target} distribution report uses signing policy ${report.signing_policy || 'unknown'}`)
    }
    if (report.ok !== true) throw new Error(`${report.target} distribution report did not pass`)
  }

  const receipt: ValidationReceipt = {
    format: 1,
    sha,
    run_id: runId,
    release_tag: 'nightly',
    signing_policy: SIGNING_POLICY,
    manifest_sha256: sha256(manifest),
    validated_at: new Date().toISOString(),
    targets: [...TARGET_KEYS],
  }
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`)
  console.log(`Created ${output}`)
}

function verifyReceipt(): void {
  const receiptPath = resolve(process.env.JL_SKILLS_VALIDATION_RECEIPT?.trim() || 'build/validation/validation.json')
  const manifest = resolve(process.env.JL_SKILLS_VALIDATION_MANIFEST?.trim() || 'build/validation/manifest.json')
  const expectedSha = process.env.JL_SKILLS_VALIDATION_SHA?.trim()
  if (!expectedSha) throw new Error('JL_SKILLS_VALIDATION_SHA is required')
  if (!existsSync(receiptPath)) throw new Error(`Nightly validation receipt is missing: ${receiptPath}`)
  if (!existsSync(manifest)) throw new Error(`Nightly manifest is missing: ${manifest}`)

  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Partial<ValidationReceipt>
  if (receipt.format !== 1) throw new Error('unsupported Nightly validation receipt format')
  if (receipt.sha !== expectedSha) {
    throw new Error(`current main ${expectedSha} has not passed Nightly validation; receipt is for ${receipt.sha || 'unknown'}`)
  }
  if (receipt.release_tag !== 'nightly') throw new Error('validation receipt is not for Nightly')
  if (receipt.signing_policy !== SIGNING_POLICY) {
    throw new Error(`validation receipt signing policy is ${receipt.signing_policy || 'unknown'}, expected ${SIGNING_POLICY}`)
  }
  if (!Array.isArray(receipt.targets) || !exactTargets(receipt.targets)) {
    throw new Error('validation receipt does not contain the exact required target set')
  }
  const actualManifestHash = sha256(manifest)
  if (receipt.manifest_sha256 !== actualManifestHash) {
    throw new Error('Nightly validation receipt does not match the currently published manifest.json')
  }
  console.log(`Validated Nightly receipt for ${expectedSha}`)
}

const mode = process.argv[2]
if (mode === 'create') createReceipt()
else if (mode === 'verify') verifyReceipt()
else throw new Error('usage: bun scripts/validation-receipt.ts create|verify')
