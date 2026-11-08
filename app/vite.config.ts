/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { existsSync, readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { defineConfig, type Plugin } from 'vite'

// Local dev talks to the worker's `wrangler dev`; on Pages the Functions proxy does this.
const api = { '/api': 'http://127.0.0.1:8787' }

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
}

// Pages serves text assets compressed and `vite preview` does not, so a throttled e2e run
// would otherwise time transfers no visitor ever makes.
function compressPreview(outDir: string): Plugin {
  const cache = new Map<string, Buffer>()
  return {
    name: 'compress-preview',
    configurePreviewServer(server) {
      const root = resolve(server.config.root, outDir)
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '/').split('?')[0]!
        const file = resolve(root, path === '/' ? 'index.html' : `.${decodeURIComponent(path)}`)
        const type = TYPES[extname(file)]
        if (!type || !file.startsWith(root) || !/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')) || !existsSync(file)) return next()
        let body = cache.get(file)
        if (!body) {
          body = gzipSync(readFileSync(file))
          cache.set(file, body)
        }
        res.setHeader('Content-Type', type)
        res.setHeader('Content-Encoding', 'gzip')
        res.setHeader('Vary', 'Accept-Encoding')
        res.end(body)
      })
    },
  }
}

// Outside Nimiq Pay the landing chunk is certain, so it starts downloading next to the entry
// instead of after it has run. Inside Nimiq Pay (`nimiqPay` is injected before any script)
// nothing is fetched. Mock builds skip this: the mock installs `nimiqPay` only later.
function preloadLanding(): Plugin {
  return {
    name: 'preload-landing',
    apply: (_, env) => env.command === 'build' && env.mode !== 'mock',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const chunk = Object.values(ctx.bundle ?? {}).find(c => c.type === 'chunk' && c.isDynamicEntry && /src[\\/]landing[\\/]Landing\.tsx$/.test(c.facadeModuleId ?? ''))
        if (!chunk || chunk.type !== 'chunk') return html
        const entry = ctx.chunk?.fileName
        const js = [chunk.fileName, ...chunk.imports.filter(f => f !== entry)]
        const css = [...(chunk.viteMetadata?.importedCss ?? [])]
        const files = JSON.stringify([...css, ...js].map(f => `/${f}`))
        const script = `if(!window.nimiqPay)${files}.forEach(function(h){var l=document.createElement('link');if(/\\.css$/.test(h))l.rel='stylesheet';else{l.rel='modulepreload';l.crossOrigin=''}l.href=h;document.head.appendChild(l)})`
        return { html, tags: [{ tag: 'script', children: script, injectTo: 'head' }] }
      },
    },
  }
}

export default defineConfig(({ mode }) => {
  // `--mode mock` builds a development bundle (import.meta.env.DEV, so ?mock= works)
  // into dist-mock/ for e2e runs on `vite preview`. dist/ never contains the mock.
  const mock = mode === 'mock'
  if (mock) process.env.NODE_ENV = 'development'
  const outDir = mock ? 'dist-mock' : 'dist'
  return {
    plugins: [react(), compressPreview(outDir), preloadLanding()],
    server: { proxy: api },
    preview: { proxy: api },
    build: { outDir, sourcemap: false },
    test: { environment: 'node', include: ['test/**/*.test.ts'] },
  }
})
