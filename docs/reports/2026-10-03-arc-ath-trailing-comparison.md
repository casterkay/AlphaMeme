# Arc ATH trailing-stop comparison

Same 72-hour cohort, +4 blocks, 40% of original quantity at 2.5x, $2 stake. Only the ATH trailing threshold changes. Trailing activates after take-profit, with ATH measured since entry; 50% hard stop, 20-minute timer and all original gas/tax/slippage/failed-exit accounting remain.

| ATH threshold | Net P&L | Change vs 90% | Win rate | Failed exits | Fixed screening P&L |
|---|---:|---:|---:|---:|---:|
| 75% | $4,250.02 | $-407.76 | 21.71% | 1,131 | $4,462.20 |
| 80% | $4,385.29 | $-272.49 | 22.37% | 1,016 | $4,584.41 |
| 85% | $4,293.87 | $-363.91 | 22.69% | 975 | $4,490.26 |
| 90% | $4,657.79 | $+0.00 | 24.40% | 821 | $4,852.52 |
| 95% | $5,987.68 | $+1,329.89 | 29.76% | 377 | $6,183.26 |
| 96% | $6,093.14 | $+1,435.35 | 30.26% | 332 | $6,288.62 |
| 97% | $6,137.13 | $+1,479.34 | 30.53% | 309 | $6,332.28 |
| 98% | $6,148.03 | $+1,490.25 | 30.66% | 299 | $6,344.35 |
| 99% | $6,140.98 | $+1,483.19 | 30.66% | 298 | $6,337.29 |

All variants enter 6,200 positions. The fixed screening column retains the same 4,626 tokens selected by the previous full-sample Optuna rule; it is not reoptimized for each exit policy.

| ATH threshold | Liquidity disappeared | Honeypot | Trailing stop | Time stop | Stop loss | Unknown-blocked P&L |
|---|---:|---:|---:|---:|---:|---:|
| 75% | 1115 | 16 | 957 | 3860 | 252 | $-3,902.76 |
| 80% | 1000 | 16 | 1089 | 3843 | 252 | $-3,927.06 |
| 85% | 959 | 16 | 1137 | 3836 | 252 | $-3,923.93 |
| 90% | 805 | 16 | 1294 | 3833 | 252 | $-3,912.14 |
| 95% | 361 | 16 | 1739 | 3832 | 252 | $-3,894.43 |
| 96% | 316 | 16 | 1784 | 3832 | 252 | $-3,897.14 |
| 97% | 293 | 16 | 1807 | 3832 | 252 | $-3,891.37 |
| 98% | 283 | 16 | 1817 | 3832 | 252 | $-3,893.99 |
| 99% | 282 | 16 | 1819 | 3831 | 252 | $-3,894.58 |

98% has the highest net P&L of these nine settings in this sample. Its gain over 95% is $160.35 (2.68%). The 96–99% results are close: their net P&L range is only $54.90. Wider trailing stops leave more positions exposed when liquidity disappears.

The main results assume unavailable honeypot flags are clear, as in the original study; the unknown-blocked scenario is shown separately. All 6,770 trade records at 90% reproduce the existing baseline exactly. Twenty replay tests pass, including distinct trigger/fill blocks for the 80%, 85% and 90% ATH thresholds. All other variants use the same replay and cost inputs.

Reproduce each variant using `run.mjs --dataset DATASET.json --security-file SECURITY.json --delays 4 --take-profit-multiples 2.5 --trailing-ath-fraction FRACTION --output OUTPUT`, with FRACTION set to 0.75, 0.8, 0.85, 0.9, 0.95, 0.96, 0.97, 0.98 or 0.99. Individual ledgers and summaries are in local `.runtime/arc-backtest/trailingXX`, where XX is the ATH percentage.
