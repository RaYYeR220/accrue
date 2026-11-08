import { parseSchedule, type Staker } from '@accrue/shared'
import { t } from '../i18n'
import type { PoolRow } from '../features/nim/api'
import type { UnstakeStep } from '../features/nim/unstake'
import type { StepItem } from '../ui/components/Fields'
import { about, ago, every, nimAmount, pct } from './format'
import { PoolVerdict } from './parts'

// 3 %, 9.5 %: one decimal only when the fee has one
export const feePct = (fee: number) => pct(fee, Math.round(fee * 1000) % 10 === 0 ? 0 : 1)

export function payoutLine(p: PoolRow): string {
  if (p.payoutType === 'none') return t('pool.noPayouts')
  const ms = p.schedule ? parseSchedule(p.schedule) : null
  const sched = ms !== null ? every(ms) : p.schedule ? p.schedule : t('pool.noSchedule')
  return t(p.payoutType === 'restake' ? 'pool.restakes' : 'pool.direct', { schedule: sched })
}

// One pool's record, as facts: verdict (or none yet), fee, how and when it pays, what it paid.
export function PoolFacts({ p }: { p: PoolRow }) {
  return (
    <span className="pool-facts">
      <PoolVerdict verdict={p.verdict} />
      <span className="pool-line">
        {t('pool.fee', { pct: feePct(p.fee) })} · {payoutLine(p)}
      </span>
      {p.ratio !== null && <span className="pool-line">{t('pool.ratio', { ratio: pct(p.ratio, 1), expected: pct(p.expectedRatio, 1) })}</span>}
      {p.lastPayoutTs !== null && <span className="pool-line">{t('pool.last', { when: ago(p.lastPayoutTs) })}</span>}
    </span>
  )
}

export function PoolPicker({ pools, value, onChange, exclude, name }: { pools: PoolRow[]; value: string | null; onChange: (a: string) => void; exclude?: string | null; name: string }) {
  return (
    <fieldset className="picker">
      <legend className="field-label">{t('pool.pick')}</legend>
      <p className="picker-note">{t('pool.order')}</p>
      {pools
        .filter(p => p.address !== exclude)
        .map(p => (
          <label key={p.address} className={value === p.address ? 'pick is-on' : 'pick'}>
            <input type="radio" name={name} value={p.address} checked={value === p.address} onChange={() => onChange(p.address)} />
            <span className="pick-body">
              <span className="pick-name">{p.name}</span>
              <PoolFacts p={p} />
            </span>
          </label>
        ))}
    </fieldset>
  )
}

// The four unstake steps as the person sees them: done, the next tap, waiting on the network, later.
export function unstakeItems(steps: UnstakeStep[], amountLuna: bigint): StepItem[] {
  const [deactivate, wait, retire, remove] = steps
  const eta = wait && !wait.done ? about(wait.etaMs ?? 0) : null
  return [
    { title: t('nim.step.deactivate'), sub: t('stake.step.deactivateSub', { amount: nimAmount(amountLuna) }), state: deactivate!.done ? 'done' : 'now' },
    {
      title: t('nim.step.wait'),
      sub: wait!.done ? t('nim.step.readyNow') : deactivate!.done ? t('stake.readyIn', { time: eta! }) : t('stake.step.waitAfter', { time: eta ?? '' }),
      state: wait!.done ? 'done' : deactivate!.done ? 'wait' : 'later',
    },
    { title: t('nim.step.retire'), sub: t('stake.step.retireSub'), state: retire!.done ? 'done' : wait!.done ? 'now' : 'later' },
    { title: t('nim.step.remove'), sub: t('stake.step.removeSub'), state: retire!.done ? 'now' : 'later' },
  ]
}

export const stakedTotal = (s: Staker) => s.activeLuna + s.inactiveLuna + s.retiredLuna
