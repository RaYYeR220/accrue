import { t } from '../i18n'
import type { ActivityRow } from '../model/activity'
import { exactTokens, nimExact, SYMBOL } from './format'

// Amounts here were signed or sent, so every unit is shown.
export function rowTitle(r: ActivityRow): string {
  if (r.chain === 'polygon') {
    const amount = r.amount === null ? t('sheet.everything', { token: SYMBOL[r.asset!] }) : exactTokens(r.amount, r.asset)
    return t(r.kind === 'deposit' ? 'act.deposit' : 'act.withdraw', { amount })
  }
  return r.amount === null || r.amount === 0n ? t(`act.nim.${r.kind}`, { amount: '' }).trim() : t(`act.nim.${r.kind}`, { amount: nimExact(r.amount) })
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
    case 'unknown':
      return t('act.st.unknown')
  }
}
