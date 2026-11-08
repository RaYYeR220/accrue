// Puts the official General Sans webfonts into public/fonts so the site serves them itself.
// The ITF Free Font License allows self-hosting on our own site but not redistribution through a
// public repository, so the files are fetched from Fontshare at build time and kept out of git.
// `--optional` (used by `dev`) only warns when the download fails.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('../public/fonts/', import.meta.url))
const CDN = 'https://cdn.fontshare.com/wf'
const FILES = {
  'GeneralSans-Regular.woff2': `${CDN}/MFQT7HFGCR2L5ULQTW6YXYZXXHMPKLJ3/YWQ244D6TACUX5JBKATPOW5I5MGJ3G73/7YY3ZAAE3TRV2LANYOLXNHTPHLXVWTKH.woff2`,
  'GeneralSans-Medium.woff2': `${CDN}/3RZHWSNONLLWJK3RLPEKUZOMM56GO4LJ/BPDRY7AHVI3MCDXXVXTQQ76H3UXA63S3/SB2OEB6IKZPRR6JT4GFJ2TFT6HBB6AZN.woff2`,
  'GeneralSans-Semibold.woff2': `${CDN}/K46YRH762FH3QJ25IQM3VAXAKCHEXXW4/ISLWQPUZHZF33LRIOTBMFOJL57GBGQ4B/3ZLMEXZEQPLTEPMHTQDAUXP5ZZXCZAEN.woff2`,
}
const optional = process.argv.includes('--optional')

const isWoff2 = buf => buf.length > 1024 && buf.subarray(0, 4).toString('latin1') === 'wOF2'

mkdirSync(dir, { recursive: true })
let failed = false
for (const [name, url] of Object.entries(FILES)) {
  const path = dir + name
  if (existsSync(path) && isWoff2(readFileSync(path))) continue
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (!isWoff2(buf)) throw new Error('not a woff2 file')
    writeFileSync(path, buf)
    console.log(`fonts: fetched ${name} (${(buf.length / 1024).toFixed(1)} kB)`)
  } catch (e) {
    failed = true
    console[optional ? 'warn' : 'error'](`fonts: could not fetch ${name}: ${e instanceof Error ? e.message : e}`)
  }
}
if (failed && !optional) process.exit(1)
