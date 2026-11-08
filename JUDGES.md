# Five-minute review path

A short route through Accrue inside Nimiq Pay, for reviewers and anyone else trying it. You need
Nimiq Pay on a phone. NIM and USDT on Polygon make it more interesting but are not required: every screen explains
itself with empty balances.

## 1. Open it (30 s)

On the phone, open **<https://nimpay.app/miniapps/open/accrue.pages.dev>**. On a computer, visit
[accrue.pages.dev](https://accrue.pages.dev) and scan the QR code behind "Open in Nimiq Pay".

Look for: the first screen asks nothing of your wallet. Nimiq Pay shows no dialog until you tap.

## 2. Start (15 s)

Tap **Start**. Nimiq Pay asks for your NIM address, and only that. The Polygon address is a separate tap later,
where dollars need it.

## 3. Home (30 s)

Everything that earns, in the currency Nimiq Pay is set to, with its source written under it. Dollars in Aave
tick every second; NIM shows your stake and your pool's verdict. "Idle, could be earning" lists balances that are
not working, with a button that opens the right sheet. "What's due next" shows your pool's next payout, unstaking
NIM that is about to unlock, and the Payout Check for your pool.

## 4. Payouts (1 min)

The **Payouts** tab is Payout Check.

- **Your pool:** expected for your stake against what reached you, over the window the check measured, and why.
- **All pools:** every listed pool with a neutral verdict. Tap one to see its reasons, for example "Paid 97.5% of
  earnings against 97.0% promised."
- **How Payout Check decides** opens the method; the full version is [METHODOLOGY.md](METHODOLOGY.md).

What you should see right now (rendered from the live API when these docs were last built; the app is always
current):

<!-- numbers:pools -->

From [`accrue.pages.dev/api/pools`](https://accrue.pages.dev/api/pools), fetched 2026-11-08 06:07 UTC; verdicts computed at 2026-11-08 06:05 UTC; indexed data reaches 2026-11-08 05:05 UTC to 2026-11-08 05:25 UTC depending on the pool, 7-day window. The app shows the same rows, live.

| Pool | Pays | Fee | Verdict | Paid of earnings | Promised |
|---|---|---:|---|---:|---:|
| Garuda Pool | restakes | 5 % | Paid as promised | 95.00 % | 95.00 % |
| Keyring Staking | restakes | 5 % | Paid as promised | 100.01 % | 95.00 % |
| Mint Pool | restakes | 5 % | Paid as promised | 94.96 % | 95.00 % |
| Nimiq.Fun | to wallet | 2.5 % | Paid as promised | 95.77 % | 97.50 % |
| ObsidianStake | to wallet | 5 % | Paid as promised | 221.55 % | 95.00 % |
| Ritvars Staking | restakes | 2 % | Paid as promised | 97.90 % | 98.00 % |
| Siam Pool | restakes | 3 % | Paid as promised | 97.49 % | 97.00 % |
| CHIPMUNK POOL | to wallet | 5 % | Not enough data | – | 95.00 % |
| nim.re Staking Pool | restakes | 3.33 % | Not enough data | 87.01 % | 96.67 % |
| NODENIMIQ1.NIMIQ-JU.FR by &#64;Ju | restakes | 1 % | Not enough data | – | 99.00 % |
| NODENIMIQ2.NIMIQ-JU.FR by &#64;Ju | restakes | 1 % | Not enough data | – | 99.00 % |
| Nimiq Surf | no payouts | 0 % | No payouts by design | – | 100.00 % |
| Private Whalidator | no payouts | not listed | No payouts by design | – | – |
| Nimiq Marketing Pool | restakes | 0 % | Can't verify (routed elsewhere) | 50.34 % | 100.00 % |
| $NIM_pool | restakes | 0 % | no verdict yet | – | 100.00 % |
| ImpactZero stake | restakes | 0 % | no verdict yet | – | 100.00 % |
| Nimiq Base Staking | restakes | 0 % | no verdict yet | – | 100.00 % |
| NimiqCafe Staking | restakes | 3 % | no verdict yet | – | 97.00 % |
| NimiqHub Staking | restakes | 5 % | no verdict yet | – | 95.00 % |
| NimiqPocket | restakes | 1 % | no verdict yet | – | 99.00 % |
| Synapse LN - Nimiq | restakes | 1 % | no verdict yet | – | 99.00 % |

7 of 21 pools had no verdict yet when this was fetched; the API's reason: "Payout Check has not looked at this pool yet."

<!-- /numbers:pools -->

## 5. NIM (1 min)

- Pools are ordered by payout record, then fee.
- Open **Stake** or **Add**: the sheet says what you sign, to whom (the staking contract), what happens next and
  the fee, before Nimiq Pay asks.
- **Unstake** shows the four steps with the wait ahead (12 to 24 hours) and a countdown once it starts.
- **Switch pool** with NIM staked shows the plan the network requires: stop, wait for the release, then move.

## 6. Dollars (1 min)

- Tap **Connect Polygon wallet**; Nimiq Pay asks once.
- The risk card shows the four facts: protocol, the rate varies (today's rates from the Aave pool), what can go
  wrong, exit time (what Aave can pay out right now).
- **Deposit** $1: Review shows what you sign (a permit for exactly that amount, valid 20 minutes), to whom
  (Accrue's router, with its Polygonscan link), what happens next, and "Paid by Accrue. You need no POL." If your
  wallet is on another network, switching to Polygon is its own tap. For USDT, Nimiq Pay shows "Chain: undefined"
  on the signature; the sheet explains why before you sign.
- After signing: "Sending to Accrue's relayer…", "Sent to Polygon", then "Earning". Withdraw works the same way
  and goes back to the wallet the money came from.

Until the router is live on Polygon ([PROOF.md](PROOF.md#polygon-mainnet)), Review shows "Dollar deposits are not
open yet: the Accrue contract is not live on Polygon." where the router would be, and the sign button stays off.

## 7. Activity (15 s)

Every action with its status and a link to Polygonscan or the Nimiq explorer. The list is rebuilt from the relay
and both chains, not from this phone alone.

## Refusals worth trying

Refusing, cancelling and impossible amounts are ordinary states; each one says what happened and what to do next.

| Try | You should see |
|---|---|
| Cancel the deposit signature in Nimiq Pay | "Cancelled — nothing was sent", "You declined in Nimiq Pay. No signature left your phone.", and Try again |
| Cancel a staking transaction in Nimiq Pay | "You cancelled in your wallet. Nothing was sent." |
| Deposit 0.50 USDT | "Deposits start at 1.00 USDT." Review stays off and nothing is signed. |
| Type `1e3` or `1,000.50` as an amount (English) | "Use digits and one decimal point, like 12.50." before any signature |
| Stake 50 NIM as a new staker | "Staking needs at least 100 NIM in total." |
| Unstake so that 50 NIM would stay staked | "Leave at least 100 NIM staked, or unstake all of it. The network refuses anything in between." |
| Close the app while a deposit is on its way, then reopen | The same job, still followed until the chain answers ("On its way", or "Checking…" if the last answer was lost), never a second signature |

## Outside Nimiq Pay

[accrue.pages.dev](https://accrue.pages.dev) in any browser: the scoreboard, and a checker. Paste a NIM address to
see its pool's verdict with expected and received, or a 0x address to see its Aave position. Bad input is
refused before anything is asked of the API.

## Where the proofs are

- [CLAIMS.md](CLAIMS.md): every claim with its evidence tier, proof and how to reproduce it.
- [PROOF.md](PROOF.md): the router deployment, the testnet staking transactions, the scoreboard and the test
  counts.
- [METHODOLOGY.md](METHODOLOGY.md): how Payout Check decides, its validation and its limits.
- [SECURITY.md](SECURITY.md): the router review, findings and accepted risks.
- `node scripts/verify-onchain.mjs` re-checks the chain-side claims in one run.
