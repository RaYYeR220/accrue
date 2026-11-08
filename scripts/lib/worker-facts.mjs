// Facts the docs state about the worker, read from the worker's own config and code so that a doc
// which falls behind them fails `node scripts/render-readme-numbers.mjs --check`.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function workerFacts(root) {
  const toml = readFileSync(join(root, 'worker/wrangler.toml'), 'utf8')
  const rates = readFileSync(join(root, 'worker/src/api/rates.ts'), 'utf8')
  const cron = toml.match(/^crons\s*=\s*\["([^"]+)"\]/m)?.[1]
  const oneJob = toml.match(/^CRON_ONE_JOB_PER_RUN\s*=\s*"([^"]+)"/m)?.[1]
  const block = rates.match(/const PRICE_SOURCES[^\n]*= \[\r?\n([\s\S]*?)\r?\n\]/)?.[1]
  const prices = block ? [...block.matchAll(/\['([^']+)'/g)].map((m) => m[1].replace('+', ' + ')) : []
  const fx = rates.match(/FX_URL = 'https:\/\/([^/]+)/)?.[1]
  if (!cron || !prices.length || !fx) throw new Error('workerFacts: cannot read the cron schedule or the price sources from the worker')
  const step = cron.match(/^\*\/(\d+) \* \* \* \*$/)?.[1]
  const every = cron === '* * * * *' ? 'every minute' : step ? `every ${step} minutes` : `on \`${cron}\``
  const everyShort = cron === '* * * * *' ? 'every minute' : step ? `every ${step} min` : cron
  return { cron, every, everyShort, oneJob: oneJob !== 'false', prices, fx }
}
