export type RGB = [number, number, number]

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const gam = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)

function toLab(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map(i => lin(parseInt(h.slice(i, i + 2), 16) / 255)) as [number, number, number]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function toRgb(L: number, a: number, b: number): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(c => Math.round(255 * Math.min(1, Math.max(0, gam(c))))) as RGB
}

// A pool's own accent, chroma cut and lightness clamped (OKLCH) so it sits on the light ground.
export function tint(hex: string, chromaFactor: number, lo: number, hi: number): RGB {
  const [L, a, b] = toLab(hex)
  const C = Math.hypot(a, b)
  const h = Math.atan2(b, a)
  const C2 = Math.max(0.03, C * chromaFactor)
  const L2 = Math.min(hi, Math.max(lo, L))
  return toRgb(L2, C2 * Math.cos(h), C2 * Math.sin(h))
}

export const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`

export const accentDot = (hex: string) => rgba(tint(hex, 0.85, 0.46, 0.66), 1)
