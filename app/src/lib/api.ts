import { HttpError } from '../providers/errors'
import { timeoutSignal } from './util'

// JSON from our own /api. A non-2xx answer becomes HttpError carrying the body (null when it was not JSON).
export async function fetchJson(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<unknown> {
  const signal = timeoutSignal(timeoutMs)
  const res = await fetch(path, signal ? { ...init, signal } : init)
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new HttpError(res.status, body)
  return body
}
