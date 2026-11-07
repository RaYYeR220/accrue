/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Local dev talks to the worker's `wrangler dev`; on Pages the Functions proxy does this.
const api = { '/api': 'http://127.0.0.1:8787' }

export default defineConfig(({ mode }) => {
  // `--mode mock` builds a development bundle (import.meta.env.DEV, so ?mock= works)
  // into dist-mock/ for e2e runs on `vite preview`. dist/ never contains the mock.
  const mock = mode === 'mock'
  if (mock) process.env.NODE_ENV = 'development'
  return {
    plugins: [react()],
    server: { proxy: api },
    preview: { proxy: api },
    build: { outDir: mock ? 'dist-mock' : 'dist', sourcemap: false },
    test: { environment: 'node', include: ['test/**/*.test.ts'] },
  }
})
