# Arc explicit five-feature screening rule: Optuna

+4 blocks / 40% at 2.5x, $2 stake, same fee/gas/tax/failed-exit accounting. Optuna 5.0.0, seeded TPE sampler, 10,000 trials per study. Objective: total retained net P&L. Thresholds are continuous quantiles of each study's fit population, converted to explicit numeric bounds; fees use observed discrete values. No grid search. Currency inputs and cuts are rounded to cents, shares to six decimals; this makes printed rules executable without floating-point boundary artifacts.

Development rule is selected before the held-out tail. Full-sample rule maximizes observed 72-hour P&L and its test-subset score is in-sample. Optuna reports the best rule found in this search, not a proven global maximum.

## development

Buy only when ALL conditions below hold. OR clauses apply within their individual holder/fee conditions. Values are token-specific at entry, before our purchase.

```text
USDC-side pool principal >= $0.01
0 <= USDC principal / pool value <= 0.5
Largest holder share <= 0.93 OR holder share unavailable
Observed pool fee <= 10008 pips (1.001%) OR pool fee unavailable
$254.82 <= market cap <= $9903.97
```

| Evaluation | Entries kept | Net P&L / baseline | Unknown-blocked P&L | Win rate | Failed exits caught | Heavy losses caught | Loss dollars caught | Winners rejected |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| development | 3672 | $4013.84 / $3826.46 | $-974.59 | 30.6% | 3.8% | 17.4% | 21.3% | 1.1% |
| test | 928 | $793.35 / $792.52 | $-756.56 | 37.5% | 1.8% | 20.6% | 23.6% | 3.9% |
| fullSample | 4637 | $4847.04 / $4657.79 | $-1761.06 | 32.1% | 3.3% | 18.1% | 21.7% | 1.7% |
## full_sample

Buy only when ALL conditions below hold. OR clauses apply within their individual holder/fee conditions. Values are token-specific at entry, before our purchase.

```text
USDC-side pool principal >= $0
1.1e-05 <= USDC principal / pool value <= 0.5
Largest holder share <= 0.49942 OR holder share unavailable
Observed pool fee <= 10000 pips (1%)
$300 <= market cap <= $9941.18
```

| Evaluation | Entries kept | Net P&L / baseline | Unknown-blocked P&L | Win rate | Failed exits caught | Heavy losses caught | Loss dollars caught | Winners rejected |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| development | 3644 | $4000.02 / $3826.46 | $-904.20 | 30.8% | 4.7% | 14.1% | 19.5% | 1.1% |
| test | 945 | $812.65 / $792.52 | $-735.28 | 37.9% | 1.8% | 12.5% | 18.1% | 1.1% |
| fullSample | 4626 | $4852.52 / $4657.79 | $-1669.39 | 32.3% | 3.9% | 13.6% | 19.1% | 1.1% |

Market cap is total supply times spot price. Pool value is reconstructed LP principal; USDC principal is its actual quote-side component, distinct from virtual trading reserves. Holder share excludes pool custody and divides by historical total supply. Fee pips: 10,000 = 1%. Heavy losses mean net loss of at least $1. Main optimization labels assume unknown honeypot flags are clear; unknown-blocked P&L is reported separately.

Exact thresholds and missing-value choices are in the JSON report. Study trials are retained as local CSV evidence.
