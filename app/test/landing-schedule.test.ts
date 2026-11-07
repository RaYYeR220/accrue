import { describe, expect, it } from 'vitest'
import { scheduleInfo } from '../src/landing/schedule'

describe('scheduleInfo', () => {
  it('reads the "Every …" labels pools publish', () => {
    expect(scheduleInfo('Every minute', 'restake')).toEqual({ mode: 'interval', hours: 1 / 60, label: { key: 'landing.sched.everyMinute' } })
    expect(scheduleInfo('Every 1 minute', 'restake').hours).toBe(1 / 60)
    expect(scheduleInfo('Every 4 hours', 'restake')).toEqual({ mode: 'interval', hours: 4, label: { key: 'landing.sched.everyHours', vars: { n: 4 } } })
    expect(scheduleInfo('Every 12 hours', 'direct').hours).toBe(12)
    expect(scheduleInfo('Every day', 'restake')).toEqual({ mode: 'interval', hours: 24, label: { key: 'landing.sched.daily' } })
    expect(scheduleInfo('Every 2 days', 'restake')).toEqual({ mode: 'interval', hours: 48, label: { key: 'landing.sched.everyDays', vars: { n: 2 } } })
  })

  it('reads cron expressions', () => {
    expect(scheduleInfo('0 * * * *', 'restake')).toEqual({ mode: 'interval', hours: 1, label: { key: 'landing.sched.hourly' } })
    expect(scheduleInfo('0 */6 * * *', 'direct')).toEqual({ mode: 'interval', hours: 6, label: { key: 'landing.sched.everyHours', vars: { n: 6 } } })
    expect(scheduleInfo('0 0 * * *', 'restake').hours).toBe(24)
    expect(scheduleInfo('*/30 * * * *', 'restake')).toEqual({ mode: 'interval', hours: 0.5, label: { key: 'landing.sched.everyMinutes', vars: { n: 30 } } })
    expect(scheduleInfo('* * * * *', 'restake').hours).toBe(1 / 60)
  })

  it('recognises instant payouts and their threshold', () => {
    expect(scheduleInfo('Payouts over 10 NIM are instant when NimiqPocket is elected .', 'restake')).toEqual({
      mode: 'instant',
      hours: null,
      thresholdNim: 10,
      label: { key: 'landing.sched.instantOver', vars: { n: 10 } },
    })
    expect(scheduleInfo('Instant', 'restake')).toEqual({ mode: 'instant', hours: null, thresholdNim: null, label: { key: 'landing.sched.instant' } })
  })

  it('pools that pay nothing are "none" whatever the schedule says', () => {
    expect(scheduleInfo('', 'none')).toEqual({ mode: 'none', hours: null, label: { key: 'landing.sched.none' } })
    expect(scheduleInfo('Every 12 hours', 'none').mode).toBe('none')
  })

  it('an empty or unreadable schedule is unpublished, never guessed', () => {
    expect(scheduleInfo('', 'restake')).toEqual({ mode: 'unpublished', hours: null, label: { key: 'landing.sched.unpublished' } })
    expect(scheduleInfo('whenever we feel like it', 'restake').mode).toBe('unpublished')
    expect(scheduleInfo('0 9 * * 1', 'restake').mode).toBe('unpublished')
    expect(scheduleInfo('Every 0 hours', 'restake').mode).toBe('unpublished')
  })
})
