# Claims and evidence

Every public claim Accrue makes, how strong the evidence is, where to see it and how to check it yourself.

| Tier | Meaning |
|---|---|
| **REPRODUCIBLE** | A command in this repository re-derives it from committed code or recorded data. |
| **VERIFIED-LIVE** | Checked against the live chain or the live app right now, by `node scripts/verify-onchain.mjs` or a public page. |
| **MODELED** | Follows from a model, a protocol rule or a one-off measurement recorded here with its method; no script in this repository re-runs it. |
| **NOT-CLAIMED** | Not claimed. Listed so nobody reads it in. |

Test totals: <!-- numbers:tests-total -->947 automated tests pass (5 skipped by design)<!-- /numbers:tests-total -->. Per-suite counts are in
[README.md](README.md#tests); the raw summaries are in [`results/`](results/).

## On chain, Polygon

These rows switch tier by themselves once the router is deployed and its transactions are recorded
(`node scripts/render-readme-numbers.mjs` reads `packages/shared/src/deployments.json` and
`contracts/deployments/polygon.json`).

<!-- numbers:claims-polygon -->

| Claim | Tier | Proof | Reproduce |
|---|---|---|---|
| AccrueRouter is live on Polygon mainnet, with its source verified. | NOT-CLAIMED | deployment pending | `node scripts/verify-onchain.mjs` |
| The deployed code is the code in `contracts/src`. | NOT-CLAIMED | deployment pending | `forge build` in `contracts/`, then `node scripts/verify-onchain.mjs` |
| The deployed router is wired to the aTokens in Aave's own registry. | NOT-CLAIMED | deployment pending | `node scripts/verify-onchain.mjs` |
| A real deposit and a real withdrawal went through the router on mainnet, each sent and paid for by an address other than the owner. | NOT-CLAIMED | deployment pending | `node scripts/verify-onchain.mjs` |

<!-- /numbers:claims-polygon -->

## Dollars

| Claim | Tier | Proof | Reproduce |
|---|---|---|---|
| A deposit takes one signature and no POL: the relayer pays the gas. | REPRODUCIBLE | Fork run: an owner holding 0 POL supplies $5 through the relayer, and still holds 0 POL afterwards | `pnpm --filter @accrue/worker e2e` (needs Foundry's `anvil`) |
| The router can only supply an owner's tokens to Aave in the owner's name, or redeem the owner's aTokens to the owner. | REPRODUCIBLE | Invariant `invariant_ownersOnlyReceive` and the fork tests, P1 to P5 in [SECURITY.md](SECURITY.md#properties-and-the-tests-that-hold-them) | `cd contracts && forge test` |
| The router has no owner, no admin, no upgrade path and no fee. | REPRODUCIBLE | [`contracts/src/AccrueRouter.sol`](contracts/src/AccrueRouter.sol): no owner variable, no privileged function, no proxy or upgrade hook, no fee | read the source |
| A signature someone else submits first cannot block a deposit or withdrawal. | REPRODUCIBLE | `test_supply_frontRunPermit_stillSucceeds`, `test_withdraw_frontRunPermit_stillSucceeds` | `cd contracts && forge test` |
| The same signature is never sent twice; a retried request returns the same job. | REPRODUCIBLE | `worker/test/relayer.test.ts` "is idempotent: the same signature twice is one tx"; the fork run re-posts a signature and the relayer sends nothing new | `pnpm --filter @accrue/worker test` |
| Before spending gas the relayer checks the asset, the $1 minimum and $10,000 cap, the deadline window, the signer, the owner's balance and nonce, 10 relays per owner per day, and simulates the call. | REPRODUCIBLE | `worker/test/validate.test.ts`, `worker/test/chain.test.ts`, `worker/test/api.test.ts` | `pnpm --filter @accrue/worker test` |
| A stuck transaction gets a higher tip, and is replaced by a cancel before the permit expires. | REPRODUCIBLE | `worker/test/relayer.test.ts` (`Relayer.alarm`) | `pnpm --filter @accrue/worker test` |
| When the relayer cannot send, a wallet holding POL can send the same signed permit itself. | REPRODUCIBLE | `app/test/deposit.test.ts`; `app/e2e/dollars.spec.ts` "paying the fee yourself" | `pnpm --filter @accrue/app test`, `pnpm --filter @accrue/app e2e` |
| An Aave reserve without enough liquidity is explained before signing, with the amount that can leave now. | REPRODUCIBLE | `app/e2e/dollars.spec.ts` "aave illiquid" | `pnpm --filter @accrue/app e2e` |
| aTokens land in the owner's own wallet, so a withdrawal never depends on Accrue. | REPRODUCIBLE | `test_supplyUsdt0_permit_mintsATokenToOwner`; subject to Aave's own pause, freeze and liquidity ([SECURITY.md](SECURITY.md#trust-assumptions)) | `cd contracts && forge test` |
| The APY on screen is read from the Aave pool on Polygon. | VERIFIED-LIVE | `GET /api/aave` on [accrue.pages.dev](https://accrue.pages.dev/api/aave): `getReserveData` per asset | open the URL |

## NIM

| Claim | Tier | Proof | Reproduce |
|---|---|---|---|
| Staking uses all six staking transaction types of the Nimiq Pay provider. | REPRODUCIBLE | [`app/src/providers/nimiq.ts`](app/src/providers/nimiq.ts) | read the source |
| The network's staking rules are checked before a dialog opens: 100 NIM minimum, no 0 to 100 NIM remainder, pool change only once stake is inactive and released, whole-balance removal, one funding account per transaction. | REPRODUCIBLE | `app/test/staking.test.ts`, `app/test/unstake.test.ts`, `app/e2e/nim.spec.ts` | `pnpm --filter @accrue/app test` |
| Those rules are what the network enforces. | VERIFIED-LIVE | Testnet transactions and how the network answered each, [PROOF.md](PROOF.md#nimiq-testnet) | `node scripts/verify-onchain.mjs` |
| Unstaked NIM is released one epoch plus one block after the election block that starts the wait (12 to 24 hours from the tap). | MODELED | Protocol source (`is_inactive_stake_released` in core-rs-albatross); testnet shows the wait starting at the election block and retiring refused before it | `app/test/unstake.test.ts` pins the arithmetic |
| Every staking transaction is followed on chain until it is confirmed or failed; after 30 minutes without a sign of it the app says the outcome is unknown and points to the wallet history. | REPRODUCIBLE | `waitForNimTx` in `app/src/features/nim/api.ts`, `app/test/staking.test.ts` | `pnpm --filter @accrue/app test` |

## Payout Check

| Claim | Tier | Proof | Reproduce |
|---|---|---|---|
| Every listed pool gets a verdict from its own transactions on the Nimiq chain. | VERIFIED-LIVE | <!-- numbers:pools-summary -->21 listed pools as of 2026-11-08 05:10 UTC: 1 paid as promised, 2 no payouts by design, 18 without a verdict yet<!-- /numbers:pools-summary -->; [table in PROOF.md](PROOF.md#payout-check-scoreboard) | `node scripts/verify-onchain.mjs`; [accrue.pages.dev/api/pools](https://accrue.pages.dev/api/pools) |
| A pool is never called short with fewer than 3 cycles or with 5 % or more other outflow, and only if every confirmation window agrees. | REPRODUCIBLE | `packages/shared/test/payout.test.ts` ("poolVerdict rules") | `pnpm --filter @accrue/shared test` |
| A pool paying 80 % of its promise is flagged short (negative control). | REPRODUCIBLE | `payout.test.ts` "negative control"; `worker/test/cutsweep.test.ts` | `pnpm --filter @accrue/shared test`, `pnpm --filter @accrue/worker test` |
| Where the data stops never makes an honest pool read short. | REPRODUCIBLE | `worker/test/cutsweep.test.ts`: honest payers cut at every macro block, 0 short | `pnpm --filter @accrue/worker test` |
| The same holds on live data: 16 paying pools, 1,441 cut points each, 0 short. | MODELED | One-off run on 2026-11-07, [METHODOLOGY.md](METHODOLOGY.md#validation) | |
| Payout Check agrees with ImpactZero's independent payout verifier. | MODELED | One-off comparison on 2026-11-07: ratio 1.000002; 8,483 of 8,485 cycles verified by that tool, [METHODOLOGY.md](METHODOLOGY.md#validation) | subimpact's API, linked there |
| A staker's own check compares expected and received over the window the API names. | REPRODUCIBLE | `worker/test/pools-api.test.ts`; `app/e2e/payout.spec.ts` | `pnpm --filter @accrue/worker test` |

## App behaviour

| Claim | Tier | Proof | Reproduce |
|---|---|---|---|
| Nothing asks the wallet, and no dialog opens, before the first tap; one tap never opens two dialogs. | REPRODUCIBLE | `app/e2e/app-global.spec.ts`, in every mock scenario | `pnpm --filter @accrue/app e2e` |
| Cancelling in Nimiq Pay sends nothing and says so. | REPRODUCIBLE | `app/e2e/dollars.spec.ts` "reject-sign: Cancelled — nothing was sent"; `app/e2e/nim.spec.ts` "a declined stop does not leave a switch behind" ("You cancelled in your wallet. Nothing was sent.") | `pnpm --filter @accrue/app e2e` |
| An answer lost after signing shows "Checking…", survives a reload and resumes the same job, never a second signature. | REPRODUCIBLE | `app/e2e/dollars.spec.ts` "unknown outcome"; `app/test/jobs.test.ts`, `app/test/machine.test.ts` | `pnpm --filter @accrue/app e2e` |
| No horizontal scroll at 375 and 430 px, every control at least 44 × 44 px, no serious or critical axe finding. | REPRODUCIBLE | `app/e2e/app-global.spec.ts`, `app/e2e/a11y.spec.ts` | `pnpm --filter @accrue/app e2e` |
| English, German, Spanish, French and Portuguese, complete and translated. | REPRODUCIBLE | `app/test/app-i18n.test.ts`, `app/test/i18n.test.ts`, `app/test/landing-i18n.test.ts` | `pnpm --filter @accrue/app test` |
| Values are shown in the currency Nimiq Pay is set to (USD, EUR, CRC, GMD), falling back to USD when no rate is available. | REPRODUCIBLE | `app/test/fiat.test.ts` | `pnpm --filter @accrue/app test` |
| The production build contains none of the development mock. | REPRODUCIBLE | `app/scripts/check-dist.mjs` fails the build if it does ([MOCKS.md](MOCKS.md)) | `pnpm --filter @accrue/app build` |

## Not claimed

- **An external audit of the router.** The review in [SECURITY.md](SECURITY.md) is in-house.
- **A rate.** Aave's supply rate varies block by block; Accrue shows today's and promises none.
- **Unlimited free gas.** Sponsorship has a per-deposit cap, a per-address daily count and a daily budget.
- **That a pool is honest or dishonest.** Payout Check is a reading of public data with stated thresholds; it
  cannot see off-chain agreements and says "not enough data" when unsure.
- **A "short" verdict for one staker of a pool that is not short.** See [METHODOLOGY.md](METHODOLOGY.md#5-your-own-check).
- **Pools outside the public validators list.** They get no verdict.
- **Converting NIM rewards into dollars.** Not built.
- **Chains other than Polygon, or tokens other than USDT0 and native USDC.** Bridged USDC.e is not supported.
- **Usage numbers.** None are published here.
- **Behaviour on every phone and every Nimiq Pay version.** The in-app end-to-end tests run in a desktop browser
  at phone sizes against a simulated host ([MOCKS.md](MOCKS.md)), built against `@nimiq/mini-app-sdk` 0.2.5.
