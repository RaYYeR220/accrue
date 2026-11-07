import type { Address } from 'viem'
import deployments from './deployments.json'

export const POLYGON = {
  chainId: 137,
  hex: '0x89',
  pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' as Address,
  router: deployments.router as Address | null,
  deployBlock: deployments.deployBlock as number | null,
} as const
