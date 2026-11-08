# How Payout Check decides

Nimiq pays staking rewards to each validator's reward address. A pool then passes them on to its stakers, by
adding to their stake ("restake") or by sending NIM to their wallets ("direct"), on a schedule it publishes and
for a fee it publishes. Nothing on chain makes it do either. Payout Check reads a pool's own transactions and
answers one question: **over the last 7 days, did the pool pass on what it promised, on time?**

It is a reading of public chain data. It is not an audit, it cannot see agreements made off chain, and it says
"not enough data" whenever the data does not support a firm answer.

The code is `packages/shared/src/payout.ts` (classification, windows, verdict rules) and
`worker/src/indexer/` (scanning, hourly and daily totals, windows over stored totals); the stale-data reason is
added in `worker/src/api/pools.ts`. Every threshold below is in that code.

## 1. What is read

For every pool listed by the Nimiq validators API (`validators-api-main.je-cf9.workers.dev/api/v1/validators`:
name, fee, payout type, schedule), a cron job that runs every minute (one small job per run, sizes set by the `CRON_*` variables in `worker/wrangler.toml`) reads the transactions of the pool's
reward address with `getTransactionsByAddress`. A pool is due for a visit once about 400 new transactions are
waiting or 90 minutes have passed, whichever comes first. Only transactions at or below the last macro block are
used, so nothing that could still be reverted is counted. The first visit reads 7 days and 6 hours back.

Each transaction touching the reward address is classified:

| Kind | Rule |
|---|---|
| Earned | From the coinbase address `NQ81 C01N BASE …` to the reward address. |
| Restake payout | From the reward address to the staking contract with add-stake data (`06` + staker address). |
| Direct payout | A basic transaction from the reward address to another address. |
| Other outflow | Anything else that leaves the reward address. |
| Other inflow | Anything else that arrives; ignored. |

Payout recipients are checked against the staker set with `getStakerByAddress` (answers cached for 7 days, 1 day
for "not a staker"):

- A restake payout to a staker who now delegates to this pool counts as paid. One to an address that is no longer
  a staker counts as paid but **unverified** (adding stake needs an existing staker, so they left after being
  paid). One to a staker of another pool counts as **other outflow**.
- A direct payout to a staker of this pool counts as paid. One to a non-staker or to another pool's staker counts
  as **other outflow**. One whose recipient has not been looked up yet counts as paid but **unverified**.

The share paid to unverified recipients is shown as a reason on the verdict. A staker who moves to another pool
after being paid turns that payout into other outflow, which lowers the paid ratio. For a pool that pays at least
its promise this can at worst move it into the uncertainty band ("not enough data"), never to "Short": a drop of
5 points or more from that alone means 5 % or more other outflow, which rules out "Short" (rule 6 below). A pool
already paying a little under its promise can be pushed further down by it.

What is stored: per pool and hour, the earned, paid (restake, direct, unverified) and other-outflow totals and
the times of the first and last payout; per staker and UTC day, the number and sum of payouts received. No raw
transactions are kept.

## 2. The window

The window covers the last 7 days of **data**, ending where the indexed data reaches (`reach`), never at the
wall-clock time. A pool whose indexing lags is read on the data it has, and the verdict says how old it is.

Payouts come in runs: one scheduled distribution, possibly spread over many minutes or hours and over a restake
and a direct leg.

- **Payout cycle.** The value-weighted payout cycle is the time between two payouts of the stake-weighted
  typical staker, measured from the data.
- **Runs.** Payouts closer together than the run gap belong to one run. The run gap is a quarter of the pool's
  own payout cycle, at least 300 blocks (about 5 minutes) and at most 6 hours. A pool that pays a 12-hour cycle
  one staker every few minutes is one run, not dozens.
- **Start.** The first run in the data is dropped, because it settles rewards earned before the data starts.
  The window opens where that run ends.
- **End.** The window closes at the end of the last **complete** run: the next run has started, or the data
  reaches a run gap past it. Data that stops in the middle of a distribution would count the run's earnings
  without all of its payouts, so a run in progress never closes a window.
- **Streams.** Some pools pay with every batch, about once a minute, so their payouts form one endless run. A run
  counts as a stream when it has at least 3 consecutive inner hours, its typical (median) hourly paid ÷ earned
  lies between 0.5 and 1.1, every inner hour is within ±10 % of that typical value, and the running difference
  between paid and typical × earned never exceeds one average hour's payouts. Inside a stream the last payout of
  an inner hour may close the window, but never within one payout cycle (at least an hour) of the data's reach.
  The 1.1 bound is what keeps a slow distribution of a long cycle from passing as a stream: a separate run spans
  at most three quarters of its cycle, so it pays at least 4/3 of the payout rate per hour, above 1.1 for any
  rate over about 83 %.
- **Edges and gaps.** Earnings in the hours at either end are pro-rated by time, since rewards arrive evenly
  once per batch. If the indexer is still catching up and has a gap, only the longer side of the gap is used,
  and the verdict says so.

## 3. What is measured

| Measure | Definition |
|---|---|
| Paid ratio | (restake payouts + direct payouts) ÷ earned, over the window |
| Promised ratio | 1 − the pool's published fee |
| Other outflow | other outflow ÷ earned |
| Cycles | median number of payouts a staker received inside the window |
| Last payout | time of the newest payout, compared with the data's reach |

## 4. The verdict

The rules run in this order; the first that applies decides.

| # | Condition | Verdict |
|---|---|---|
| 1 | The pool lists payout type "none" | **No payouts by design** |
| 2 | The schedule is readable and the last payout is more than 2 × the published interval + 1 hour before the data's reach | **Behind schedule** |
| 3 | Fewer than 3 cycles, or nothing earned | **Not enough data** |
| 4 | Other outflow is 30 % of earnings or more | **Can't verify (routed elsewhere)** |
| 5 | Paid ratio ≥ promised − 2 percentage points | **Paid as promised** |
| 6 | Paid ratio < promised − 5 points, other outflow < 5 %, at least one confirmation window, and every confirmation window short too | **Short** |
| 7 | Paid ratio < promised − 5 points and other outflow < 5 %, but there is no confirmation window or one of them is not short | **Not enough data** ("a payout may still be in progress") |
| 8 | Paid ratio < promised − 5 points with other outflow between 5 % and 30 % | **Not enough data** ("other outflows too large to conclude") |
| 9 | Paid ratio between promised − 5 and promised − 2 points | **Not enough data** ("within the uncertainty band") |

**Confirmation windows.** A pool is only called short if the shortfall holds at more than one window end. The
confirmation windows have the same start and end at every earlier complete end within one cycle of the main end,
plus the latest end at least one cycle before it; one cycle is the longest of the published schedule, the
measured payout cycle and one hour. Each must also show a paid ratio below promised − 5 points with other outflow
under 5 % and at least one cycle. Data that stops while a payout is still going out reads short at that one end
only, so it cannot produce a "Short".

**Reasons shown with a verdict:**

- the paid and promised ratios ("Paid 97.5% of earnings against 97.0% promised.");
- "Paid more than earned in this window (includes a one-off transfer)" when the paid ratio is more than
  20 points above the promise. A transfer to a staker still counts as paid, but it is not a payout cycle; on
  2026-11-07 one listed pool sent a single transfer worth about 1.7 times its weekly earnings to one staker;
- the share of earnings paid to recipients not checked against the staker set;
- "Data as of …; indexing is behind" when the data's reach is older than twice the published interval or
  3 hours, whichever is longer;
- "The indexer is still catching up on recent transactions of this pool" while a gap is open.

Verdicts are computed by the cron job and cached; a pool's verdict is recomputed when its fee, payout type,
schedule or reward address changes, or when new data arrives and the cached verdict is 15 minutes old. Until the
first computation the API returns no verdict and the app shows "not enough data yet".

## 5. Your own check

For a staker (`/api/check/<NIM address>`, the Payout Check screen and the landing checker):

- **Window:** whole UTC days between two midnights at which the pool's payouts settle cleanly: no run crosses the
  midnight and the run before it is complete, or the midnight falls inside a stream at least one cycle before
  the data's reach. The answer names the window it used (often 6 days).
- **Expected** = the pool's earnings over that window × (your active stake ÷ the pool's stake) × (1 − fee).
- **Received** = the payouts that reached your address on those days.
- **Verdict:** received ≥ 98 % of expected reads paid as promised; below 95 % reads short; in between, or fewer
  than 3 payouts, reads not enough data.
- **Gate:** if the pool is behind schedule or routes its rewards elsewhere, you get the pool's verdict. You are
  only called short when the pool itself is short; otherwise a low share reads not enough data, because the
  calculation uses today's stake and a stake added during the week would look like a shortfall. A pool with no
  payouts by design shows no amounts.

## Validation

**Recorded mainnet data** (`packages/shared/test/fixtures/`, two pools recorded on 2026-11-07: 2,500 and 7,500
transactions). The restake-only pool reads paid as promised within 0.97 ± 0.02 of a 3 % fee; the pool that pays
restake and direct legs reads paid as promised from both. The per-staker cycle count is checked against an
independent count from the raw transactions. Test: `packages/shared/test/payout.test.ts`.

**Negative controls.** The same recorded histories with every payout × 0.8 read **Short**, confirmed by the
earlier window ends (`payout.test.ts`; `worker/test/cutsweep.test.ts`, "the same history with every payout x0.8
is SHORT at every cut"). Synthetic pools paying 80 % (12-hour cycles paid over 2.5 hours, 24-hour cycles over 7
or 9 hours, 4 random stake layouts each) read **Short** at every cut from a quarter cycle (the run gap) after one
distribution ends until the next one starts (`cutsweep.test.ts`).

**No false "Short" from where the data stops.** `cutsweep.test.ts` cuts histories at every macro block (once a
minute) of their last two cycles and asserts the verdict at each cut:

- honest 95 % payers, 24-hour cycles paid over 7, 8 or 9 hours and 12-hour cycles over 2.5, 10 or 11 hours,
  4 random stake layouts each: 0 Short, 0 Behind schedule;
- the recorded 7,500-transaction history at every macro block of its last 24 hours: 0 Short, 0 Behind schedule;
- equal stakes at a constant pace (24-hour cycles over 6 to 9 hours, 12-hour cycles over 5 to 8 hours, a cut
  every 10 minutes of the last cycle): an honest 95 % payer always reads between 94 % and 97 % and never Short;
  an 85 % payer is never Paid as promised and reads Short after every complete cycle;
- a stream paying every batch: a window at every 10th macro block of the last day, its ratio within 0.5 points
  of the raw transactions between the window's bounds.

On live data (a one-off run on 2026-11-07 over a cached 7-day history of 16 paying pools, 1,441 cut points each
over the last 24 hours): 0 Short and 0 Behind schedule, and across those cuts each pool's ratio moved by at most
about 0.3 points, apart from the pool with the one-off transfer. A separate slide of the window's start over the
first 24 hours and its end over the last 24 hours, in 30-minute steps (49 windows per pool), moved a ratio by at
most 0.87 points. With every payout × 0.8 the
same run read Short at every cut for every pool except three that the rules keep from a "Short" on purpose: one
routes about half its rewards elsewhere, one has 13 % other outflow, and one holds the one-off transfer.

**Independent cross-check.** ImpactZero's operator publishes an independent payout verifier for that pool
([nimiq.subimpact.net/verify](https://nimiq.subimpact.net/verify), API
`nimiq-api.subimpact.net/api/tracker/api/validators/<address>/{epochs,cycles}`). Over the same block range as
Accrue's 7-day window on 2026-11-07 (blocks 65,691,180 to 66,291,447):

- rewards per epoch were identical in 11 of 14 epochs; in two, Accrue counted 2.96 NIM and 11.8 NIM more, and the
  last epoch was still open;
- paid per epoch agreed within 0.03 NIM in every epoch;
- of the 8,485 payout cycles fully inside the range, their verifier marks 8,483 verified and 2 mismatched
  (carried balances of 672 and 724 luna);
- Accrue's paid ratio was 1.000002 (9,739,844,511 luna paid against 9,739,823,368 earned), **Paid as promised**
  for a 0 % fee.

Both tools say the pool passes its rewards on in full. This comparison was made once by hand; it is not re-run by
a script.

## Honest limits

- **Payouts that fill most of their own cycle get no verdict.** When a distribution takes about 75 % or more of
  its cycle (a 12-hour cycle paid over 9 to 11 hours, say), the run gap merges consecutive runs, no complete run
  or stream forms, and the pool reads not enough data. "Short" is unreachable for that payout shape.
- **Cycles longer than 24 hours.** The run gap stops growing at 6 hours, so for cycles over a day the argument
  that keeps a slow distribution from passing as a stream (a separate run spans at most three quarters of its
  cycle) no longer holds, and the ratio for such a pool is less certain. A "Short" still needs every confirmation
  window, and a pool paying less often than every 2 days rarely has 3 cycles in 7 days, so it mostly reads not
  enough data.
- **Streams paying more than 110 % of each hour's earnings**, or forwarding more than half of them elsewhere, get
  no stream windows; they rely on hard run ends and read not enough data without them.
- **A fee sent to an operator wallet that also stakes in the pool counts as paid.** The two cannot be told apart
  on chain. The fee wallets seen so far are not stakers.
- **Staker-level checks use today's stake.** A staker short-changed by an otherwise honest pool reads not enough
  data with a low share, not short.
- **The thresholds are measured, not proven.** The stream and confirmation rules were tuned on synthetic sweeps
  and one week of 16 live pools. A pool with a new payout pattern should be swept the way
  `worker/test/cutsweep.test.ts` does before a "Short" for it is trusted.
- **One public RPC.** The indexer reads `rpc.nimiqwatch.com`. A pool whose data keeps failing is retried every
  30 minutes and its verdict says how old its data is.
- **Schedules are free text.** A schedule that cannot be parsed (for example an empty one) disables the
  behind-schedule check for that pool.
