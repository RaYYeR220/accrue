import { parsePools, type PoolsData } from './data'
import raw from './snapshot.json'

// The published facts of the 21 listed pools (validators API), shown until our own API answers.
// It carries no verdicts: those only ever come from the indexer.
export const SNAPSHOT: PoolsData = {
  ...parsePools({ asOf: Date.parse(`${raw.fetched}T00:00:00Z`), windowDays: 7, pools: raw.pools }),
  source: 'snapshot',
}
