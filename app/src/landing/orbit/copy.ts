import type { FiatApi } from '../../fiat/useFiat'
import { t } from '../../i18n'
import { fmtCompact, fmtFee, fmtNum, fmtWeekday } from '../format'
import type { OrbitPool } from './model'
import type { OrbitCopy } from './scene'

// "restakes every 12 h", "pays out at 10 NIM", "no payouts listed"
export function schedText(p: OrbitPool): string {
  if (p.mode === 'none' || p.mode === 'unpub') return t(p.schedKey)
  if (p.mode === 'instant') return t(p.kind === 'D' ? 'landing.orbit.paysOutAt' : 'landing.orbit.restakesAt', { n: p.thresholdNim ?? 10 })
  return t(p.kind === 'D' ? 'landing.orbit.paysOut' : 'landing.orbit.restakes', { sched: t(p.schedKey, p.schedVars) })
}

export function makeOrbitCopy(fiat: FiatApi): OrbitCopy {
  return {
    fee: fmtFee,
    sched: p => (p.mode === 'none' || p.mode === 'unpub' || p.mode === 'instant' ? schedText(p) : t(p.schedKey, p.schedVars)),
    schedFull: schedText,
    nim: fmtNum,
    perPayout: v => t('landing.orbit.perPayout', { amount: fmtNum(v, v >= 100 ? 0 : v >= 0.1 ? 2 : v >= 0.01 ? 3 : 4) }),
    weekday: fmtWeekday,
    compact: fmtCompact,
    stakers: (n, stake) => t('landing.orbit.stakers', { n: fmtNum(n), stake }),
    verdictLine: v => (v ? t('landing.orbit.verdict', { verdict: t(`verdict.${v}`) }) : t('landing.orbit.verdictPending')),
    fiat: nim => {
      if (!Number.isFinite(nim) || nim < 0) return ''
      const v = fiat.nimToFiat(BigInt(Math.round(nim * 1e5)))
      return Number.isFinite(v) ? t('landing.orbit.approx', { amount: fiat.format(v) }) : ''
    },
    paidOutSample: amount => t('landing.orbit.paidOutSample', { amount }),
    chipLanded: t('landing.orbit.chipLanded'),
    chipNext: t('landing.orbit.chipNext'),
    chipStream: t('landing.orbit.chipStream'),
    restaked: t('landing.orbit.restaked'),
    paidOut: t('landing.orbit.paidOut'),
    atThreshold: n => t('landing.orbit.atThreshold', { n }),
    everyMinute: t('landing.sched.everyMinute'),
    payouts: t('landing.orbit.chipPayouts'),
    noneListed: t('landing.orbit.noneListed'),
    nothingLeft: t('landing.orbit.nothingLeft'),
    feeKeepsAll: t('landing.orbit.feeKeepsAll'),
    unpublished: t('landing.sched.unpublished'),
    nothingToHold: t('landing.orbit.nothingToHold'),
    notEnoughData: t('landing.orbit.notEnoughData'),
  }
}
