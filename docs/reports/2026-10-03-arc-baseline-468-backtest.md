# Arc full backtesting report: baseline, screening and exit-policy findings

Consolidated findings from the 2026-10-03 session. This is a read-only historical replay; no transactions, deployment or production integration. Original baseline generated at 2026-10-03T12:41:38.031Z.

## Findings that matter

- The 72-hour cohort contains 6,770 earliest USDC-paired token/pool records, of which 6,200 funded. At the original 90% ATH stop, +4 blocks / 40% at 2.5x produced the highest net P&L in the six-cell delay/TP comparison: **$4,657.79**. Earlier entry outperformed +6/+8; 40% at 2.5x outperformed 50% at 2x despite a lower win rate.
- Tightening the post-TP trailing stop was the largest improvement tested: **98% ATH produced $6,148.03 unfiltered**, versus $4,657.79 at 90% (+$1,490.25, +32.0%). The 97–99% results form a close plateau; 98% beats 97% by only $10.91 and 99% by $7.06.
- Applying the existing full-sample Optuna entry rule unchanged to the 98% replay produced **$6,344.35 across 4,626 entries**. This is the highest observed 20-minute combination in this session. Both the rule and ATH choice were selected using this historical cohort; it is a fitted result, not held-out evidence.
- Low win rate largely reflects small losses: at 90% ATH, 3,969 of 4,687 losing positions lost at most $0.10; median loss was $0.0737. A 24.40% win rate still produced positive total P&L because winners outweighed those losses.
- Failed exits mainly came from liquidity disappearing: 805 cases versus 16 current honeypot flags at 90% ATH. Tightening to 98% reduced failed exits from 821 to 299, but **heavy-loss positions stayed at 537**, and aggregate loss dollars fell only $11.32. The P&L improvement primarily comes from higher positive-position gains.
- Entry-only LightGBM models ranked winners and >5% losses well on the chronological holdout (ROC AUC 0.929 / 0.911). High-precision winner screening caught 90.8% of failed exits but sacrificed enough winners to reduce total P&L. Classification quality, avoidance of failed exits and maximization of total P&L are different objectives.
- Optuna TPE found an explicit rule with 98.92% precision when rejecting negative positions, but only 33.22% negative-position recall and 3.9% failed-exit recall. Its observed 90%-ATH improvement was $194.73 (+4.18%); the separately development-selected rule improved held-out P&L by just $0.83.
- At 98% ATH, a **15-minute time stop** outperformed 20/25/30 minutes: **$6,224.55 unfiltered / $6,416.98 with fixed screening**, the highest observed combination tested. Its gain over 20 minutes is modest ($76.52 / $72.63); heavy-loss positions fall from 537 to 521. These timer comparisons also use the full observed cohort.
- Unknown honeypot flags materially affect conclusions: 2,988 tokens lack classification. The 98%-ATH unknown-blocked scenario is **−$3,893.99 unfiltered / −$1,649.26 with fixed screening**. Main-case P&L assumes those unknown flags are clear; taxes are available for every token.

## Dataset and scope

Discovery: **2026-09-30 15:58:45 to 2026-10-03 15:58:45 Asia/Taipei**, equivalent to 07:58:45Z on both dates. Follow-up ends 2026-10-03 16:19:25 Asia/Taipei (08:19:25Z). The cohort is the earliest native-USDC or ERC20-USDC paired pool per token created during the window across the two configured Arc Uniswap v3/v4 factories.

There are **947,660 ordered pool states**, 6,770 token/pool records, 6,200 funded records and 570 never funded. `never_funded` means the captured pool never had positive active liquidity and a valid price during capture: no simulated buy, stake or P&L. It is distinct from a funded pool whose liquidity disappears before a delayed entry or exit. At +8 blocks, seven funded records have no entry liquidity and pay modeled attempted-buy gas without opening a position.

Historical RPC pool events supply ordered prices, liquidity changes and fills. One-second candles were not substituted: OHLC alone loses within-candle ordering and liquidity-removal timing, both relevant to these very early entries and tight trailing stops. Historical token metadata and Transfer logs populate entry features; current provider security is separate.

## Execution model

The following rules describe the original six-cell comparison. Subsequent experiments change only the post-TP ATH threshold.

- One $2 purchase per token, at the end of block +4/+6/+8 after first active liquidity. No security or liquidity-size entry filter.
- Independent policies: 40% of original quantity at 2.5x; 50% of original quantity at 2x. After that fill, sell the remainder at 90% of ATH since entry. Hard stop at 50% of average entry cost per received token; time stop at 20 minutes after entry.
- Observe ordered pool events; fills use the state at the end of the next block. A full exit takes precedence over a partial take-profit when signals coincide. The timer runs without swaps.
- Active-range virtual reserves price the $2 buy and actual sell quantity, including pool fee, price impact, current token taxes and 0.50% adverse slippage on each fill. Historical markets do not react to our trades; no complete tick-crossing or hook emulator.
- Before the first dynamic-fee Swap, use that pool's first observed ordinary fee; when none exists, assume 0.30%. Current token security/taxes are applied throughout history.
- Gas: 250000 units per buy/sell/failed sell, 50000 units once before the first sell, at 20.00 USDC gwei from the sampled Arc header. Gas is additional to the $2 stake.
- A honeypot or zero active liquidity at execution makes the sale fail. One failed sale writes off remaining inventory and still pays approval/swap gas. LP lock and zero-valued can_sell/can_not_sell fields are unused.
- GMGN supplies current security/taxes. Available GoPlus contract reports supplement unresolved fields; AVE contract reports can supply an unresolved honeypot flag. A positive honeypot finding wins; tax priority is GMGN then GoPlus. AVE market flags are unused.
- Missing security/tax inputs are shown as scenarios: main result assumes missing flags are non-honeypot and missing taxes zero; conservative result assumes missing honeypot flags block selling and missing taxes are 100%. Tokens remain in the cohort. These are missing-data scenarios, not bounds on all execution-model error.
- Late funding without a complete 20-minute holding horizon is counted as incomplete_horizon, without a fabricated buy or sale.

A position is modeled as tradable when the entry state has valid price and positive active liquidity; size-aware reserve calculations produce the $2 fill. This replay does not fetch KyberSwap routes or execute through KyberSwap. Current security snapshots are assumed available throughout the replay for taxes and sale success; no GMGN index-time or post-entry lookup branch is modeled. Chain features are evaluated only at entry for the separate screening experiments.

## Security coverage

6200 current security snapshots (0 unavailable primary responses); 16 marked honeypot; 2988 have at least one missing/conflicting required field. Missing buy tax: 0; missing sell tax: 0.

LP lock is unused: it is not the same as whether a sale succeeds. Unknown honeypot flags stay explicitly unknown in evidence, even though the main-case simulation assumes them clear. Known honeypots fail their first sale attempt; remaining inventory is written off and failed gas is paid.

## Delay and take-profit comparison: 90% ATH

| Delay blocks (~seconds) | Take-profit | Entries | Win rate | Net P&L USD | EV/entry USD | Gas USD | Failed exits | Conservative P&L USD |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 4 (~2.03) | 40% at 2.5x | 6200 | 24.40% | 4657.79 | 0.75 | 77.55 | 821 | -3912.14 |
| 4 (~2.03) | 50% at 2x | 6200 | 26.65% | 4195.48 | 0.68 | 78.14 | 751 | -3960.60 |
| 6 (~3.04) | 40% at 2.5x | 6200 | 24.23% | 4583.05 | 0.74 | 77.50 | 833 | -3928.25 |
| 6 (~3.04) | 50% at 2x | 6200 | 26.35% | 4136.50 | 0.67 | 78.09 | 755 | -3982.85 |
| 8 (~4.06) | 40% at 2.5x | 6193 | 24.17% | 4535.69 | 0.73 | 77.39 | 833 | -3922.71 |
| 8 (~4.06) | 50% at 2x | 6193 | 26.22% | 4096.37 | 0.66 | 77.99 | 753 | -3984.85 |

These six settings were compared at 90% ATH. The later 98% result has only been replayed for +4 blocks / 40% at 2.5x; it has not been tested across the other delays or TP policies.

## Exit reasons in the original matrix

| Delay | Policy | Reasons (counts) |
|---|---|---|
| 4 | 40% at 2.5x | time_stop: 3833, trailing_stop: 1294, honeypot: 16, stop_loss: 252, liquidity_disappeared: 805, never_funded: 570 |
| 4 | 50% at 2x | time_stop: 3818, trailing_stop: 1404, honeypot: 16, stop_loss: 227, liquidity_disappeared: 735, never_funded: 570 |
| 6 | 40% at 2.5x | time_stop: 3827, trailing_stop: 1282, honeypot: 16, stop_loss: 258, liquidity_disappeared: 817, never_funded: 570 |
| 6 | 50% at 2x | time_stop: 3814, trailing_stop: 1397, honeypot: 16, stop_loss: 234, liquidity_disappeared: 739, never_funded: 570 |
| 8 | 40% at 2.5x | time_stop: 3830, trailing_stop: 1270, honeypot: 16, stop_loss: 260, liquidity_disappeared: 817, never_funded: 570, entry_no_liquidity: 7 |
| 8 | 50% at 2x | time_stop: 3817, trailing_stop: 1387, honeypot: 16, stop_loss: 236, liquidity_disappeared: 737, never_funded: 570, entry_no_liquidity: 7 |

## Why positions lost: +4 blocks / 40% at 2.5x / 90% ATH

| Final exit reason | Positions | Positive P&L | Negative P&L | Loss >5% | Loss ≥$1 | Net P&L |
|---|---:|---:|---:|---:|---:|---:|
| time_stop | 3,833 | 71 | 3,762 | 173 | 5 | $734.73 |
| trailing_stop | 1,294 | 1,293 | 1 | 0 | 0 | $4,866.03 |
| honeypot | 16 | 0 | 16 | 16 | 16 | $-32.18 |
| stop_loss | 252 | 1 | 251 | 251 | 251 | $-371.98 |
| liquidity_disappeared | 805 | 148 | 657 | 278 | 265 | $-538.82 |

There are 1,513 positive and 4,687 negative positions; 718 lose more than 5% of stake, and 537 lose at least $1. Final exit reason is not identical to profitability: 148 liquidity-disappearance positions still made money after an earlier partial TP, and one stop-loss position finished positive. The 821 failed exits contain 294 >5% losses and 281 ≥$1 losses; their combined net P&L is −$571.00.

Most negative positions finish by the time stop: 3,762 cases, of which 3,589 lose at most 5%. Pool fees, adverse slippage, gas, taxes and price movements are all included. Small modeled losses explain much of the low win rate; it should not be read as a honeypot rate.

## Entry-time features and meaning

20310 entry snapshots in entry-features.json, joined to trades by entryFeatureKey (token:delayBlocks). Features use only chain observations through their entry block. Missing fields remain null. Current security snapshots model trading taxes and sale success; they do not screen entries or populate historical entry features.

| Field | Available | Missing |
|---|---:|---:|
| token | 20310 | 0 |
| pool | 20310 | 0 |
| delayBlocks | 20310 | 0 |
| entryBlock | 18600 | 1710 |
| cutoff | 20310 | 0 |
| venue | 20310 | 0 |
| tokenDecimals | 18600 | 1710 |
| totalSupplyRaw | 18600 | 1710 |
| metadataStatus | 20310 | 0 |
| holderCount | 18411 | 1899 |
| top1HolderShare | 18411 | 1899 |
| top10HolderShare | 18411 | 1899 |
| initialMintRecipientShare | 18411 | 1899 |
| holderHistoryStatus | 20310 | 0 |
| featureStatus | 20310 | 0 |
| entryTimestamp | 18600 | 1710 |
| stateBlock | 18600 | 1710 |
| poolAgeBlocks | 18600 | 1710 |
| activeLiquidityRaw | 18600 | 1710 |
| activeVirtualQuoteReserveUsd | 18600 | 1710 |
| activeVirtualTokenReserveRaw | 18600 | 1710 |
| estimatedTradableDepthUsd | 18600 | 1710 |
| stakeToDepthRatio | 18593 | 1717 |
| poolQuotePrincipalUsd | 18600 | 1710 |
| poolTokenPrincipalRaw | 18600 | 1710 |
| poolSizeUsd | 18600 | 1710 |
| poolSizeMethod | 18600 | 1710 |
| liquidityPositionCount | 18600 | 1710 |
| priceUsdPerRawToken | 18600 | 1710 |
| priceUsdPerToken | 18600 | 1710 |
| marketCapUsd | 18600 | 1710 |
| marketCapMethod | 18600 | 1710 |
| observedPoolFeePips | 18543 | 1767 |
| dynamicFee | 18600 | 1710 |
| hooks | 18600 | 1710 |
| hasHooks | 18600 | 1710 |
| priorSwapCount | 18600 | 1710 |
| priorBuyCount | 18600 | 1710 |
| priorSellCount | 18600 | 1710 |
| priorBuyVolumeUsd | 18600 | 1710 |
| priorSellVolumeUsd | 18600 | 1710 |
| priorSuccessfulSellers | 18600 | 1710 |
| attributedSellSwaps | 18600 | 1710 |
| attributedSellTransactions | 18600 | 1710 |
| priorSellRouterCount | 18600 | 1710 |
| sellerEvidence | 18600 | 1710 |
| sellerAttributionCoverage | 18600 | 1710 |
| priceChangeSinceFirstLiquidity | 18600 | 1710 |

Among the 18,600 funded delay snapshots, pool principal/market cap are available for all, and holder counts/shares for 18,411; 189 funded snapshots lack sufficient token history. The remaining missing counts in the table include the 1,710 never-funded delay snapshots.

- USDC-side pool principal and total pool value reconstruct outstanding LP principal across all ranges at entry, excluding accrued fees. They are distinct from active-range virtual trading reserves and the shared v4 manager balance.
- Market cap is historical total supply times entry spot price, including supply held by custody/burn addresses. Largest holder share excludes pool/manager custody balances from the numerator and divides by total supply. The first mint recipient is an observable proxy, not a verified developer identity.
- Prior successful sellers count attributed token Transfer payers in transactions with successful sell swaps; some payers can be routers. Zero attributed sellers is not proof of sell blocking. These features had zero split gain in both models in this early-entry cohort.
- Pool fee is the fee observed by entry; a dynamic fee remains null until a historical swap supplies it. Current GMGN holder snapshots and later observations never backfill historical screening features. Missing values stay null until a rule makes an explicit accept/reject choice.

## Two LightGBM classifiers: 90%-ATH labels

Positive P&L means `netUsd > 0`; loss >5% means `netUsd < -$0.10`. Only the 6,200 entered +4-block / 40%-at-2.5x positions are used. Inputs are historical entry features and ratios; addresses, current security, future observations and exit outcomes are excluded.

Token-grouped chronological 60/20/20 split with a 1,201-second holding-horizon purge: **3,698 train / 1,210 validation / 1,240 test / 52 purged**. Validation selects operating thresholds; test stays untouched until evaluation. Models have 15 leaves, minimum 100 rows/leaf, learning rate 0.03, L2=5, and validation early stopping.

| Model | Test prevalence | Accuracy at 0.5 | ROC AUC | Average precision | Rounds |
|---|---:|---:|---:|---:|---:|
| positive_pnl | 29.2% | 86.5% | 0.929 | 0.853 | 279 |
| loss_over_5pct | 12.6% | 90.3% | 0.911 | 0.621 | 255 |

Accuracy alone is inflated by class imbalance, especially for the >5%-loss label. ROC AUC, average precision and actual retained portfolio P&L provide complementary evidence. These models were trained against **90% ATH outcomes**, not 98% ATH outcomes.

### Most important features

Normalized split gain measures model use; it does not give threshold direction or establish causality. Correlated features can substitute for one another.

| Rank | Positive-P&L model | Gain share | >5%-loss model | Gain share |
|---|---|---:|---|---:|
| 1 | poolQuotePrincipalUsd | 53.18% | quotePrincipalToPoolSize | 33.67% |
| 2 | quotePrincipalToPoolSize | 20.83% | poolSizeToMarketCap | 18.08% |
| 3 | top1HolderShare | 4.37% | top1HolderShare | 12.13% |
| 4 | activeVirtualQuoteReserveUsd | 3.74% | observedPoolFeePips | 10.79% |
| 5 | observedPoolFeePips | 3.36% | poolQuotePrincipalUsd | 9.45% |

Winner importance is dominated by USDC principal and its fraction of pool value. Loss importance is more distributed across USDC share, pool value / market cap, largest holder share and fee. Absolute pool size or market cap alone is less informative than these combinations. Prior successful-seller features had zero gain in this fitted cohort; requiring them at +4 blocks is not supported by the model results.

### Held-out screening tradeoffs

For the positive model, keep predicted positives; for the loss model, reject predicted positives. Validation target names do not promise the same precision/recall on test. Precision and recall refer to each model label; heavy losses mean at least $1 lost. The unfiltered test cohort has 1,240 entries and $792.52 net P&L.

| Model / validation target | Threshold | Test precision | Test recall | Kept entries | Kept P&L | Failed exits caught | Heavy losses caught | Loss dollars caught | Winners rejected |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| positive_pnl / default | 0.5000 | 84.2% | 66.3% | 285 | $656.51 | 81.7% | 83.1% | 85.2% | 33.7% |
| positive_pnl / max_f1 | 0.3722 | 64.4% | 87.0% | 489 | $833.02 | 32.6% | 41.9% | 52.7% | 13.0% |
| positive_pnl / precision_80 | 0.5183 | 90.5% | 65.7% | 263 | $659.68 | 90.8% | 85.3% | 87.6% | 34.3% |
| positive_pnl / precision_90 | 0.7249 | 94.1% | 61.3% | 236 | $621.76 | 90.8% | 91.9% | 92.0% | 38.7% |
| positive_pnl / recall_90 | 0.3722 | 64.4% | 87.0% | 489 | $833.02 | 32.6% | 41.9% | 52.7% | 13.0% |
| loss_over_5pct / default | 0.5000 | 61.1% | 63.5% | 1078 | $752.96 | 0.9% | 64.0% | 48.6% | 15.2% |
| loss_over_5pct / max_f1 | 0.3076 | 51.1% | 72.4% | 1019 | $620.78 | 16.5% | 72.8% | 56.3% | 22.4% |
| loss_over_5pct / precision_80 | 0.7833 | 84.4% | 17.3% | 1208 | $812.94 | 0.0% | 13.2% | 12.7% | 1.1% |
| loss_over_5pct / precision_90 | 0.8320 | 100.0% | 10.9% | 1223 | $814.00 | 0.0% | 6.6% | 7.7% | 0.0% |
| loss_over_5pct / recall_90 | 0.1678 | 32.9% | 89.7% | 814 | $564.67 | 87.2% | 90.4% | 74.9% | 40.6% |

The winner model at validation precision-80 achieved 90.5% test precision, caught 90.8% of failed exits and 87.6% of loss dollars, but rejected 34.3% of winners and reduced P&L to $659.68. Its max-F1 threshold retained $833.02 with weaker failure recall (32.6%). The loss model at default 0.5 caught 63.5% of >5% losses but only 0.9% of failed exits: many failed exits have already banked partial TP or have small final losses. At its precision-90 threshold, test precision was 100%, but based on only 17 rejected positions and 10.9% loss recall.

Combining winner max-F1 with loss precision-80 yielded $833.74 on test, catching 32.6% of failed exits and 43.4% of heavy losses. Combining winner precision-80 with loss recall-90 caught 91.3% of failed exits and 92.6% of heavy losses, but reduced P&L to $559.29 and rejected 44.5% of winners. None of these operating points simultaneously maximized precision, recall and total P&L.

## Explicit chain screening: Optuna TPE

The objective was **maximize total retained net P&L**, using only USDC-side principal, USDC principal / pool value, largest holder share, observed fee and market cap. Optuna 5.0.0 with TPE ran two seeds (42 and 7), 5,000 trials per seed for each of development and full-sample studies: **20,000 trials total**. Selection used fit-period P&L. No grid search remains. Currency inputs/cuts use cents and shares six decimal places, so published thresholds are directly executable.

### Best observed full-sample rule: fitted to 90% ATH

Buy only if all conditions hold; the holder OR applies only within its condition.

```text
0.000011 <= USDC principal / total pool value <= 0.5
Largest holder share <= 0.49942 OR holder share unavailable
Observed pool fee <= 10000 pips (1%); unavailable fee rejects
$300 <= market cap <= $9941.18
```

The search selected an absolute USDC-principal minimum of $0, so there is no useful additional absolute floor. The ratio interval is 0.0011%–50%; the holder ceiling is 49.942%. Missing-holder acceptance is a deliberate fitted choice, not a claim that missing data is safe.

| Full 72-hour evaluation at 90% ATH | Result |
|---|---:|
| Entries retained | 4,626 / 6,200 |
| Net P&L | $4,852.52 vs $4,657.79 (+$194.73, +4.18%) |
| Win rate | 32.34% vs 24.40% |
| Rejected negative / positive positions | 1,557 / 17 |
| Negative-rejection precision / recall | 98.92% / 33.22% |
| Failed exits rejected | 32 / 821 (3.9%) |
| Heavy losses / loss dollars caught | 13.6% / 19.1% |
| Winners rejected | 1.1% |
| Unknown-blocked P&L | −$1,669.39 |

The rule mostly removes small losing positions without removing many winners. It is not a high-recall filter for failed exits or large losses. The reported search maximum is the best found by TPE, not a proven global optimum.

### Development-selected rule and held-out evidence

A separate study fit the chronological train + validation population and kept the final test period out of selection. Its rule was:

```text
USDC principal >= $0.01
0 <= USDC principal / total pool value <= 0.5
Largest holder share <= 0.93 OR unavailable
Observed fee <= 10008 pips (1.0008%) OR unavailable
$254.82 <= market cap <= $9903.97
```

Development P&L was $4,013.84 versus $3,826.46; the true holdout retained 928 entries and produced **$793.35 versus $792.52 (+$0.83)**. Thus the explicit rule’s full-sample P&L gain did not materially reproduce in the held-out tail. The full-sample rule’s $812.65 on the same test subset is in-sample because that rule used the entire cohort during selection; it must not be presented as holdout performance.

## ATH trailing-stop comparison: +4 blocks / 40% at 2.5x

Only the trailing threshold changes; all entries, costs, 50% hard stop and 20-minute timer stay fixed. Trailing activates after partial TP and uses ATH since entry. The screening column applies the same previous full-sample Optuna rule, selected using 90%-ATH P&L, without reoptimizing it for any threshold.

| ATH stop | Net P&L | Win rate | Failed exits | Fixed screening P&L | Screened failed exits |
|---|---:|---:|---:|---:|---:|
| 75% | $4,250.02 | 21.71% | 1,131 | $4,462.20 | 1,099 |
| 80% | $4,385.29 | 22.37% | 1,016 | $4,584.41 | 984 |
| 85% | $4,293.87 | 22.69% | 975 | $4,490.26 | 943 |
| 90% | $4,657.79 | 24.40% | 821 | $4,852.52 | 789 |
| 95% | $5,987.68 | 29.76% | 377 | $6,183.26 | 345 |
| 96% | $6,093.14 | 30.26% | 332 | $6,288.62 | 300 |
| 97% | $6,137.13 | 30.53% | 309 | $6,332.28 | 277 |
| 98% | $6,148.03 | 30.66% | 299 | $6,344.35 | 267 |
| 99% | $6,140.98 | 30.66% | 298 | $6,337.29 | 266 |

98% has the highest observed P&L, with only a narrow advantage over 97% and 99%. The $6,344.35 screened result is $196.31 above the unfiltered 98% result. The ATH choice was selected after observing all these runs, so the plateau is stronger evidence than the exact winning percentage.

### What tightening the stop changed

| Outcome | 90% ATH | 98% ATH |
|---|---:|---:|
| Positive / negative positions | 1,513 / 4,687 | 1,901 / 4,299 |
| Failed exits | 821 | 299 |
| Liquidity-disappearance exits | 805 | 283 |
| Known-honeypot exits | 16 | 16 |
| Loss >5% positions | 718 | 705 |
| Loss ≥$1 positions | 537 | 537 |
| Aggregate loss dollars | $1,279.03 | $1,267.72 |
| Trailing-stop net P&L | $4,866.03 | $6,376.87 |
| Time-stop net P&L | $734.73 | $705.40 |

Failed exits fall 63.6%, but aggregate loss dollars fall only $11.32. Net P&L rises $1,490.25, of which about $1,478.93 comes from increased aggregate gains on positive positions. The hard stop and large-loss problem remain: **tightening the trailing stop improves winner exits far more than it removes catastrophic losses** in this replay.

## Considerable profits among positions exited by time stop

A final time-stop exit can close the remainder of a winning position that already filled partial TP. It does not mean the position never reached TP. Net profits below include all sells and modeled costs for the entire position.

| Time-stop outcome | 90% ATH | 98% ATH |
|---|---:|---:|
| All time-stop exits | 3,833 | 3,832 |
| Positive P&L | 71 | 70 |
| Net profit ≥$0.50 (25% of stake) | 50 | 49 |
| Net profit ≥$1 (50% of stake) | 43 | 42 |
| Net profit ≥$2 (100% of stake) | 37 | 36 |
| Sum of positive time-stop P&L | $1,063.88 | $1,034.55 |

The largest time-stop winner is the same at both thresholds: **$49.29 net profit on $2 stake**. Its partial TP returned $12.84, and the timer sold the remainder for $38.46; total proceeds were $51.30 before $2 stake and $0.016 gas. The top five time-stop profits were $49.29, $46.93, $46.85, $46.65 and $46.17. These are modeled next-block proceeds, not actual trades.

At 98% ATH, the 70 positive time-stop positions contribute $1,034.55, offset by $329.15 lost on 3,762 negative time-stop positions, leaving $705.40 net. Most time-stop exits are small losers, but the minority of large winners is economically meaningful. The timer comparison below evaluates 15/20/25/30 minutes at 98% ATH; the time-stop winner counts change because earlier or later timers also change which positions exit by another rule.

## Time-stop comparison: 98% ATH

The original dataset already contains longer histories for earlier launches. Five entries needed a later endpoint for the 30-minute test. Arc RPC supplied 51 additional ordered states over blocks 24,020,323–24,021,504, extending capture to **2026-10-03 16:29:25 Asia/Taipei (08:29:25Z)**. Existing states, entry features, block-time/gas assumptions, current security and the 6,200 originally entered tokens stay fixed. Never-funded records do not become additional entries. Every 20-minute trade reproduces the previous 98%-ATH ledger exactly.

| Timer | Net P&L | Change vs 20m | Win rate | Failed exits | Loss ≥$1 count | Fixed screening P&L |
|---|---:|---:|---:|---:|---:|---:|
| 15m | $6,224.55 | $+76.52 | 30.90% | 296 | 521 | $6,416.98 |
| 20m | $6,148.03 | $+0.00 | 30.66% | 299 | 537 | $6,344.35 |
| 25m | $6,118.86 | $-29.18 | 30.60% | 300 | 540 | $6,316.80 |
| 30m | $6,075.82 | $-72.21 | 30.56% | 299 | 539 | $6,273.08 |

15 minutes gives the highest observed P&L: +$76.52 (+1.24%) unfiltered, or +$72.63 (+1.14%) screened, versus 20 minutes. At 15 minutes, 123 profitable time-stop exits include 84 with at least $1 net profit and 68 with at least $2. At 20 minutes those counts are 70 / 42 / 36; at 25 minutes, 46 / 20 / 15; at 30 minutes, 36 / 11 / 11. Longer timers allow some such winners to exit by the trailing stop instead, so final time-stop-category P&L alone is not a timer-performance comparison; total portfolio P&L is the relevant measure.

The 15-minute unknown-blocked result remains negative: −$3,820.38 unfiltered / −$1,576.51 screened. All four timers were tested at 98% ATH only, using the same existing screening rule. A complete ATH × timer search and held-out validation of the selected combined configuration were not performed.

## Pre-buy honeypot testing and tolerable simplifications

A stateful **buy → approve → sell simulation** using the intended wallet, router, pool and $2 amount can test current sell restrictions and actual returned USDC/sell tax. A quote-only sell request is weaker because it does not reproduce the balance and state created by the purchase. [Honeypot API documentation](https://docs.honeypot.is/ishoneypot) describes simulation success and buy/sell tax outputs. No such simulation was run or included in these results.

This test addresses current sell blocking; later liquidity disappearance is a separate mechanism. A successful-seller count is useful chain evidence when present, but is not a replacement for the intended transaction path. LP lock was excluded from the study after clarification.

The replay deliberately uses inexpensive active-range reserve fills instead of a full fork/tick-crossing/hook emulator. Gas comes from one sampled header; fills use a fixed 0.5% adverse slippage haircut plus size impact, pool fees and current token taxes. These are consistent assumptions across variants. Current security applied throughout history, missing honeypot flags, and the concentrated-liquidity approximation are the material assumptions; finer gas variation is secondary at $2 stake under this model. No routes were validated, no swaps signed, and no live tradability claim is made.

## Evidence, validation and reproduction

The original six-cell replay contains 40,620 trade records and 20,310 feature snapshots. Independent reviews reproduced the full matrix/features, LightGBM predictions and importance, both explicit rules, all rule metrics, and the maxima of four 5,000-trial CSVs. Original implementation checks passed 517 Node tests and five Python regression tests; after making ATH and time-stop thresholds configurable, all 24 replay tests passed, including timer and capture-horizon boundaries for 15/20/25/30 minutes. The 90% re-run reproduced every one of the 6,770 original records exactly.

| Artifact | Purpose |
|---|---|
| [This report’s JSON](2026-10-03-arc-baseline-468-backtest.json) | Original matrix, coverage and consolidated session diagnostics |
| [LightGBM report](2026-10-03-arc-chain-screening-lightgbm.md) | Full feature gains, operating points and combined filters; JSON companion |
| [Explicit screening report](2026-10-03-arc-explicit-screening-rule.md) | Exact rule thresholds, missing-data treatment and fit/holdout results; JSON companion |
| [Time-stop comparison report](2026-10-03-arc-time-stop-comparison.md) | Four timers at 98% ATH, time-exit profits, extended capture and missing-security scenarios; JSON companion |
| [ATH comparison report](2026-10-03-arc-ath-trailing-comparison.md) | All nine ATH settings, exit reasons and unknown-blocked scenarios; JSON companion |
| [Feature definitions](../../scripts/arc-backtest/features-README.md) | Historical feature semantics and offline joins |
| [Research CLI README](../../scripts/arc-backtest/README.md) | Reproduction commands and dependency versions |

Source evidence remains in local `.runtime/arc-backtest/`: `dataset72h-enriched.json`, `security72h.json`, `results468/`, native models/predictions in `screening4/`, four trial CSVs in `rule4/` and `rule4-seed7/`, merged best rules in `rule4-best/`, individual ledgers in `trailing75/` through the requested `trailing99/` variants, the extended `dataset72h-30m.json`, raw tail logs in `time-stop30-tail/`, and four timer ledgers in `time-stop15/`, `time-stop20/`, `time-stop25/`, `time-stop30/`. These runtime files are outside Git. The committed reports are projections of this evidence.

Replay the original matrix with `node scripts/arc-backtest/run.mjs --dataset DATASET.json --security-file SECURITY.json --delays 4,6,8 --take-profit-multiples 2.5,2 --trailing-ath-fraction 0.9 --features-file ENTRY_FEATURES.json --output OUTPUT`. Replay each ATH setting using `--delays 4 --take-profit-multiples 2.5 --trailing-ath-fraction FRACTION`, where FRACTION is 0.75, 0.8, 0.85, 0.9, 0.95, 0.96, 0.97, 0.98 or 0.99.

For timer reproduction, use the extended dataset and `--trailing-ath-fraction 0.98 --time-stop-minutes MINUTES` for MINUTES 15, 20, 25 or 30.

The best observed configuration among the settings tested is **+4 blocks, 40% at 2.5x, 98% ATH after TP, 50% hard stop and 15-minute time stop**, with the existing full-sample screening rule if optimizing observed total P&L. The session has not independently validated that combined configuration on a new cohort, retrained models for 98%-ATH labels, tested the full ATH × timer interaction, or tested other TP/delay combinations at 98%. The models and explicit-rule optimization retain their original 90%-ATH / 20-minute labels.
