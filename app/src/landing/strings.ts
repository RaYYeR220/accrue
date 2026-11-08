import { extendDicts, type Dict, type Lang } from '../i18n'
import en from './i18n/en.json'

// English ships with the landing chunk; another language is one small extra request.
const more: Record<Exclude<Lang, 'en'>, () => Promise<{ default: Dict }>> = {
  de: () => import('./i18n/de.json'),
  es: () => import('./i18n/es.json'),
  fr: () => import('./i18n/fr.json'),
  pt: () => import('./i18n/pt.json'),
}

let loading: Promise<void> | null = null

export function loadLandingStrings(lang: Lang): Promise<void> {
  if (!loading) {
    extendDicts({ en })
    loading =
      lang === 'en'
        ? Promise.resolve()
        : more[lang]()
            .then(m => extendDicts({ [lang]: m.default }))
            // English is already in place, so a failed fetch still renders a whole page
            .catch(() => undefined)
  }
  return loading
}
