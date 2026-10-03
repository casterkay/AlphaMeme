# Arc immediate-entry baseline backtest

Generated: 2026-10-03T09:40:33.423Z. Research replay; no transactions sent.

Discovery window: 2026-09-30T07:58:45.000Z to 2026-09-30T13:58:45.000Z (6.00 hours). Follow-up through 2026-10-03T08:19:25.000Z.

Scope: Earliest native-USDC or ERC20-USDC paired pool per token created in window, across the two configured Arc Uniswap v3/v4 factories; not token deployment or pre-migration curves. 548 distinct token/pool records; 543 funded and 5 never funded during capture.

## Execution model

- One $2 purchase per token, at the end of block +1/+2/+4/+10/+20 after first active liquidity. No security or liquidity-size entry filter.
- Three independent policies: 50% of original quantity at 2x; 63% at 1.6x; 40% at 2.5x. After that fill, sell the remainder at 90% of ATH since entry. Hard stop at 50% of average entry cost per received token; time stop at 20 minutes after entry.
- Observe ordered pool events; fills use the state at the end of the next block. A full exit takes precedence over a partial take-profit when signals coincide. The timer runs without swaps.
- Active-range virtual reserves price the $2 buy and actual sell quantity, including pool fee, price impact, current token taxes and 0.50% adverse slippage on each fill. Historical markets do not react to our trades; no complete tick-crossing or hook emulator.
- Before the first dynamic-fee Swap, use that pool's first observed ordinary fee; when none exists, assume 0.30%. Current token security/taxes are applied throughout history.
- Gas: 250000 units per buy/sell/failed sell, 50000 units once before the first sell, at 20.00 USDC gwei from the sampled Arc header. Gas is additional to the $2 stake.
- A honeypot or zero active liquidity at execution makes the sale fail. One failed sale writes off remaining inventory and still pays approval/swap gas. LP lock and zero-valued can_sell/can_not_sell fields are unused.
- GMGN supplies current security/taxes. Unresolved fields are supplemented with GoPlus contract reports; an unresolved honeypot flag can also use AVE's contract report. A positive honeypot finding wins; tax priority is GMGN then GoPlus. AVE market flags are unused.
- Missing security/tax inputs are shown as scenarios: main result assumes missing flags are non-honeypot and missing taxes zero; conservative result assumes missing honeypot flags block selling and missing taxes are 100%. Tokens remain in the cohort. These are missing-data scenarios, not bounds on all execution-model error.
- Late funding without a complete 20-minute holding horizon is counted as incomplete_horizon, without a fabricated buy or sale.

## Security coverage

543 current security snapshots; 3 marked honeypot; 304 have at least one missing/conflicting required field. Missing buy tax: 1; missing sell tax: 1.

## Comparison matrix

| Delay blocks (~seconds) | Take-profit | Entries | Win rate | Net P&L USD | EV/entry USD | Gas USD | Failed exits | Conservative P&L USD |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 (~0.51) | 50% at 2x | 543 | 25.97% | 482.71 | 0.89 | 6.80 | 54 | -321.44 |
| 1 (~0.51) | 63% at 1.6x | 543 | 28.91% | 409.91 | 0.75 | 6.82 | 54 | -343.32 |
| 1 (~0.51) | 40% at 2.5x | 543 | 23.57% | 523.05 | 0.96 | 6.76 | 62 | -307.75 |
| 2 (~1.01) | 50% at 2x | 543 | 25.97% | 482.64 | 0.89 | 6.80 | 54 | -321.50 |
| 2 (~1.01) | 63% at 1.6x | 543 | 29.10% | 409.93 | 0.75 | 6.82 | 54 | -343.38 |
| 2 (~1.01) | 40% at 2.5x | 543 | 23.57% | 522.98 | 0.96 | 6.76 | 62 | -307.82 |
| 4 (~2.03) | 50% at 2x | 543 | 25.97% | 482.02 | 0.89 | 6.80 | 54 | -322.12 |
| 4 (~2.03) | 63% at 1.6x | 543 | 29.10% | 409.45 | 0.75 | 6.82 | 54 | -343.86 |
| 4 (~2.03) | 40% at 2.5x | 543 | 23.57% | 522.30 | 0.96 | 6.76 | 62 | -308.50 |
| 10 (~5.07) | 50% at 2x | 543 | 25.41% | 471.79 | 0.87 | 6.79 | 54 | -328.57 |
| 10 (~5.07) | 63% at 1.6x | 543 | 29.83% | 402.24 | 0.74 | 6.82 | 54 | -349.33 |
| 10 (~5.07) | 40% at 2.5x | 543 | 24.31% | 504.01 | 0.93 | 6.73 | 63 | -317.35 |
| 20 (~10.15) | 50% at 2x | 543 | 25.60% | 462.99 | 0.85 | 6.78 | 56 | -324.70 |
| 20 (~10.15) | 63% at 1.6x | 543 | 26.89% | 400.36 | 0.74 | 6.82 | 54 | -345.51 |
| 20 (~10.15) | 40% at 2.5x | 543 | 22.65% | 450.73 | 0.83 | 6.67 | 69 | -319.06 |

## Exit reasons

| Delay | Policy | Reasons (counts) |
|---|---|---|
| 1 | 50% at 2x | time_stop: 364, trailing_stop: 118, honeypot: 3, stop_loss: 7, liquidity_disappeared: 51, never_funded: 5 |
| 1 | 63% at 1.6x | time_stop: 362, trailing_stop: 120, honeypot: 3, stop_loss: 7, liquidity_disappeared: 51, never_funded: 5 |
| 1 | 40% at 2.5x | time_stop: 364, trailing_stop: 110, honeypot: 3, stop_loss: 7, liquidity_disappeared: 59, never_funded: 5 |
| 2 | 50% at 2x | time_stop: 364, trailing_stop: 118, honeypot: 3, stop_loss: 7, liquidity_disappeared: 51, never_funded: 5 |
| 2 | 63% at 1.6x | time_stop: 362, trailing_stop: 120, honeypot: 3, stop_loss: 7, liquidity_disappeared: 51, never_funded: 5 |
| 2 | 40% at 2.5x | time_stop: 364, trailing_stop: 110, honeypot: 3, stop_loss: 7, liquidity_disappeared: 59, never_funded: 5 |
| 4 | 50% at 2x | time_stop: 364, trailing_stop: 118, honeypot: 3, stop_loss: 7, liquidity_disappeared: 51, never_funded: 5 |
| 4 | 63% at 1.6x | time_stop: 362, trailing_stop: 120, honeypot: 3, stop_loss: 7, liquidity_disappeared: 51, never_funded: 5 |
| 4 | 40% at 2.5x | time_stop: 364, trailing_stop: 110, honeypot: 3, stop_loss: 7, liquidity_disappeared: 59, never_funded: 5 |
| 10 | 50% at 2x | time_stop: 364, trailing_stop: 117, honeypot: 3, stop_loss: 8, liquidity_disappeared: 51, never_funded: 5 |
| 10 | 63% at 1.6x | time_stop: 362, trailing_stop: 119, honeypot: 3, stop_loss: 8, liquidity_disappeared: 51, never_funded: 5 |
| 10 | 40% at 2.5x | time_stop: 364, trailing_stop: 107, honeypot: 3, stop_loss: 9, liquidity_disappeared: 60, never_funded: 5 |
| 20 | 50% at 2x | time_stop: 364, trailing_stop: 116, honeypot: 3, stop_loss: 7, liquidity_disappeared: 53, never_funded: 5 |
| 20 | 63% at 1.6x | time_stop: 362, trailing_stop: 120, honeypot: 3, stop_loss: 7, liquidity_disappeared: 51, never_funded: 5 |
| 20 | 40% at 2.5x | time_stop: 364, trailing_stop: 102, honeypot: 3, stop_loss: 8, liquidity_disappeared: 66, never_funded: 5 |

## Reproduction

Run `node scripts/arc-backtest/run.mjs --dataset DATASET.json --security-file SECURITY.json --output OUTPUT` to replay without network calls.

Outputs: summary.json, matrix.csv and trades.json (every simulated buy, sell and failed exit). Raw RPC chunks and current security snapshots are resumable local evidence, kept outside Git.
