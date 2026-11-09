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
| Exchange rates | NIM price from CoinGecko, then CoinPaprika, then Gate.io + Kraken (their mid price), in that order; a source that refuses is skipped for 15 minutes, and the last good copy is kept for 24 hours. Currency rates from open.er-api.com (`/api/rates`) |

Three fallbacks are real data shown with their age or their gaps, not simulations:

- Until `/api/pools` answers, the landing page shows the published facts of the listed pools (name, fee, payout
  type, schedule) from a dated snapshot of the validators API, `app/src/landing/snapshot.json`, labelled with its
  date. It carries no verdicts; verdicts only ever come from the indexer.
- When exchange rates cannot be read, values are shown in USD and the source line says so.
- When no Polygon RPC serves the router's logs, the Dollars screen shows the live Aave balance and a dash for
  "Put in through Accrue" and "Earned so far", with a note saying so; Withdraw keeps working.

## Demo video

The demo video was recorded in a desktop browser at phone size, with a test wallet standing in for Nimiq Pay. Its
keys were held outside the page, and its signatures were made by a local key instead of Nimiq Pay's dialogs. The
video says so on screen: "In a browser at phone size, with a test wallet standing in for Nimiq Pay. Every
transaction shown is real: Polygon mainnet, Nimiq testnet for staking."

- Every Polygon transaction in it is real, on mainnet, from the demo wallet
  `0xA125b94355a53DBc62530bBfcf3040a18CeE3624`: the $1.00 deposit
  [`0x05bde28c…0a7270`](https://polygonscan.com/tx/0x05bde28ce9fda79fbbd5f10efc15eb34dcfb43c6b90b04bddc7cdafacc0a7270)
  (block 97,017,136) and the withdrawal of all of it
  [`0x19290f6d…24c45e`](https://polygonscan.com/tx/0x19290f6de9f5741a263c15a8bd487221af88e7d0cf84f2e46b3e1d6ad324c45e)
  (block 97,017,374), both sent and paid for by Accrue's relayer. They are recorded with the others in
  [PROOF.md](PROOF.md#polygon-mainnet), and `verify-onchain.mjs` reads them back.
- The NIM staking scenes run on Nimiq testnet, with the app's Testnet badge on screen, and their transactions are
  real testnet ones: the 100 NIM stake
  [`80f92aed…09c764`](https://test.nimiq.watch/#80f92aeddc14334a4b97b5dad45b56129b9f927c07b7ff347e1077abc809c764)
  (block 16,314,747) and stopping it
  [`8a128481…7231ec`](https://test.nimiq.watch/#8a128481797198588cf8e3f2518a8b52e4cd4b81f5941b9902a7963b567231ec)
  (block 16,314,845), both succeeded.
- Payout Check shows mainnet data, live from `/api/pools` and `/api/check`.

What Nimiq Pay itself does with Accrue on a phone was checked on a real device:
[PROOF.md](PROOF.md#nimiq-pay-on-a-real-phone).

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

URL options: `?mock=<scenario>[&lang=de][&fiat=EUR][&network=testnet][&chain=0x89][&delay=0][&rates=down][&position=partial]`
(`position=partial`: `/api/position` answers as it does when the router's logs cannot be read).

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
