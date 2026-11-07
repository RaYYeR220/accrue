import { parseSchedule } from '@accrue/shared'

export type PayoutType = 'restake' | 'direct' | 'none'

export interface Label {
  key: string
  vars?: Record<string, number>
}

export type ScheduleInfo =
  | { mode: 'none' | 'unpublished'; hours: null; label: Label }
  | { mode: 'instant'; hours: null; thresholdNim: number | null; label: Label }
  | { mode: 'interval'; hours: number; label: Label }

const HOUR_MS = 3_600_000

// Five-field cron, only the shapes that describe a fixed interval: every n minutes,
// every n hours at a fixed minute, or once a day.
function cronHours(s: string): number | null {
  const f = s.trim().split(/\s+/)
  if (f.length !== 5 || f.slice(2).some(x => x !== '*')) return null
  const [min, hour] = f as [string, string]
  const step = (x: string) => {
    const m = /^\*\/(\d+)$/.exec(x)
    return m ? Number(m[1]) : null
  }
  const fixed = (x: string) => /^\d+$/.test(x)
  if (min === '*' && hour === '*') return 1 / 60
  const everyMin = step(min)
  if (everyMin && hour === '*') return everyMin / 60
  if (!fixed(min)) return null
  if (hour === '*') return 1
  const everyHour = step(hour)
  if (everyHour) return everyHour
  return fixed(hour) ? 24 : null
}

function intervalLabel(hours: number): Label {
  const minutes = Math.round(hours * 60)
  if (minutes === 1) return { key: 'landing.sched.everyMinute' }
  if (minutes < 60) return { key: 'landing.sched.everyMinutes', vars: { n: minutes } }
  if (minutes === 60) return { key: 'landing.sched.hourly' }
  if (hours < 24) return { key: 'landing.sched.everyHours', vars: { n: Math.round(hours * 10) / 10 } }
  if (hours === 24) return { key: 'landing.sched.daily' }
  return { key: 'landing.sched.everyDays', vars: { n: Math.round((hours / 24) * 10) / 10 } }
}

// The payout schedule as the pool publishes it. Anything we can't read is "unpublished";
// we never guess an interval the pool didn't state.
export function scheduleInfo(schedule: string, payoutType: PayoutType): ScheduleInfo {
  if (payoutType === 'none') return { mode: 'none', hours: null, label: { key: 'landing.sched.none' } }
  if (/instant/i.test(schedule)) {
    const m = /over\s+(\d+(?:\.\d+)?)\s*NIM/i.exec(schedule)
    const thresholdNim = m ? Number(m[1]) : null
    return {
      mode: 'instant',
      hours: null,
      thresholdNim,
      label: thresholdNim === null ? { key: 'landing.sched.instant' } : { key: 'landing.sched.instantOver', vars: { n: thresholdNim } },
    }
  }
  const ms = parseSchedule(schedule)
  const hours = ms !== null ? ms / HOUR_MS : cronHours(schedule)
  if (hours === null || !(hours > 0)) return { mode: 'unpublished', hours: null, label: { key: 'landing.sched.unpublished' } }
  return { mode: 'interval', hours, label: intervalLabel(hours) }
}
