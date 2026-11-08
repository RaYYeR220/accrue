// Read-through cache for upstream answers in two levels: this isolate's memory (always there, gone
// when the isolate is) and the data center's Cache API (shared by isolates; where the platform does
// not offer it, put/match are no-ops or throw, and memory alone serves).
interface Entry {
  at: number
  body: string
}

const memory = new Map<string, Entry>()
const inflight = new Map<string, Promise<Entry>>()
const MAX_MEMORY_ENTRIES = 1000

export function clearMemoryCache() {
  memory.clear()
  inflight.clear()
}

const cacheRequest = (key: string) => new Request(`https://cache.accrue.internal/${encodeURIComponent(key)}`)

function edgeCache(): Cache | null {
  const c = (globalThis as { caches?: { default?: Cache } }).caches
  return c?.default ?? null
}

function remember(key: string, e: Entry) {
  if (memory.size >= MAX_MEMORY_ENTRIES) memory.delete(memory.keys().next().value as string)
  memory.set(key, e)
}

async function lookup(key: string): Promise<Entry | null> {
  const m = memory.get(key)
  if (m) return m
  const edge = edgeCache()
  if (!edge) return null
  try {
    const res = await edge.match(cacheRequest(key))
    const at = Number(res?.headers.get('x-accrue-at'))
    if (!res || !Number.isFinite(at)) return null
    const e = { at, body: await res.text() }
    remember(key, e)
    return e
  } catch {
    return null
  }
}

async function store(key: string, e: Entry, keepMs: number) {
  remember(key, e)
  const edge = edgeCache()
  if (!edge) return
  try {
    await edge.put(
      cacheRequest(key),
      new Response(e.body, { headers: { 'cache-control': `max-age=${Math.ceil(keepMs / 1000)}`, 'x-accrue-at': String(e.at) } }),
    )
  } catch {
    // memory still holds it
  }
}

/** A copy younger than `maxAgeMs`, if one exists. */
export async function cacheGet(key: string, maxAgeMs: number, now = Date.now()): Promise<Entry | null> {
  const e = await lookup(key)
  return e && now - e.at < maxAgeMs && now >= e.at ? e : null
}

export async function cachePut(key: string, body: string, keepMs: number, now = Date.now()) {
  await store(key, { at: now, body }, keepMs)
}

/**
 * The cached copy while younger than `freshMs`; else `load()` (one call per isolate at a time), stored
 * for `staleMs`. When `load()` fails, a copy younger than `staleMs` is answered instead (stale: true);
 * with none, the error is thrown.
 */
export async function readThrough(
  key: string,
  ms: { freshMs: number; staleMs: number },
  load: () => Promise<string>,
  now = Date.now(),
): Promise<Entry & { stale: boolean }> {
  const hit = await lookup(key)
  if (hit && now - hit.at < ms.freshMs && now >= hit.at) return { ...hit, stale: false }
  let p = inflight.get(key)
  if (!p) {
    p = load().then(async (body) => {
      const e = { at: now, body }
      await store(key, e, ms.staleMs)
      return e
    })
    inflight.set(key, p)
    p.then(
      () => inflight.delete(key),
      () => inflight.delete(key),
    )
  }
  try {
    return { ...(await p), stale: false }
  } catch (err) {
    if (hit && now - hit.at < ms.staleMs) return { ...hit, stale: true }
    throw err
  }
}
