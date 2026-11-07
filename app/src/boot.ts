export type Mode = 'app' | 'landing'

// Nimiq Pay injects `nimiqPay` before any page script runs, so this is a plain
// synchronous read. Awaiting the SDK's init() here would stall the landing page
// for its full timeout in an ordinary browser.
export function detectMode(w: Window): Mode {
  const ctx: unknown = w.nimiqPay
  return typeof ctx === 'object' && ctx !== null ? 'app' : 'landing'
}
