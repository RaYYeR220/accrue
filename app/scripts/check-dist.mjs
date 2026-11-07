// Fails the build if any dev-only mock code reached dist, and prints bundle sizes.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const banned = ['installMock', '__accrueMock', 'reject-sign', 'htlc-only-balance', 'MOCK_RATES']

function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

let failed = false
let totalRaw = 0
let totalGz = 0
for (const file of walk(dist)) {
  const rel = relative(dist, file).replaceAll('\\', '/')
  const buf = readFileSync(file)
  const text = buf.toString('utf8')
  for (const word of banned) {
    if (rel.includes(word) || text.includes(word)) {
      console.error(`check-dist: "${word}" found in ${rel}`)
      failed = true
    }
  }
  if (/\.(js|css|html)$/.test(rel)) {
    const gz = gzipSync(buf).length
    totalRaw += buf.length
    totalGz += gz
    console.log(`${rel.padEnd(40)} ${(buf.length / 1024).toFixed(1).padStart(8)} kB  gzip ${(gz / 1024).toFixed(1).padStart(7)} kB`)
  }
}
console.log(`${'total'.padEnd(40)} ${(totalRaw / 1024).toFixed(1).padStart(8)} kB  gzip ${(totalGz / 1024).toFixed(1).padStart(7)} kB`)

if (failed) process.exit(1)
console.log('check-dist: no mock code in dist')
