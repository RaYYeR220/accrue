import type { Verdict } from '@accrue/shared'
import { glyphElement } from '../../ui/components/glyphs'
import { dotCounts, payoutPlan, type OrbitPool, type PayoutPlan } from './model'
import { rgba, tint, type RGB } from './tint'

// One example stake grows a ring per payout: dashed while expected (the pool's real fee and
// schedule), solid once landed (a sample). The listed pools sit on a quiet orbit as dot clouds,
// one dot per staker, sized by stake. Picking a pool turns the orbit to it and rebuilds the rings
// from that pool's own schedule and fee; each payout travels in from the pool.

export interface OrbitDom {
  disc: HTMLElement
  canvas: HTMLCanvasElement
  core: HTMLElement
  coreN: HTMLElement
  coreFiat: HTMLElement
  chip: HTMLElement
  chipK: HTMLElement
  chipV: HTMLElement
  chipW: HTMLElement
  tip: HTMLElement
  week: HTMLElement
  pline: HTMLElement
}

export interface OrbitCopy {
  fee(fee: number | null): string
  // "every 12 h" on the ring chip; "restakes every 12 h" in the pool tip
  sched(p: OrbitPool): string
  schedFull(p: OrbitPool): string
  nim(v: number, decimals: number): string
  perPayout(v: number): string
  weekday(d: number): string
  compact(v: number): string
  stakers(n: number, stake: string): string
  verdictLine(v: Verdict | null): string
  fiat(nim: number): string
  paidOutSample(amount: string): string
  chipLanded: string
  chipNext: string
  chipStream: string
  restaked: string
  paidOut: string
  atThreshold(n: number): string
  everyMinute: string
  payouts: string
  noneListed: string
  nothingLeft: string
  feeKeepsAll: string
  unpublished: string
  nothingToHold: string
  notEnoughData: string
}

export interface OrbitOptions {
  reduce: boolean
  copy: OrbitCopy
  onSelect(id: string): void
  // ≈ 752M NIM of rewards a year over 9.40B staked (validators API supply, 7 Nov 2026)
  grossYield?: number
}

export interface OrbitHandle {
  setPools(pools: OrbitPool[], selectId: string | null): void
  select(id: string, instant?: boolean): void
  setStake(nim: number): void
  setCopy(copy: OrbitCopy): void
  destroy(): void
}

const TAU = Math.PI * 2
const TOP = -Math.PI / 2
const GOLDEN = Math.PI * (3 - Math.sqrt(5))
const ANCHOR = -Math.PI * 0.75
const VIOLET = '#6b4fd8'
const WASH = '#ece7fb'
const INK = '#17161a'

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v))
const lerp = (a: number, b: number, u: number) => a + (b - a) * u
const easeIO = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2)
const vio = (a: number) => `rgba(107,79,216,${a})`

interface Cloud {
  p: OrbitPool
  slot: number
  col: RGB
  hi: RGB
  next: number
  glow: number
  sel: number
  hov: number
  x: number
  y: number
  rc: number
  ang: number
  dots: { f: number; th: number }[]
  // thinned clouds get slightly larger dots so they keep their weight
  dotScale: number
}

// Digits that roll when they change.
class Ticker {
  private key = ''
  private slots: HTMLSpanElement[] = []
  private timers = new Set<ReturnType<typeof setTimeout>>()
  constructor(private el: HTMLElement) {}
  render(str: string) {
    const chars = [...str]
    if (String(chars.length) !== this.key) {
      this.key = String(chars.length)
      this.el.textContent = ''
      this.slots = chars.map(c => {
        const s = document.createElement('span')
        s.className = 'slot'
        const d = document.createElement('span')
        d.textContent = c
        s.appendChild(d)
        this.el.appendChild(s)
        return s
      })
      return
    }
    chars.forEach((c, i) => {
      const s = this.slots[i]!
      const last = s.lastChild as HTMLSpanElement
      if (last.textContent === c) return
      last.className = 'out'
      const nu = document.createElement('span')
      nu.className = 'in'
      nu.textContent = c
      s.appendChild(nu)
      const id = setTimeout(() => {
        last.remove()
        this.timers.delete(id)
      }, 440)
      this.timers.add(id)
    })
  }
  reset() {
    this.key = ''
  }
  dispose() {
    for (const id of this.timers) clearTimeout(id)
  }
}

export function createOrbit(dom: OrbitDom, initial: OrbitPool[], initialId: string | null, opts: OrbitOptions): OrbitHandle {
  const { disc, canvas, chip, tip, week, core } = dom
  const ctx = canvas.getContext('2d')!
  const reduce = opts.reduce
  const gross = opts.grossYield ?? 0.08
  let copy = opts.copy
  const ticker = new Ticker(dom.coreN)

  let clouds: Cloud[] = []
  let pool: OrbitPool | null = null
  let cur: Cloud | null = null
  let hovered: Cloud | null = null
  let th0 = -Math.PI / 2
  let rot: { from: number; to: number; t0: number; d: number } | null = null
  let maxStake = 1

  const D = {
    stake: 10_000,
    ok: false,
    why: 'none' as PayoutPlan['why'],
    cont: false,
    direct: false,
    N: 0,
    k: 0,
    h: 0,
    net: 0,
    per: 0,
    stakeNow: 10_000,
    paid: 0,
    phase: 'idle' as 'idle' | 'count' | 'land' | 'done',
    t0: 0,
    lastCore: 0,
    coreF: 0.165,
    fade: 0,
    travel: -1,
  }

  const perOf = (s: number) => (s * D.net * D.h) / 8760
  const coreTarget = () => 0.165 + 0.03 * clamp(Math.log10(D.stake / 1000) / 3)
  const fmtNim = (v: number) => copy.nim(v, v >= 1e5 ? 0 : 2)
  const when = (i: number) => {
    const h0 = (i + 1) * D.h
    const d = Math.floor(h0 / 24) % 7
    const h = Math.floor(h0 % 24)
    const m = Math.round((h0 % 1) * 60) % 60
    return `${copy.weekday(d)} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  }
  const dur = (): [number, number, number] => (D.h >= 12 ? [2300, 750, 700] : D.h >= 3 ? [1500, 650, 450] : [560, 380, 120])

  function fiat() {
    dom.coreFiat.textContent = D.direct && D.ok ? copy.paidOutSample(copy.nim(D.paid, 2)) : copy.fiat(D.stakeNow)
  }

  function chipState(landed: boolean) {
    const p = pool
    if (!p) return
    chip.classList.toggle('landed', landed && D.ok)
    if (!D.ok) {
      // facts only: a verdict label never appears unless the API gave one
      const [k, v, w] =
        D.why === 'none'
          ? [copy.payouts, copy.noneListed, copy.fee(p.fee)]
          : D.why === 'noYield'
            ? [copy.fee(p.fee), copy.nothingLeft, copy.feeKeepsAll]
            : [copy.unpublished, copy.nothingToHold, copy.notEnoughData]
      dom.chipK.textContent = k
      dom.chipV.textContent = v
      dom.chipW.textContent = w
      return
    }
    if (D.cont) {
      dom.chipK.textContent = landed ? copy.chipLanded : copy.chipStream
      dom.chipV.textContent = copy.perPayout(D.per)
      dom.chipW.textContent = `${copy.fee(p.fee)} · ${copy.everyMinute}`
      return
    }
    dom.chipK.textContent = landed ? copy.chipLanded : copy.chipNext
    dom.chipV.textContent = copy.perPayout(D.per) + (landed ? ` ${D.direct ? copy.paidOut : copy.restaked}` : '')
    dom.chipW.textContent = `${when(D.k)} · ${p.mode === 'instant' ? copy.atThreshold(p.thresholdNim ?? 10) : copy.sched(p)}`
  }

  function build(now: number) {
    const p = pool
    if (!p) return
    const plan = payoutPlan(p, D.stake, gross)
    D.ok = plan.ok
    D.why = plan.why
    D.cont = plan.cont
    D.direct = plan.direct
    D.net = plan.net
    D.h = plan.h
    D.N = plan.N
    D.k = plan.k
    D.stakeNow = plan.stakeNow
    D.paid = plan.paid
    D.per = plan.per
    D.phase = reduce || !D.ok ? 'idle' : 'count'
    D.t0 = now
    D.fade = reduce ? 1 : 0
    D.travel = -1
    if (reduce) D.coreF = coreTarget()
    ticker.reset()
    ticker.render(fmtNim(D.stakeNow))
    fiat()
    chipState(false)
  }

  function makeClouds(list: OrbitPool[]) {
    // big and small pools interleaved so the ring reads evenly
    const order: number[] = []
    for (let a = 0, b = list.length - 1; a <= b; a++, b--) {
      order.push(a)
      if (a !== b) order.push(b)
    }
    const counts = dotCounts(list.map(p => p.stakers))
    clouds = order.map((pi, slot) => {
      const p = list[pi]!
      const n = counts[pi] ?? 0
      return {
        p,
        slot,
        col: tint(p.color, 0.42, 0.52, 0.72),
        hi: tint(p.color, 0.85, 0.46, 0.66),
        next: Math.random() * (p.h || 2),
        glow: 0,
        sel: 0,
        hov: 0,
        x: 0,
        y: 0,
        rc: 4,
        ang: 0,
        dots: Array.from({ length: n }, (_, j) => ({ f: Math.sqrt((j + 0.5) / n), th: j * GOLDEN })),
        dotScale: n > 0 ? Math.min(1.6, Math.sqrt(p.stakers / n)) : 1,
      }
    })
    maxStake = Math.max(1, ...list.map(p => p.stake))
    size()
  }

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string) {
    const e = document.createElement(tag)
    if (text !== undefined) e.textContent = text
    if (cls) e.className = cls
    return e
  }

  function verdictSpan(v: Verdict | null) {
    const s = el('span', undefined, 'v')
    s.append(glyphElement(v ?? 'NOT_ENOUGH_DATA'), document.createTextNode(copy.verdictLine(v)))
    return s
  }

  function tipFor(c: Cloud | null) {
    if (!c) return
    const p = c.p
    const color = rgba(c.hi, 1)
    const head = el('b')
    head.append(el('i'), document.createTextNode(p.name))
    const rows: Node[] = [head, el('span', `${copy.fee(p.fee)} · ${copy.schedFull(p)}`), el('span', copy.stakers(p.stakers, copy.compact(p.stake)))]
    if (c === cur) rows.push(verdictSpan(p.verdict))
    tip.style.setProperty('--c', color)
    tip.replaceChildren(...rows)
    if (c === cur) {
      const dot = el('i')
      dot.style.setProperty('--c', color)
      dom.pline.replaceChildren(dot, el('b', p.name), document.createTextNode(` · ${copy.fee(p.fee)} · ${copy.schedFull(p)}`), verdictSpan(p.verdict))
    }
    invalidate()
  }

  function select(id: string, instant = false) {
    const c = clouds.find(x => x.p.id === id)
    if (!c) return
    pool = c.p
    cur = c
    hovered = null
    const target = ANCHOR - (c.slot * TAU) / clouds.length
    const delta = ((((target - th0) % TAU) + TAU * 1.5) % TAU) - TAU / 2
    if (instant || reduce) {
      th0 += delta
      rot = null
    } else rot = { from: th0, to: th0 + delta, t0: performance.now(), d: 900 + (700 * Math.abs(delta)) / Math.PI }
    if (reduce) for (const x of clouds) x.sel = x === c ? 1 : 0
    build(performance.now())
    tipFor(c)
    opts.onSelect(c.p.id)
  }

  // ---- size
  let S = 0
  let dpr = 1
  let kc = 1
  function size() {
    dpr = Math.min(2, devicePixelRatio || 1)
    S = disc.clientWidth
    canvas.width = Math.round(S * dpr)
    canvas.height = Math.round(S * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    kc = (0.05 * S) / Math.sqrt(maxStake)
    core.style.setProperty('--core-fs', `${Math.round(clamp(S * 0.044, 17, 28))}px`)
    invalidate()
  }

  // ---- orbit hit + hover
  const hitCloud = (x: number, y: number) => clouds.find(c => Math.hypot(x - c.x, y - c.y) < Math.max(c.rc + 6, 15)) ?? null
  const local = (e: PointerEvent | MouseEvent) => {
    const r = disc.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top] as const
  }
  const onMove = (e: PointerEvent) => {
    const c = hitCloud(...local(e))
    if (c === hovered) return
    hovered = c
    canvas.style.cursor = c ? 'pointer' : 'default'
    if (reduce) for (const x of clouds) x.hov = x === c ? 1 : 0
    tipFor(c ?? cur)
  }
  const onLeave = () => {
    hovered = null
    if (reduce) for (const x of clouds) x.hov = 0
    tipFor(cur)
  }
  const onClick = (e: MouseEvent) => {
    const c = hitCloud(...local(e))
    if (c && c !== cur) select(c.p.id)
  }
  disc.addEventListener('pointermove', onMove)
  disc.addEventListener('pointerleave', onLeave)
  disc.addEventListener('click', onClick)
  const ro = new ResizeObserver(size)
  ro.observe(disc)

  function ring(x: number, y: number, r: number, a0 = 0, a1 = TAU) {
    ctx.beginPath()
    ctx.arc(x, y, r, a0, a1)
    ctx.stroke()
  }

  // concentric rings of one style in a single stroke (an hourly pool has up to 168)
  function rings(c: number, from: number, to: number, r: (i: number) => number) {
    if (from >= to) return
    ctx.beginPath()
    for (let i = from; i < to; i++) {
      ctx.moveTo(c + r(i), c)
      ctx.arc(c, c, r(i), 0, TAU)
    }
    ctx.stroke()
  }

  // ---- frame loop: runs while the disc is on screen; with reduced motion it only redraws on change
  let raf = 0
  let visible = true
  let last = performance.now()
  let t = 0
  let alive = true

  function invalidate() {
    if (!raf && alive && visible && !document.hidden) raf = requestAnimationFrame(loop)
  }
  function loop(now: number) {
    raf = 0
    frame(now)
    if (!reduce || rot) invalidate()
  }
  const io = new IntersectionObserver(entries => {
    visible = entries.some(e => e.isIntersecting)
    if (visible) {
      last = performance.now()
      invalidate()
    }
  })
  io.observe(disc)
  const onVis = () => {
    if (!document.hidden) {
      last = performance.now()
      invalidate()
    }
  }
  document.addEventListener('visibilitychange', onVis)

  function frame(now: number) {
    const dts = Math.min(0.05, (now - last) / 1000)
    last = now
    if (!reduce) t += dts
    D.fade = reduce ? 1 : Math.min(1, D.fade + dts * 2.4)
    D.coreF = reduce ? coreTarget() : D.coreF + (coreTarget() - D.coreF) * Math.min(1, dts * 6)
    if (rot) {
      const u = clamp((now - rot.t0) / rot.d)
      th0 = lerp(rot.from, rot.to, easeIO(u))
      if (u >= 1) rot = null
    } else if (!reduce) th0 += (TAU / 320) * dts

    // payout clock for the chosen pool
    const dt = now - D.t0
    const [C, L, Hd] = dur()
    let u = 0
    let sweep = 0
    if (D.ok && !reduce) {
      if (D.cont) {
        const step = Math.max(1, Math.round(D.N / 2400))
        for (let s = 0; s < step; s++) D.stakeNow += perOf(D.stakeNow)
        D.k = Math.min(D.N, D.k + step)
        D.per = perOf(D.stakeNow)
        if (now - D.lastCore > 1000) {
          D.lastCore = now
          ticker.render(fmtNim(D.stakeNow))
          fiat()
          chipState(true)
          D.travel = now
        }
        if (D.k >= D.N) build(now)
      } else if (D.phase === 'count') {
        u = Math.min(1, dt / C)
        if (dt >= C - 650 && D.travel < 0) D.travel = now
        if (dt >= C) {
          D.phase = 'land'
          D.t0 = now
          if (D.direct) D.paid += D.per
          else D.stakeNow += D.per
          ticker.render(fmtNim(D.stakeNow))
          fiat()
          chipState(true)
          if (cur) cur.glow = 1
        }
      } else if (D.phase === 'land') {
        u = 1
        sweep = Math.min(1, dt / L)
        if (dt >= L + Hd) {
          D.k++
          D.travel = -1
          if (D.k >= D.N) {
            D.phase = 'done'
            D.t0 = now
          } else {
            D.per = perOf(D.direct ? D.stake : D.stakeNow)
            D.phase = 'count'
            D.t0 = now
            chipState(false)
          }
        }
      } else if (D.phase === 'done' && dt > 1800) build(now)
    }

    const c = S / 2
    const R0 = S * D.coreF
    const r1 = R0 + S * 0.022
    const r2 = S * 0.335
    const guide = r2 + 8
    const Ro = S * 0.43
    ctx.clearRect(0, 0, S, S)

    // orbit track
    ctx.lineWidth = 1
    ctx.setLineDash([1, 5])
    ctx.strokeStyle = 'rgba(23,22,26,.16)'
    ring(c, c, Ro)
    ctx.setLineDash([])
    // the pools
    const dotR = Math.max(0.6, S * 0.00135)
    for (const cl of clouds) {
      if (!reduce) {
        cl.sel += ((cl === cur ? 1 : 0) - cl.sel) * Math.min(1, dts * 5)
        cl.hov += ((cl === hovered ? 1 : 0) - cl.hov) * Math.min(1, dts * 8)
        if (cl.p.mode === 'periodic' && t >= cl.next) {
          cl.glow = Math.max(cl.glow, 0.8)
          cl.next += cl.p.h ?? 2
        } else if (cl.p.mode === 'instant' && t >= cl.next) {
          cl.glow = Math.max(cl.glow, 0.6)
          cl.next = t + 0.8 + Math.random() * 2.6
        } else if (cl.p.mode === 'stream') cl.glow = Math.max(cl.glow, 0.25 + 0.1 * Math.sin(t * 3 + cl.slot))
      }
      cl.glow = Math.max(0, cl.glow - dts / 0.8)
      cl.ang = th0 + (cl.slot * TAU) / clouds.length
      cl.x = c + Math.cos(cl.ang) * Ro
      cl.y = c + Math.sin(cl.ang) * Ro
      cl.rc = Math.max(S * 0.008, kc * Math.sqrt(cl.p.stake)) * (1 + 0.22 * cl.sel + 0.1 * cl.hov)
      const none = cl.p.mode === 'none'
      const base = none ? null : cl.sel > 0.5 ? cl.hi : cl.col
      const a = none ? 0.32 : 0.62 + 0.33 * Math.max(cl.glow, cl.sel, cl.hov)
      ctx.fillStyle = base ? rgba(base, a) : `rgba(23,22,26,${a})`
      ctx.beginPath()
      const rd = dotR * (cl.rc < 9 ? 1.25 : 1) * cl.dotScale
      for (const d of cl.dots) {
        const rr = d.f * cl.rc
        const x = cl.x + Math.cos(d.th + cl.ang) * rr
        const y = cl.y + Math.sin(d.th + cl.ang) * rr
        ctx.moveTo(x + rd, y)
        ctx.arc(x, y, rd, 0, TAU)
      }
      ctx.fill()
      if (cl.p.mode === 'unpub') {
        ctx.setLineDash([2, 2])
        ctx.strokeStyle = 'rgba(23,22,26,.3)'
        ring(cl.x, cl.y, cl.rc + 3)
        ctx.setLineDash([])
      }
      if (cl.glow > 0.05 && cl.p.mode !== 'stream') {
        ctx.strokeStyle = rgba(cl.hi, 0.4 * cl.glow)
        ring(cl.x, cl.y, cl.rc + 2 + 6 * (1 - cl.glow))
      }
      if (cl.sel > 0.02) {
        ctx.strokeStyle = vio(0.7 * cl.sel)
        ring(cl.x, cl.y, cl.rc + 6)
      }
    }
    // the chosen pool's line in to the stake
    if (cur) {
      const ca = Math.cos(cur.ang)
      const sa = Math.sin(cur.ang)
      const from = Ro - cur.rc - 8
      const to = guide + 3
      ctx.setLineDash([2, 3])
      ctx.strokeStyle = vio(0.35 * cur.sel)
      ctx.beginPath()
      ctx.moveTo(c + ca * from, c + sa * from)
      ctx.lineTo(c + ca * to, c + sa * to)
      ctx.stroke()
      ctx.setLineDash([])
      if (D.ok && D.travel > 0 && !reduce) {
        const span = D.cont ? 420 : 650
        const q = (now - D.travel) / span
        if (q >= 0 && q <= 1) {
          const end = D.cont ? r1 + ((r2 - r1) * D.k) / D.N : r1 + ((r2 - r1) * (D.k + 1)) / D.N
          const rr = lerp(from, end, easeIO(q))
          ctx.fillStyle = vio(0.9)
          ctx.beginPath()
          ctx.arc(c + ca * rr, c + sa * rr, 2.8, 0, TAU)
          ctx.fill()
        }
      }
    }

    // the stake's week: the outer guide is where the rings end if every payout lands
    ctx.lineWidth = 1
    ctx.setLineDash([2, 5])
    ctx.strokeStyle = 'rgba(23,22,26,.2)'
    ring(c, c, guide)
    ctx.setLineDash([])
    ctx.globalAlpha = D.fade
    if (D.ok) {
      const N = D.N
      const k = D.k
      const rr = (i: number) => r1 + ((r2 - r1) * (i + 1)) / N
      if (!D.cont) {
        ctx.strokeStyle = vio(0.07)
        rings(c, k + 1, N, rr)
      }
      const lw = N <= 20 ? 1.5 : N <= 60 ? 0.8 : 0.6
      const la = N <= 20 ? 0.85 : N <= 60 ? 0.55 : 0.4
      if (D.cont) {
        ctx.fillStyle = vio(0.16)
        ctx.beginPath()
        ctx.arc(c, c, rr(k - 1), 0, TAU)
        ctx.arc(c, c, r1, 0, TAU, true)
        ctx.fill()
        ctx.strokeStyle = vio(0.9)
        ctx.lineWidth = 1.2
        ring(c, c, rr(k - 1))
      } else {
        ctx.strokeStyle = vio(la)
        ctx.lineWidth = lw
        rings(c, 0, Math.min(k, N), rr)
      }
      if (!D.cont && k < N) {
        const r = rr(k)
        if (D.phase !== 'land') {
          ctx.setLineDash([3, 4])
          ctx.lineDashOffset = reduce ? 0 : -now / 90
          ctx.strokeStyle = vio(0.75)
          ctx.lineWidth = 1.2
          ring(c, c, r)
          ctx.setLineDash([])
          ctx.lineDashOffset = 0
          if (u > 0) {
            ctx.strokeStyle = vio(0.28)
            ctx.lineWidth = 3
            ctx.lineCap = 'round'
            ring(c, c, r, TOP, TOP + TAU * u)
            ctx.lineCap = 'butt'
          }
          const hx = c + Math.cos(TOP + TAU * u) * r
          const hy = c + Math.sin(TOP + TAU * u) * r
          ctx.fillStyle = VIOLET
          ctx.beginPath()
          ctx.arc(hx, hy, 3.4, 0, TAU)
          ctx.fill()
        } else {
          ctx.strokeStyle = VIOLET
          ctx.lineWidth = Math.max(1.6, lw + 0.6)
          ring(c, c, r, TOP, TOP + TAU * (1 - Math.pow(1 - sweep, 3)))
          if (sweep < 1) {
            ctx.strokeStyle = vio(0.35 * (1 - sweep))
            ctx.lineWidth = 1
            ring(c, c, r + 10 * sweep)
          }
        }
      }
    }
    ctx.globalAlpha = 1
    // the stake itself
    ctx.fillStyle = WASH
    ctx.strokeStyle = vio(0.55)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(c, c, R0, 0, TAU)
    ctx.fill()
    ctx.stroke()

    // ring chip and its leader, upper right, away from the anchor
    const ang = -Math.PI / 4.4
    const rk = D.ok ? r1 + ((r2 - r1) * (Math.min(D.k, D.N - 1) + 1)) / D.N : R0 + 2
    const px = c + Math.cos(ang) * rk
    const py = c + Math.sin(ang) * rk
    const cw = chip.offsetWidth
    const chh = chip.offsetHeight
    let x = px + 22
    let y = py - chh - 16
    // on narrow screens the chip never leaves the disc, so nothing pokes past the page edge
    x = Math.min(S - cw + (S < 500 ? -2 : 18), x)
    y = Math.max(-4, y)
    chip.style.transform = `translate(${x}px,${y}px)`
    ctx.strokeStyle = 'rgba(23,22,26,.25)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(px, py)
    ctx.lineTo(x, y + chh)
    ctx.stroke()
    ctx.fillStyle = INK
    ctx.beginPath()
    ctx.arc(px, py, 2, 0, TAU)
    ctx.fill()
    week.style.transform = `translate(${c}px,${c + guide + 6}px) translateX(-50%)`
    // the pool tip sits beyond the chosen (or hovered) cloud
    const tc = hovered ?? cur
    if (tc) {
      const tw = tip.offsetWidth
      const th = tip.offsetHeight
      const up = tc.y < c
      let tx = tc.x - tw / 2
      let ty = up ? tc.y - tc.rc - th - 10 : tc.y + tc.rc + 10
      tx = Math.max(S < 500 ? 0 : -24, Math.min(S - tw + (S < 500 ? 0 : 24), tx))
      ty = Math.max(-8, Math.min(S - th + 8, ty))
      tip.style.transform = `translate(${tx}px,${ty}px)`
    }
  }

  function setPools(list: OrbitPool[], selectId: string | null) {
    const keep = selectId ?? pool?.id ?? null
    makeClouds(list)
    pool = null
    cur = null
    hovered = null
    const id = keep && list.some(p => p.id === keep) ? keep : list[0]?.id
    if (id) select(id, true)
  }

  makeClouds(initial)
  const first = initialId ?? initial[0]?.id
  if (first) select(first, true)
  if (document.fonts) {
    void document.fonts.ready.then(() => {
      if (!alive) return
      size()
      tipFor(hovered ?? cur)
    })
  }

  return {
    setPools,
    select,
    setStake(nim: number) {
      D.stake = nim
      build(performance.now())
      invalidate()
    },
    // new wording or prices: refresh the text, keep the payout week where it is
    setCopy(next: OrbitCopy) {
      copy = next
      ticker.render(fmtNim(D.stakeNow))
      fiat()
      chipState(chip.classList.contains('landed'))
      tipFor(hovered ?? cur)
    },
    destroy() {
      alive = false
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
      io.disconnect()
      ticker.dispose()
      document.removeEventListener('visibilitychange', onVis)
      disc.removeEventListener('pointermove', onMove)
      disc.removeEventListener('pointerleave', onLeave)
      disc.removeEventListener('click', onClick)
    },
  }
}
