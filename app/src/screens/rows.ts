import { t } from '../i18n'
import type { ActivityRow } from '../model/activity'
import { nimAmount, SYMBOL, tokens } from './format'

export function rowTitle(r: ActivityRow): string {
  if (r.chain === 'polygon') {
    const amount = r.amount === null ? t('sheet.everything', { token: SYMBOL[r.asset!] }) : tokens(r.amount, r.asset)
    return t(r.kind === 'deposit' ? 'act.deposit' : 'act.withdraw', { amount })
  }
  return r.amount === null || r.amount === 0n ? t(`act.nim.${r.kind}`, { amount: '' }).trim() : t(`act.nim.${r.kind}`, { amount: nimAmount(r.amount) })
}

export function rowStatus(r: ActivityRow): string {
  switch (r.status) {
    case 'confirmed':
      return r.elsewhere ? t('act.st.landed') : t('act.st.confirmed')
    case 'pending':
      return t('act.st.pending')
    case 'checking':
      return t('act.st.checking')
    case 'failed':
      return t('act.st.failed')
  }
}
