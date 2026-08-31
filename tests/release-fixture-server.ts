import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dir, '..')
const build = join(repo, 'build')
const readyFile = process.env.JL_SKILLS_FIXTURE_READY
if (!readyFile) throw new Error('JL_SKILLS_FIXTURE_READY is required')

function localizeArtifactUrls(manifest: any, base: string): void {
  for (const artifact of Object.values(manifest.installer.artifacts ?? {}) as any[]) {
    const asset = new URL(artifact.url).pathname.split('/').at(-1)
    if (!asset) throw new Error('installer fixture artifact URL has no asset name')
    artifact.url = `${base}/${asset}`
  }
  for (const skill of Object.values(manifest.skills ?? {}) as any[]) {
    for (const artifact of Object.values(skill.artifacts ?? {}) as any[]) {
      const asset = new URL(artifact.url).pathname.split('/').at(-1)
      if (!asset) throw new Error('skill fixture artifact URL has no asset name')
      artifact.url = `${base}/${asset}`
    }
  }
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/manifest.json' || url.pathname === '/incompatible-manifest.json') {
      const manifest = JSON.parse(readFileSync(join(build, 'manifest.json'), 'utf8'))
      const base = `http://127.0.0.1:${server.port}`
      localizeArtifactUrls(manifest, base)
      if (url.pathname === '/incompatible-manifest.json') {
        manifest.installer.version = '0.8.0'
        manifest.skills.map.min_installer = '0.8.0'
      }
      return Response.json(manifest)
    }

    const name = url.pathname.replace(/^\//, '')
    if (/^jl-skills(?:-[a-z0-9-]+)?(?:\.exe)?$/.test(name) || /^[a-z0-9][a-z0-9-]*\.zip$/.test(name)) {
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