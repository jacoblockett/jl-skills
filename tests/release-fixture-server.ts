import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dir, '..')
const build = join(repo, 'build')
const readyFile = process.env.JL_SKILLS_FIXTURE_READY
if (!readyFile) throw new Error('JL_SKILLS_FIXTURE_READY is required')

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/manifest.json') {
      const manifest = JSON.parse(readFileSync(join(build, 'manifest.json'), 'utf8'))
      const base = `http://127.0.0.1:${server.port}`
      manifest.installer.url = `${base}/jl-skills.exe`
      for (const [name, skill] of Object.entries(manifest.skills) as [string, any][]) {
        skill.url = `${base}/${name}.zip`
      }
      return Response.json(manifest)
    }

    const name = url.pathname.replace(/^\//, '')
    if (name === 'jl-skills.exe' || /^[a-z0-9][a-z0-9-]*\.zip$/.test(name)) {
      return new Response(Bun.file(join(build, name)))
    }
    return new Response('not found', { status: 404 })
  },
})

writeFileSync(readyFile, String(server.port))

process.on('SIGTERM', () => {
  server.stop(true)
  process.exit(0)
})
