# Security

**Status: draft.** `AccrueRouter` has not had an external audit. This document records the team's own review of
the contract, what was fixed, and the risks that are accepted on purpose. The mainnet address will be listed in
`contracts/deployments/polygon.json` once the router is deployed.

## Reporting a vulnerability

Please report privately through GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**), not in a public issue.

## Scope

| In scope | Out of scope |
|---|---|
| `contracts/src/AccrueRouter.sol`, `contracts/src/interfaces/*` | The relayer worker and the Mini App (they hold no user funds; see "Relayer requirements") |
| `contracts/script/Deploy.s.sol` (deployment wiring) | Aave v3, USDT0, USDC and their governance |

## What the router does

An owner signs an EIP-2612 permit. Anyone, in practice the Accrue relayer paying the gas, submits it:

- `supplyWithPermit(asset, owner, amount, …)` pulls `amount` of USDT0 or USDC from `owner` and supplies it to the
  Aave v3 pool **on behalf of `owner`**, so the aTokens are minted straight to the owner's wallet.
- `withdrawWithPermit(asset, owner, amount, permitValue, …)` pulls `min(amount, aToken balance, allowance)` of the
  owner's aTokens and redeems them from Aave **straight to `owner`**.

The contract is immutable, has no owner or admin, takes no fees and keeps no balance between transactions. The
asset/aToken allowlist is fixed in the constructor.

## Properties and the tests that hold them

All tests run on a Polygon fork pinned to block 96,900,000, against the real Aave v3.5 pool, aTokens, USDT0 and
USDC (`contracts/test/`).

| # | Property | Evidence |
|---|---|---|
| P1 | Tokens only move owner → Aave (aTokens to owner) or owner's aTokens → Aave → owner. The caller cannot name a recipient. | `invariant_ownersOnlyReceive`; every success test asserts router, relayer and front-runner hold nothing |
| P2 | The router holds no token balance and no pool approval after any call. | `invariant_routerHoldsNothing`; `_assertNothingStrays()` in every success test |
| P3 | A permit that someone submits first cannot block the relay. | `test_supply_frontRunPermit_stillSucceeds`, `test_withdraw_frontRunPermit_stillSucceeds`, invariant actions `frontRunSupply` / `frontRunWithdraw` |
| P4 | A signature only ever moves its signer's own funds. | `test_supply_wrongSigner_reverts`, invariant actions `crossSignedSupply` / `crossSignedWithdraw` |
| P5 | A withdraw never pulls more than the signed allowance, the balance or `amount`, and the owner receives at least what was pulled. | `test_withdrawAll_cappedBySignedValue`, `testFuzz_withdrawAmount` |
| P6 | The allowlist can only contain real aTokens of the configured pool. | `test_constructor_*`, `test_deployScript_*` |

The invariant handler acts for three owners across both assets: relayed supplies and withdrawals (partial, signed
higher than pulled, and withdraw-all with a growth buffer), permits submitted directly to the token by a
front-runner, a stranger pushing leftover allowances with no signature, permits signed with another owner's key,
and time passing so interest accrues. After every call, each owner's wallet underlying plus aTokens must be at
least what it was before that call, less Aave's rounding on the owner's own router calls (at most
`index / 1e27 + 2` units per call). No non-owner may ever hold any of the four tokens.

## Trust assumptions

- **Aave v3 on Polygon** (pool and aTokens are upgradeable by Aave governance). A malicious upgrade is outside what
  the router can defend against.
- **USDT0 and USDC** are upgradeable by their issuers and can freeze addresses. If the router itself were frozen,
  supplies through it would stop; owners can still always exit, because their aTokens sit in their own wallets
  and can be redeemed directly through Aave.
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
| AR-01 | The constructor accepted a swapped, foreign-pool or non-contract aToken. The mistake would only show after deploy, as a broken withdraw path on an immutable contract. | Low | **Fixed** (`02feab0`). The constructor requires `aToken.code.length != 0`, `UNDERLYING_ASSET_ADDRESS() == asset` and `POOL() == pool`. Tests: `test_constructor_swappedATokens_reverts`, `test_constructor_foreignPool_reverts`, `test_constructor_eoaAToken_reverts`; they were written first and failed against the old constructor. |
| AR-02 | The constructor's check trusts each aToken's own report, so a look-alike contract could pass it. | Low | **Fixed in deployment** (`5d3d638`). `Deploy.s.sol` checks every `aTokenOf(asset)` against the pool's own registry, `getReserveData(asset).aTokenAddress`, and aborts on a mismatch. Tests: `test_deployScript_wiresBothReserves`, `test_deployScript_rejectsRegistryMismatch`. |
| AR-03 | A supply of 1 unit mints zero scaled aTokens (`1 * 1e27 / index` rounds down to 0 while the index is above 1), so Aave reverts with `InvalidAmount()` rather than the router's `ZeroAmount()`. Nothing moves. | Informational | Accepted. The relayer's $1 minimum (1,000,000 units) is far above it. Tests: `test_supply_belowOneScaledUnit_revertsInAave`, `testFuzz_supplyAmount`. |
| AR-04 | Tokens sent straight to the router are not tracked. Stray aTokens go to whoever withdraws next, and stray USDT0 or USDC stays in the router for good, since there is no owner to sweep it. | Informational | Accepted. This only affects someone who sends tokens to the router by mistake. Test: `test_strayTokens_doNotBreakFlows`. |
| AR-05 | `Withdrawn.amount` reports what the pool actually sent the owner, which includes any stray aTokens (AR-04). | Informational | Accepted. It is the owner's real receipt. |

No issue was found that lets anyone take funds from an owner, lock them, or make the router keep any.

## Accepted risks

1. **Leftover withdraw allowance.** A withdraw-all signs a buffer above the balance so the interest accrued before
   the relay lands is included. Whatever part of the buffer is not used stays as aToken allowance to the router.
   Anyone can later spend it, but only by redeeming that much of the owner's aTokens back to the owner as
   underlying. That is harmless dust griefing. Invariant action `pushLeftover`.
2. **Anyone can submit a supply signature.** Whoever lands it first, the deposit goes to the owner. The relayer's
   own transaction then reverts with `InsufficientAllowance` and costs it a failed transaction's gas.
3. **USDC permits from addresses with code.** Circle's FiatToken v2.2 validates permits through ERC-1271 when the
   owner address has code. An EOA with an EIP-7702 delegation therefore cannot permit USDC with a plain
   signature, and the supply fails with `InsufficientAllowance`. USDT0 and the aTokens recover the signer with
   `ecrecover`, so a delegated EOA can still permit them. The other way round, a smart-contract wallet without a key
   of its own cannot permit the aTokens at all.
4. **`amount` is not signed for withdraw.** The caller may redeem less than the signed `permitValue`, never more,
   and only ever to the owner. The unused part becomes a leftover allowance (risk 1).
5. **Standing approvals.** If an owner ever gives the router an ordinary ERC-20 approval outside the app, anyone can
   use it to move those funds between the owner's wallet and the owner's Aave position, never anywhere else. The
   app never asks for one.
6. **Aave behaviour passes through.** Supply caps, frozen or paused reserves, and missing withdraw liquidity revert
   the call unchanged. A first supply may enable the asset as collateral for the owner, exactly as a direct Aave
   supply would. For an owner with Aave debt, the aToken transfer is subject to Aave's health-factor check.

## Relayer requirements

These follow from the risks above. The relayer has to do them; nothing on-chain enforces them:

- Simulate every relay with `eth_call` before sending it, and map router and pool reverts to relay error codes.
  A bad underlying permit surfaces as `InsufficientAllowance`. A bad or stale aToken permit surfaces as
  `NothingToWithdraw`, unless the owner still has a leftover allowance (risk 1). In that case the simulation
  succeeds, but only for the leftover, so compare the simulated `withdrawn` with what the owner asked for.
- Refuse USDC deposits for owners whose address has code (`eth_getCode`), with a clear message (risk 3).
- Enforce the $1 minimum, the $10,000 cap and the deadline window of now+60 s to now+60 min.
- For withdraw-all, pass `amount = type(uint256).max` and keep the signed buffer small.
