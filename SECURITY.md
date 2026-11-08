# Security

`AccrueRouter` has not had an external audit. This document records the in-house review of the contract, what
was fixed, and the risks accepted on purpose.

**Deployment:** <!-- numbers:router-status -->Not deployed yet: `packages/shared/src/deployments.json` holds `"router": null`, and until it names the router the app says plainly that dollar deposits are not open yet.<!-- /numbers:router-status -->

## Reporting a vulnerability

Please report privately with GitHub's **Report a vulnerability** button on this repository (Security tab), not in
a public issue.

## Scope

| In scope | Out of scope |
|---|---|
| `contracts/src/AccrueRouter.sol`, `contracts/src/interfaces/*` | The relayer Worker and the Mini App. They hold no user funds; see "Relayer requirements" for what the contract relies on them for. |
| `contracts/script/Deploy.s.sol` and `contracts/script/Polygon.sol` (deployment wiring and the address set it uses) | Aave v3, USDT0, USDC and their governance |

## What the router does

An owner signs an EIP-2612 permit. Anyone, in practice Accrue's relayer paying the gas, submits it:

- `supplyWithPermit(asset, owner, amount, …)` pulls `amount` of USDT0 or USDC from `owner` and supplies it to the
  Aave v3 pool **on behalf of `owner`**, so the aTokens are minted straight to the owner's wallet.
- `withdrawWithPermit(asset, owner, amount, permitValue, …)` pulls `min(amount, aToken balance, allowance)` of the
  owner's aTokens and redeems them from Aave **straight to `owner`**.

The contract is immutable, has no owner or admin and takes no fees. Its own flows leave no token balance and no
pool approval behind; tokens sent to it directly are another matter (AR-04). The asset/aToken allowlist is fixed
in the constructor.

## Properties and the tests that hold them

All contract tests run on a Polygon fork pinned to a block, against the real Aave v3.5 pool, aTokens, USDT0 and
USDC (`contracts/test/`).

| # | Property | Evidence |
|---|---|---|
| P1 | Tokens only move owner → Aave (aTokens to owner) or owner's aTokens → Aave → owner. The caller cannot name a recipient. | `invariant_ownersOnlyReceive`; every success test asserts that router, relayer and front-runner hold nothing |
| P2 | After any call through its own functions, the router holds no token balance and no pool approval from that call. | `invariant_routerHoldsNothing`; `_assertNothingStrays()` in every success test |
| P3 | A permit that someone else submits first cannot block the relay. | `test_supply_frontRunPermit_stillSucceeds`, `test_withdraw_frontRunPermit_stillSucceeds`, invariant actions `frontRunSupply` / `frontRunWithdraw` |
| P4 | A signature only ever moves its signer's own funds. | `test_supply_wrongSigner_reverts`, invariant actions `crossSignedSupply` / `crossSignedWithdraw` |
| P5 | A withdraw never pulls more than the signed allowance, the balance or `amount`, and the owner receives at least what was pulled. | `test_withdrawAll_cappedBySignedValue`, `testFuzz_withdrawAmount` |
| P6 | The deployed router's allowlist (deployed with `Deploy.s.sol`) contains only the aTokens the configured pool's own registry lists for each asset. The constructor alone rejects a swapped, foreign-pool or non-contract aToken; the registry check in the deploy script is what rules out a look-alike. | `test_constructor_*`, `test_deployScript_*`; on the live deployment, `scripts/verify-onchain.mjs` re-reads the registry |

The invariant handler acts for three owners across both assets: relayed supplies and withdrawals (partial, signed
higher than pulled, and withdraw-all with a growth buffer), permits submitted directly to the token by a
front-runner, a stranger pushing leftover allowances with no signature, permits signed with another owner's key,
and time passing so interest accrues. After every call, each owner's wallet underlying plus aTokens must be at
least what it was before that call, less Aave's rounding on the owner's own router calls (at most
`index / 1e27 + 2` units per call). No non-owner may ever hold any of the four tokens. Forge runs both invariants
in one shared campaign and reports it as one test.

<!-- numbers:contracts -->

26 tests in 3 suites, 26 passed, on a Polygon fork pinned to block 96,900,000 (forge 1.8.3, recorded 2026-11-08):

- `test/AccrueRouter.fork.t.sol`: 22 tests, 22 passed
- `test/AccrueRouter.invariant.t.sol`: 1 test, 1 passed
- `test/Deploy.t.sol`: 3 tests, 3 passed
- fuzz `testFuzz_supplyAmount`: 256 runs
- fuzz `testFuzz_withdrawAmount`: 256 runs
- invariant campaign (both invariants share it; forge reports it as `invariant_ownersOnlyReceive`): 64 runs, 1,280 handler calls, 0 reverts

`forge coverage` (recorded 2026-11-08):

| File | Lines | Statements | Branches | Functions |
|---|---|---|---|---|
| `src/AccrueRouter.sol` | 100 % (29/29) | 100 % (40/40) | 100 % (13/13) | 100 % (4/4) |
| `script/Deploy.s.sol` | 94.12 % (16/17) | 95.45 % (21/22) | 75 % (6/8) | 100 % (1/1) |

<!-- /numbers:contracts -->

## Trust assumptions

- **Aave v3 on Polygon.** The pool and aTokens are upgradeable by Aave governance. A malicious upgrade is outside
  what the router can defend against.
- **USDT0 and USDC** are upgradeable by their issuers and can freeze addresses. If the router itself were frozen,
  supplies through it would stop. Owners do not depend on the router to exit: their aTokens sit in their own
  wallets and can be redeemed directly through Aave, subject to Aave pausing or freezing a reserve, to the
  reserve's available liquidity, and to an issuer freezing the owner's own address.
- **The relayer is not trusted with funds.** It can only decide whether and when to submit a signature, and for a
  withdraw how much of the signed amount to redeem. Every path ends at the owner.

## Review method

The review followed a bug-class sweep for permit routers: permit front-running and replay, allowance leftovers,
reentrancy through token hooks, griefing, fee-on-transfer and rebasing assumptions (aToken rounding), event
correctness, constructor and deployment misconfiguration, EIP-7702 and smart-contract owners, plus edge values
(zero, one unit, max, full balance). Aave v3.5's verified aToken and pool source on Polygon was read for the exact
rounding rules (`rayDivCeil` on transfer and burn, `rayDivFloor` on mint, and `transferFrom` spending at most the
current allowance). Each claim is backed by a fork test, a fuzz test or the invariant suite.

To check that the invariant suite is not vacuous, the router was broken on purpose in five ways. Each break failed
the suite:

- withdrawing to the caller
- supplying for the caller
- leaving one unit of pool approval behind
- ignoring the signed allowance when sizing a withdraw
- calling the permit outside `try`

## Findings

| ID | Finding | Severity | Status |
|---|---|---|---|
| AR-01 | The constructor accepted a swapped, foreign-pool or non-contract aToken. The mistake would only show after deploy, as a broken withdraw path on an immutable contract. | Low | **Fixed.** The constructor requires `aToken.code.length != 0`, `UNDERLYING_ASSET_ADDRESS() == asset` and `POOL() == pool`. Tests: `test_constructor_swappedATokens_reverts`, `test_constructor_foreignPool_reverts`, `test_constructor_eoaAToken_reverts`; they were written first and failed against the old constructor. |
| AR-02 | The constructor's check trusts each aToken's own report, so a look-alike contract could pass it. | Low | **Fixed in deployment.** `Deploy.s.sol` checks every `aTokenOf(asset)` against the pool's own registry, `getReserveData(asset).aTokenAddress`, and aborts on a mismatch. Tests: `test_deployScript_wiresBothReserves`, `test_deployScript_rejectsRegistryMismatch`. A router deployed any other way does not get this check. |
| AR-03 | A supply of 1 unit mints zero scaled aTokens (`1 * 1e27 / index` rounds down to 0 while the index is above 1), so Aave reverts with `InvalidAmount()` rather than the router's `ZeroAmount()`. Nothing moves. | Informational | Accepted. The relayer's $1 minimum (1,000,000 units) is far above it. Tests: `test_supply_belowOneScaledUnit_revertsInAave`, `testFuzz_supplyAmount`. |
| AR-04 | Tokens sent straight to the router are not tracked. Stray aTokens go to whoever withdraws next, and stray USDT0 or USDC stays in the router for good, since there is no owner to sweep it. | Informational | Accepted. This only affects someone who sends tokens to the router by mistake. Test: `test_strayTokens_doNotBreakFlows`. |
| AR-05 | `Withdrawn.amount` reports what the pool actually sent the owner, which includes any stray aTokens (AR-04). | Informational | Accepted. It is the owner's real receipt. |

No issue was found that lets anyone take funds from an owner, lock them, or make the router keep any of its own
flows' tokens.

## Accepted risks

1. **Leftover withdraw allowance.** A withdraw-all signs a buffer above the balance so the interest accrued before
   the relay lands is included. Whatever part of the buffer is not used stays as aToken allowance to the router.
   Anyone can later spend it, but only by redeeming that much of the owner's aTokens back to the owner as
   underlying. That is harmless dust griefing. Invariant action `pushLeftover`.
2. **Anyone can submit a supply signature.** Whoever lands it first, the deposit goes to the owner. The relayer's
   own transaction then reverts with `InsufficientAllowance` and costs it a failed transaction's gas.
3. **USDC permits from addresses with code.** Circle's FiatToken v2.2 validates permits through ERC-1271 when the
   owner address has code. For an EOA with an EIP-7702 delegation, a plain signature may therefore fail as a USDC
   permit, and the supply then fails with `InsufficientAllowance`; the relayer refuses USDC deposits from such
   owners. USDT0 and the aTokens recover the signer with `ecrecover`, so a delegated EOA can still permit them.
   The other way round, a smart-contract wallet without a key of its own cannot permit the aTokens at all.
4. **`amount` is not signed for withdraw.** The caller may redeem less than the signed `permitValue`, never more,
   and only ever to the owner. The unused part becomes a leftover allowance (risk 1).
5. **Standing approvals.** If an owner ever gives the router an ordinary ERC-20 approval outside the app, anyone can
   use it to move those funds between the owner's wallet and the owner's Aave position, never anywhere else. The
   app never asks for one.
6. **Aave behaviour passes through.** Supply caps, frozen or paused reserves, and missing withdraw liquidity revert
   the call unchanged. A first supply may enable the asset as collateral for the owner, exactly as a direct Aave
   supply would. For an owner with Aave debt, the aToken transfer is subject to Aave's health-factor check.

## Relayer requirements

These follow from the risks above. Nothing on chain enforces them; the relayer (`worker/src/relayer/`) does:

- **Check before spending gas.** It recovers the permit's signer, checks the permit nonce against the token and
  the deadline window (now + 60 s to now + 60 min), then simulates the call with `eth_call` and maps router and
  pool reverts to relay error codes. A bad underlying permit surfaces as `InsufficientAllowance`; a bad aToken
  permit as `NothingToWithdraw`, unless the owner still has a leftover allowance (risk 1), in which case the call
  would redeem only the leftover, to the owner. Because signer, nonce and deadline are checked before the
  simulation, a permit the token would reject does not reach it; the relayer does not separately compare a
  simulated withdraw amount with the amount asked for. Tests: `worker/test/validate.test.ts`,
  `worker/test/chain.test.ts`, `worker/test/api.test.ts`.
- **Refuse USDC deposits from owners whose address has code** (`eth_getCode`), with a clear message (risk 3).
  Test: `worker/test/chain.test.ts`; in the app, `app/test/deposit.test.ts`.
- **Enforce the limits:** $1 minimum, $10,000 per deposit, 10 relays per owner per 24 hours, a daily gas budget
  and a gas floor for the relayer key. Tests: `worker/test/validate.test.ts`.
- **Withdraw-all** passes `amount = type(uint256).max` and signs a small buffer (balance + balance / 100,000 + 10
  units). Test: `app/test/deposit.test.ts`.
