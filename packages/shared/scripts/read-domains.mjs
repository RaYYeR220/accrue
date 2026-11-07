import { createPublicClient, http, parseAbi } from 'viem'
import { polygon } from 'viem/chains'
const c = createPublicClient({ chain: polygon, transport: http('https://polygon-bor-rpc.publicnode.com') })
const abi = parseAbi(['function DOMAIN_SEPARATOR() view returns (bytes32)'])
for (const [n, a] of Object.entries({
  USDT0: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  aUSDT0: '0x6ab707Aca953eDAeFBc4fD23bA73294241490620',
  aUSDC: '0xA4D94019934D8333Ef880ABFFbF2FDd611C762BD',
})) console.log(n, await c.readContract({ address: a, abi, functionName: 'DOMAIN_SEPARATOR' }))
