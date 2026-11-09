# Proof

What can be checked outside this repository, and the records to check it against. Every section below is
rendered by `node scripts/render-readme-numbers.mjs` from recorded files; `node scripts/verify-onchain.mjs`
reads the same files and checks them against the chains and the live app, one PASS or FAIL line per check
(PENDING where there is nothing to check yet).

```sh
pnpm install
node scripts/verify-onchain.mjs
```

## Polygon mainnet

<!-- numbers:polygon-proof -->

Router: [`0x7523972ca2309B7e1a71A870D54eCFe96e71280b`](https://polygonscan.com/address/0x7523972ca2309B7e1a71A870D54eCFe96e71280b), source on [Sourcify](https://repo.sourcify.dev/137/0x7523972ca2309B7e1a71A870D54eCFe96e71280b).

- runtime code keccak256 `0x6ef6930f732cc0ceddec9bc1fcd42c20b3d185decdc9083bc6f3133a22bb7ba0`, equal to the recorded `codeHash`: yes
- equal to a local `forge build` of `contracts/src` (immutable slots aside): yes
- `POOL()` and `aTokenOf()` match Aave's registry: yes
- Sourcify: exact_match

| What | Transaction | Block | Date (UTC) | Result |
|---|---|---:|---|---|
| deployment | [`0xb0e01981…4b91e0`](https://polygonscan.com/tx/0xb0e019819a9db1ad0b2733bab4db906d7ca452586d08c158ece116c1294b91e0) | 97,015,445 | 2026-11-09 12:50:24 | created the router |
| deposit | [`0x75059f00…bf72f4`](https://polygonscan.com/tx/0x75059f003c1ad48cfb85e2df4c21137d9f2563985b4c89076655bfca15bf72f4) | 97,015,602 | 2026-11-09 12:54:19 | Supplied for 0x1ed03e…, sent by 0x6967c6… |
| withdraw | [`0x3f9590b3…4c32f6`](https://polygonscan.com/tx/0x3f9590b321813663d1b8dbbb59c393be3ac981c1e6e5bfafa630937cfc4c32f6) | 97,015,612 | 2026-11-09 12:54:34 | Withdrawn for 0x1ed03e…, sent by 0x6967c6… |
| first $1.00 deposit from the app | [`0x05bde28c…0a7270`](https://polygonscan.com/tx/0x05bde28ce9fda79fbbd5f10efc15eb34dcfb43c6b90b04bddc7cdafacc0a7270) | 97,017,136 | 2026-11-09 13:32:40 | Supplied for 0xa125b9…, sent by 0x6967c6… |
| withdrawal from the app | [`0x19290f6d…24c45e`](https://polygonscan.com/tx/0x19290f6de9f5741a263c15a8bd487221af88e7d0cf84f2e46b3e1d6ad324c45e) | 97,017,374 | 2026-11-09 13:38:37 | Withdrawn for 0xa125b9…, sent by 0x6967c6… |

<!-- /numbers:polygon-proof -->

What `verify-onchain.mjs` checks once the router is deployed:

- there is code at the address in `packages/shared/src/deployments.json`, its keccak256 equals the recorded
  `codeHash`, and it equals the runtime code of a local `forge build` of `contracts/src` (immutable slots aside);
- `POOL()` is the Aave v3 pool, and `aTokenOf(USDT0)` and `aTokenOf(USDC)` are the aTokens Aave's own registry
  (`Pool.getReserveData`) lists for those assets;
- the source is verified on Sourcify (a match of `exact_match`, `match`, `perfect` or `partial`, printed as found);
- every transaction recorded in `contracts/deployments/polygon.json` succeeded: the deployment created the router
  in the recorded block, and each deposit or withdrawal emitted the router's `Supplied` or `Withdrawn` event. Each
  line prints the block and its date.

`contracts/deployments/polygon.json` holds `{ "router", "block", "txHash", "codeHash", "txs": { "deposit": "0x…",
"withdraw": "0x…" } }`. Only `txHash` (the deployment) and the values of `txs` are read as transactions;
`codeHash` is compared with the keccak256 of the deployed code, and any other field is ignored. Its `router` and
`block` must match `packages/shared/src/deployments.json`, or the record is reported as inconsistent and nothing
is claimed from it. The format and the checks live in `scripts/lib/deployment.mjs`, shared by both scripts.

The "first $1.00 deposit from the app" is the first deposit made through the app rather than the smoke test: one
signature, then Accrue's relayer sent it and paid the gas. It and the withdrawal after it are the ones in the demo
video ([MOCKS.md](MOCKS.md#demo-video)).

## Nimiq Pay on a real phone

On 2026-11-09 a diagnostic page, opened as a Mini App inside Nimiq Pay on an iPhone (iOS 18.7), checked what
Accrue relies on from the host:

- Nimiq Pay injects its providers into the page (`window.nimiq` and `window.ethereum`);
- `listAccounts` answers (a fresh wallet lists one account);
- switching the wallet to Polygon (`0x89`) works;
- EIP-712 permits signed in Nimiq Pay for USDT0 (its domain with a `salt` and no chain id), USDC and aUSDT0 each
  recover to the wallet's own address, and each signed domain matches the token's on-chain `DOMAIN_SEPARATOR`;
- `localStorage` keeps its contents when the Mini App is closed and opened again.

The diagnostic page was a one-off and is not part of this repository; this list is its result. The domains it
signed are the ones in `packages/shared/src/permit.ts`, which `packages/shared/test/permit.test.ts` holds to the
`DOMAIN_SEPARATOR` each token reports on Polygon.

## Nimiq testnet

While the NIM screens were built, the staking rules they enforce were tried on Nimiq testnet with real
transactions, including ones that were expected to fail. A failing staking transaction is not refused when it is
sent: it is either included and marked failed, or never included at all. That is why the app checks every rule
before Nimiq Pay opens a dialog, and then follows each transaction until the chain says how it went.

<!-- numbers:testnet -->

| Step | Sent | Network's answer | Block | What it shows |
|---|---|---|---:|---|
| [A1](https://test.nimiq.watch/#ecb23f8b07b6eefc14630883509c150b66f369a6fe01d97667fee87fc7236aa3) | New staker delegated to pool V1 with 200 NIM | succeeded | 16,172,341 | Creating a delegated stake works. |
| [A2](https://test.nimiq.watch/#2ecdb88d1490557d385dd7a3d6eb0b76b24a5506daed234a154060a632ad0e57) | Change pool to V2 while 200 NIM is active | included, failed | 16,172,345 | A delegated staker cannot change pool while stake is active: included, but failed. |
| [A3](https://test.nimiq.watch/#a6d2a6d2dedb7d98ca4fc2736366696a8022b2260f40f9d79dbeed992db6707f) | Deactivate all 200 NIM | succeeded | 16,172,349 | Deactivating sets inactiveFrom to the next election block (16208010). |
| [A4](https://test.nimiq.watch/#39b33c04dcdc7f4b93222bd208bcd1f980e5e97fcf2df62cf0944f438cc72a36) | Change pool to V2 while the inactive 200 NIM is still locked | included, failed | 16,172,352 | A pool change also fails while the deactivated stake is still locked. |
| [A5](https://test.nimiq.watch/#49cd73d2417f4b0ea98d975a3d71be2f91929809eafa8bc5ea7f7e6d1da6e3c8) | Retire 200 NIM while still locked | included, failed | 16,172,356 | Retiring is refused before the lock-up ends. |
| [B1](https://test.nimiq.watch/#a04fb35c50002deec0aad228f918cc844f19859ffb71dd00de9f627ebf2367f0) | New staker delegated to pool V1 with 250 NIM | succeeded | 16,172,360 | Creating a delegated stake works. |
| [B2](https://test.nimiq.watch/#582114d8d8c8f901e30a474721110874304cfdf3db3766673641c88009359936) | Deactivate all 250 NIM | succeeded | 16,172,364 | Same inactiveFrom (16208010) as A3: the lock runs from the election block, not from the tap. |
| [B3](https://test.nimiq.watch/#e254a2e454e44dc8d701ac29768cf1fd863b69f5667e1e749a3ec18da61c1348) | Retire 250 NIM while still locked | included, failed | 16,172,367 | Retiring is refused before the lock-up ends. |
| [C0](https://test.nimiq.watch/#b6589edb4ad020c2311be29b199cd142184637c41bb0a07144e73f508a46696f) | New staker with 50 NIM | never included | – | A new stake below the 100 NIM minimum is never included. |
| [C1](https://test.nimiq.watch/#5bed3396535582f1bded0dcbd295b228a638467fc69be0a9c1eefe968e4ee5bf) | New staker with 250 NIM and no pool | succeeded | 16,172,560 | A stake without a pool can be created. |
| [C2](https://test.nimiq.watch/#e9c343942176879d40171d6f9baad1573c5ef1fec38e6b0f9d12473ee2ee18ef) | Deactivate all 250 NIM (no pool) | succeeded | 16,172,564 | Deactivating without a pool sets the same inactiveFrom. |
| [C3](https://test.nimiq.watch/#70a282c066550f00283f01be6d95c8c8341e44cc839ae45e231dc0a4d4a879b6) | Retire 200 of 250 NIM, leaving 50 | included, failed | 16,172,568 | A retire that would leave between 0 and 100 NIM inactive fails. |
| [C4](https://test.nimiq.watch/#cbcd871b5e11f47846673c3fb08338f613ca180521bf41d435297cabd6967201) | Retire 150 of 250 NIM, leaving 100 | succeeded | 16,172,571 | Leaving exactly 100 NIM is allowed; without a pool there is no lock-up. |
| [C5](https://test.nimiq.watch/#0171281696c667b07c4d6676740a9a6e4f15be110f923b1dbd9fb7fadf199ea5) | Remove 100 of the 150 retired NIM | never included | – | A partial remove is never included. |
| [C6](https://test.nimiq.watch/#86ff99b99646ee0d033fa21f405a2b5dad714437e42ed8a0218bc42a73cc12fa) | Remove all 150 retired NIM right after retiring | succeeded | 16,172,763 | Removing the whole retired balance works immediately. |
| [C7](https://test.nimiq.watch/#ae1b559950343ee86c83353a3d9149a2b1027d5b02c7128ed094a8e5f1729a61) | Pick pool V1 for the stake without a pool, reactivating it | succeeded | 16,172,767 | A staker without a pool can pick one at once. |
| [C8](https://test.nimiq.watch/#5e6703e7d7678022a4e92b07d0f7e554382e1374ada5a350b9d779607f6ca21f) | Add 10 NIM to a 100 NIM stake | succeeded | 16,172,808 | Adding less than 100 NIM to an existing stake of at least 100 NIM works. |
| [C9](https://test.nimiq.watch/#6f8f8a1d1f8799be60d0676fb6c6eaaac33147e6d3beef6a1d23a39a6d804084) | Deactivate 55 of 110 NIM | succeeded | 16,172,830 | A partial deactivation works and also stamps inactiveFrom 16208010. |

Stakers A `NQ09 NMEX 1FAS 6BKD JDG1 GC0F XGM3 Q49B VL90`, B `NQ66 C3X6 BV1F 0R6U 8QJT XV0U QHEV EKLJ 0DSN`, C `NQ22 11TS NJ8N BMD0 UVUM E0KL 2RPU NHM1 2RS8`; pools V1 Siam Testnet Pool `NQ35 YFBF ES7X R9PS 36R4 11FG 3HQF YL9Q NL2S`, V2 Kiddie Pool `NQ57 UQJL 5A3H N45M 1FHS 2454 C7L5 BTE6 KEU1`. Every transaction was sent with fee 0 on 2026-11-07.

<!-- /numbers:testnet -->

Recorded in [`evidence/nimiq-testnet-staking.json`](evidence/nimiq-testnet-staking.json);
`verify-onchain.mjs` asks the testnet RPC for each hash and checks the block and the outcome. The release block
after a deactivation (one epoch plus one block after `inactiveFrom`) comes from the protocol source and is
pinned in `app/test/unstake.test.ts`.

## Payout Check scoreboard

<!-- numbers:pools -->

From [`accrue.pages.dev/api/pools`](https://accrue.pages.dev/api/pools), fetched 2026-11-09 17:17 UTC; verdicts computed at 2026-11-09 17:17 UTC; indexed data reaches 2026-11-09 15:45 UTC to 2026-11-09 17:16 UTC depending on the pool, 7-day window. The app shows the same rows, live.

| Pool | Pays | Fee | Verdict | Paid of earnings | Promised |
|---|---|---:|---|---:|---:|
| Garuda Pool | restakes | 5 % | Paid as promised | 94.89 % | 95.00 % |
| ImpactZero stake | restakes | 0 % | Paid as promised | 100.00 % | 100.00 % |
| Keyring Staking | restakes | 5 % | Paid as promised | 100.11 % | 95.00 % |
| Mint Pool | restakes | 5 % | Paid as promised | 94.96 % | 95.00 % |
| Nimiq Base Staking | restakes | 0 % | Paid as promised | 100.00 % | 100.00 % |
| Nimiq.Fun | to wallet | 2.5 % | Paid as promised | 97.28 % | 97.50 % |
| NimiqCafe Staking | restakes | 3 % | Paid as promised | 99.62 % | 97.00 % |
| NimiqHub Staking | restakes | 5 % | Paid as promised | 95.84 % | 95.00 % |
| NimiqPocket | restakes | 1 % | Paid as promised | 99.81 % | 99.00 % |
| ObsidianStake | to wallet | 5 % | Paid as promised | 229.68 % | 95.00 % |
| Ritvars Staking | restakes | 2 % | Paid as promised | 97.92 % | 98.00 % |
| Siam Pool | restakes | 3 % | Paid as promised | 97.18 % | 97.00 % |
| $NIM_pool | restakes | 0 % | Not enough data | 95.31 % | 100.00 % |
| CHIPMUNK POOL | to wallet | 5 % | Not enough data | – | 95.00 % |
| nim.re Staking Pool | restakes | 3.33 % | Not enough data | 87.10 % | 96.67 % |
| NODENIMIQ1.NIMIQ-JU.FR by &#64;Ju | restakes | 1 % | Not enough data | – | 99.00 % |
| NODENIMIQ2.NIMIQ-JU.FR by &#64;Ju | restakes | 1 % | Not enough data | – | 99.00 % |
| Synapse LN - Nimiq | restakes | 1 % | Not enough data | – | 99.00 % |
| Nimiq Surf | no payouts | 0 % | No payouts by design | – | 100.00 % |
| Private Whalidator | no payouts | not listed | No payouts by design | – | – |
| Nimiq Marketing Pool | restakes | 0 % | Can't verify (routed elsewhere) | 50.35 % | 100.00 % |

<!-- /numbers:pools -->

How each verdict is reached: [METHODOLOGY.md](METHODOLOGY.md). Live: the Payouts tab in the app, the
scoreboard on [accrue.pages.dev](https://accrue.pages.dev), and the raw rows at
[`/api/pools`](https://accrue.pages.dev/api/pools).

## Tests

<!-- numbers:tests -->

| Suite | Command | Tests | Result | Detail | Recorded |
|---|---|---:|---|---|---|
| Router (Foundry, Polygon fork) | `cd contracts && forge test` | 26 | 26 passed | 3 suites; 2 fuzz tests at 256 runs; invariant campaign 64 runs × 20 calls | 2026-11-09, forge 1.8.3 |
| Shared logic: permits, payout math | `pnpm --filter @accrue/shared test` | 73 | 73 passed | 4 files | 2026-11-09, vitest 3.2.4 |
| Worker: relayer, indexer, API | `pnpm --filter @accrue/worker test` | 260 | 260 passed | 17 files | 2026-11-09, vitest 3.2.4 |
| App: flows, models, providers | `pnpm --filter @accrue/app test` | 508 | 508 passed | 28 files | 2026-11-09, vitest 3.2.4 |
| App end to end (Playwright) | `pnpm --filter @accrue/app e2e` | 173 | 168 passed, 5 skipped | app-375 46, app-430 46, desktop-1440 27, mobile-375 27, wide-1920 27 | 2026-11-09, playwright 1.64.1 |
| **Total** | | **1,040** | 1,035 passed, 5 skipped | | |

Recorded by `node scripts/collect-results.mjs` into [`results/`](results/). The skipped end-to-end cases are QR-code checks that apply only to a computer or only to a phone viewport.

<!-- /numbers:tests -->

### Router

<!-- numbers:contracts -->

26 tests in 3 suites, 26 passed, on a Polygon fork pinned to block 96,900,000 (forge 1.8.3, recorded 2026-11-09):

- `test/AccrueRouter.fork.t.sol`: 22 tests, 22 passed
- `test/AccrueRouter.invariant.t.sol`: 1 test, 1 passed
- `test/Deploy.t.sol`: 3 tests, 3 passed
- fuzz `testFuzz_supplyAmount`: 256 runs
- fuzz `testFuzz_withdrawAmount`: 256 runs
- invariant campaign (both invariants share it; forge reports it as `invariant_ownersOnlyReceive`): 64 runs, 1,280 handler calls, 0 reverts

`forge coverage` (recorded 2026-11-09):

| File | Lines | Statements | Branches | Functions |
|---|---|---|---|---|
| `src/AccrueRouter.sol` | 100 % (29/29) | 100 % (40/40) | 100 % (13/13) | 100 % (4/4) |
| `script/Deploy.s.sol` | 94.12 % (16/17) | 95.45 % (21/22) | 75 % (6/8) | 100 % (1/1) |

<!-- /numbers:contracts -->
