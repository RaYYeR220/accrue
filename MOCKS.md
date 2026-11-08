# What is simulated, and what is real

Production (`https://accrue.pages.dev`, opened inside Nimiq Pay) talks only to the real Nimiq Pay host, the real
Nimiq and Polygon chains and Accrue's own API. Simulations exist for development and tests, and this page lists
every one of them.

## In production: nothing is simulated

| Part | Source |
|---|---|
| NIM accounts, balances, staking | The Nimiq Pay host: `window.nimiq` and the Mini App SDK |
| Polygon accounts and signatures | The Nimiq Pay host: `window.ethereum` |
| Pools, verdicts, staker checks | Accrue's indexer, reading the Nimiq chain (`/api/pools`, `/api/check`) |
| Aave rates and positions | The Aave v3 pool on Polygon (`/api/aave`, `/api/position`) |
| Deposits and withdrawals | Accrue's relayer and `AccrueRouter` on Polygon (`/api/relay`) |
| Exchange rates | CoinGecko and open.er-api.com (`/api/rates`) |

Two fallbacks are real data shown with their age, not simulations:

- Until `/api/pools` answers, the landing page shows the published facts of the listed pools (name, fee, payout
  type, schedule) from a dated snapshot of the validators API, `app/src/landing/snapshot.json`, labelled with its
  date. It carries no verdicts; verdicts only ever come from the indexer.
- When exchange rates cannot be read, values are shown in USD and the source line says so.

## The development mock: `?mock=<scenario>`

`app/src/mock/` stands in for Nimiq Pay so every screen and every outcome can be driven from a desktop browser:

- `window.nimiqPay` (language, currency, network), `window.nimiq` (accounts, balances, the six staking
  transactions, read-only RPC) and `window.ethereum` (accounts, chain switching, typed-data signing, transactions);
- Accrue's API (`/api/relay`, `/api/rates`, `/api/health`, `/api/aave`, `/api/position`, `/api/pools`,
  `/api/check`), the testnet validators API and Polygon RPC reads;
- a stand-in router address, `0x00000000000000000000000000000000000acc01`, so the dollar flows can run end to end
  without a deployment. Signatures and transaction hashes it returns are random bytes; nothing reaches a chain.

What a server or chain would remember (relay jobs, balances, the staker) is kept in `sessionStorage`, so a reload
finds it again.

URL options: `?mock=<scenario>[&lang=de][&fiat=EUR][&network=testnet][&chain=0x89][&delay=0][&rates=down]`.

| Scenario | What it sets up |
|---|---|
| `happy` | NIM in the wallet and its HTLC account, a stake with a pool, USDT and USDC on Polygon, an Aave position; everything succeeds |
| `reject-sign` | Every signature and transaction dialog is declined (permits, wallet transactions, NIM staking); connecting accounts still works |
| `insufficient` | Too little NIM and 0.50 USDT; the relay answers `INSUFFICIENT_BALANCE` |
| `relay-down` | The relay is unreachable |
| `stale-nonce` | The relay answers `PERMIT_NONCE_STALE` once |
| `unknown-outcome` | Answers are lost after signing: NIM transactions stay unknown, relay answers do not arrive |
| `htlc-only-balance` | All NIM sits in the HTLC account; the wallet address holds none |
| `aave-illiquid` | Withdrawals answer `AAVE_LIQUIDITY`, with what Aave can pay out now |
| `testnet` | Nimiq Pay on testnet: testnet NIM and the testnet validators list |

### How it is kept out of production

1. `app/src/main.tsx` loads the mock only inside `if (import.meta.env.DEV && location.search.includes('mock='))`,
   with a dynamic `import()`. A production build replaces `import.meta.env.DEV` with `false` and drops the branch
   and the module.
2. `pnpm --filter @accrue/app build` ends with `app/scripts/check-dist.mjs`, which fails the build if any of
   `installMock`, `__accrueMock`, `reject-sign`, `htlc-only-balance` or `MOCK_RATES` appears anywhere in `dist/`.
3. The end-to-end tests use a separate development bundle, `pnpm --filter @accrue/app build:mock`, written to
   `dist-mock/`. The Pages project serves `dist/` (`app/wrangler.toml`).

## In tests

| Suite | Real | Simulated |
|---|---|---|
| Contracts (`contracts/test/`) | Polygon mainnet state through a fork pinned to a block: the Aave v3 pool, aTokens, USDT0 and USDC contracts | Test keys; balances given by impersonating the aToken contracts; Aave's withdraw revert (`vm.mockCallRevert`) in the illiquid-reserve test; the registry answer (`vm.mockCall`) in the deploy-script mismatch test |
| Relayer fork run (`worker/scripts/e2e-fork.mjs`) | The router and Aave on an `anvil` fork of Polygon; the Worker under `wrangler dev` | Fresh relayer and owner keys; the owner funded by impersonation; a local D1 |
| Shared logic (`packages/shared/test/`) | Two pools' mainnet transactions recorded on 2026-11-07 (`test/fixtures/`) | The same histories with payouts scaled down, as negative controls |
| Worker (`worker/test/`) | Recorded mainnet histories, replayed as a chain | A `node:sqlite` stand-in for D1, fake RPC nodes, synthetic payout histories for the sweeps |
| App unit tests (`app/test/`) | The app's own modules | Fake providers and API answers (`app/test/fakes.ts`) |
| Landing end to end (`app/e2e/landing.spec.ts`, `a11y.spec.ts`) | The production build | `/api/*` answered per test with Playwright's `page.route` |
| In-app end to end (`app/e2e/*.spec.ts`) | The mock build of the app | The host, wallets and API, through `?mock=<scenario>` |

The in-app end-to-end tests therefore show the app's behaviour against a faithful but simulated host. The host's
real behaviour (dialogs, signatures, staking transactions) is what Nimiq Pay itself does on a phone.
