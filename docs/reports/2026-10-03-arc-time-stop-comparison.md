# Arc time-stop comparison

Same 6,200 entered positions, +4 blocks, 40% at 2.5x, 98% ATH since entry (active after TP), $2 stake and 50% hard stop. Only the timer changes; current security, taxes, gas, pool fees, price impact and 0.5% adverse slippage stay fixed. The previous full-sample Optuna rule is held fixed, retaining 4,626 entries.

| Time stop | Net P&L | Change vs 20m | Win rate | Failed exits | Fixed screening P&L |
|---|---:|---:|---:|---:|---:|
| 15m | $6,224.55 | $+76.52 | 30.90% | 296 | $6,416.98 |
| 20m | $6,148.03 | $+0.00 | 30.66% | 299 | $6,344.35 |
| 25m | $6,118.86 | $-29.18 | 30.60% | 300 | $6,316.80 |
| 30m | $6,075.82 | $-72.21 | 30.56% | 299 | $6,273.08 |

15 minutes has the highest observed P&L among these four timers. It exceeds 20 minutes by $76.52 (+1.24%) unfiltered. These timers are tested at 98% ATH only; the full ATH × timer matrix was not searched. No new entry rule was optimized.

| Time stop | Time exits | Profitable time exits | Time exits profit ≥$1 | Time exits profit ≥$2 | Time-exit net P&L | Largest time-exit profit | Loss >5% count | Loss ≥$1 count |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 15m | 3886 | 123 | 84 | 68 | $1,441.76 | $47.57 | 689 | 521 |
| 20m | 3832 | 70 | 42 | 36 | $705.40 | $49.29 | 705 | 537 |
| 25m | 3809 | 46 | 20 | 15 | $49.74 | $47.01 | 710 | 540 |
| 30m | 3802 | 36 | 11 | 11 | $-203.24 | $45.18 | 709 | 539 |

## Capture and verification

The original capture already contained longer histories for earlier launches. Five entries needed more follow-up for a complete 30-minute horizon. Arc RPC supplied the tail from block 24,020,323 through 24,021,504; 51 additional states were appended to originally funded pools. Capture now ends at 2026-10-03T08:29:25Z (16:29:25 Asia/Taipei). Original states, price/liquidity history, sampled gas price, block-time assumption and token cohort are preserved. Never-funded records remain outside the entered cohort. Raw tail responses are in local `.runtime/arc-backtest/time-stop30-tail/`; the extended dataset is `dataset72h-30m.json`.

Every one of the 6,770 records in the 20-minute replay matches the previous 98%-ATH ledger exactly. All 24 replay tests pass, including timer execution and capture-horizon boundaries for 15/20/25/30 minutes.

| Time stop | Unknown-blocked P&L | Fixed screening unknown-blocked P&L |
|---|---:|---:|
| 15m | $-3,820.38 | $-1,576.51 |
| 20m | $-3,893.99 | $-1,649.26 |
| 25m | $-3,922.34 | $-1,677.56 |
| 30m | $-3,966.39 | $-1,723.53 |

Main results assume unavailable honeypot flags are clear, as in the existing study. All timer selections use the same observed cohort and are not held-out performance.

Reproduce with `node scripts/arc-backtest/run.mjs --dataset DATASET72H-30M.json --security-file SECURITY.json --delays 4 --take-profit-multiples 2.5 --trailing-ath-fraction 0.98 --time-stop-minutes MINUTES --output OUTPUT`, using MINUTES 15, 20, 25 or 30. Full ledgers remain in local `.runtime/arc-backtest/time-stop15/`, `time-stop20/`, `time-stop25/`, and `time-stop30/`.
