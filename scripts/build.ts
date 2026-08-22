import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const repo = join(import.meta.dir, '..')
const out = join(repo, 'build')
mkdirSync(out, { recursive: true })

await import('./generate-catalog')

const result = Bun.spawnSync([
  process.execPath,
  'build',
  join(repo, 'src', 'jl-skill.ts'),
  '--compile',
  '--outfile',
  join(out, 'jl-skill.exe'),
], {
  cwd: repo,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})

if (result.exitCode !== 0) process.exit(result.exitCode)
console.log(`Built ${join(out, 'jl-skill.exe')}`)
