# Arc chain-based screening: two LightGBM classifiers

Labels: positive net P&L (`netUsd > 0`) and loss greater than 5% of the $2 stake (`netUsd < -0.10`). Labels include all modeled costs. Only entered positions are trained; never-funded and failed-entry records are excluded. Main-case labels use the existing unknown-honeypot-clear assumption. Current security, addresses, exit outcomes and future observations are excluded from model inputs.

Only +4 blocks / 40% at 2.5x is evaluated, one row per token. Token-grouped chronological 60/20/20 split with a 1201-second holding-horizon purge before validation/test. Rows: {'train': 3698, 'test': 1240, 'validation': 1210, 'purged': 52}; tokens: {'train': 3698, 'validation': 1210, 'test': 1240, 'purged': 52}. Thresholds and simple rules are selected using validation only; test data is untouched until evaluation. All model inputs are chain observations at entry.

Two modest LightGBM models (15 leaves, minimum 100 rows/leaf, learning rate 0.03, L2=5, up to 1,000 rounds with 50-round early stopping); no test-driven tuning or class reweighting.

| Model | Test prevalence | Accuracy at 0.5 | ROC AUC | Average precision | Rounds |
|---|---:|---:|---:|---:|---:|
| positive_pnl | 29.2% | 86.5% | 0.929 | 0.853 | 279 |
| loss_over_5pct | 12.6% | 90.3% | 0.911 | 0.621 | 255 |

## Held-out operating points

For the positive model, keep predicted positives; for the loss model, reject predicted positives. Target names describe validation targets, not guaranteed test performance. Precision/recall refer to the model label. Loss dollars include all negative positions; heavy losses mean at least $1 lost.

| Model / validation target | Threshold | Test precision | Test recall | Kept entries | Kept P&L / baseline | Kept P&L unknown-blocked | Failed exits caught | Heavy losses caught | Loss dollars caught | Winners rejected |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| positive_pnl / default | 0.5000 | 84.2% | 66.3% | 285 | $656.51 / $792.52 | $-488.92 | 81.7% | 83.1% | 85.2% | 33.7% |
| positive_pnl / max_f1 | 0.3722 | 64.4% | 87.0% | 489 | $833.02 / $792.52 | $-548.05 | 32.6% | 41.9% | 52.7% | 13.0% |
| positive_pnl / precision_80 | 0.5183 | 90.5% | 65.7% | 263 | $659.68 / $792.52 | $-446.68 | 90.8% | 85.3% | 87.6% | 34.3% |
| positive_pnl / precision_90 | 0.7249 | 94.1% | 61.3% | 236 | $621.76 / $792.52 | $-472.69 | 90.8% | 91.9% | 92.0% | 38.7% |
| positive_pnl / recall_90 | 0.3722 | 64.4% | 87.0% | 489 | $833.02 / $792.52 | $-548.05 | 32.6% | 41.9% | 52.7% | 13.0% |
| loss_over_5pct / default | 0.5000 | 61.1% | 63.5% | 1078 | $752.96 / $792.52 | $-1262.48 | 0.9% | 64.0% | 48.6% | 15.2% |
| loss_over_5pct / max_f1 | 0.3076 | 51.1% | 72.4% | 1019 | $620.78 / $792.52 | $-1314.34 | 16.5% | 72.8% | 56.3% | 22.4% |
| loss_over_5pct / precision_80 | 0.7833 | 84.4% | 17.3% | 1208 | $812.94 / $792.52 | $-1210.40 | 0.0% | 13.2% | 12.7% | 1.1% |
| loss_over_5pct / precision_90 | 0.8320 | 100.0% | 10.9% | 1223 | $814.00 / $792.52 | $-1209.33 | 0.0% | 6.6% | 7.7% | 0.0% |
| loss_over_5pct / recall_90 | 0.1678 | 32.9% | 89.7% | 814 | $564.67 / $792.52 | $-909.93 | 87.2% | 90.4% | 74.9% | 40.6% |

## Feature importance

Normalized LightGBM split gain; correlated fields can share or substitute importance, so these scores describe model use rather than causal effects.

### positive_pnl

| Feature | Gain | Gain share |
|---|---:|---:|
| poolQuotePrincipalUsd | 23271.26 | 53.2% |
| quotePrincipalToPoolSize | 9117.88 | 20.8% |
| top1HolderShare | 1912.43 | 4.4% |
| activeVirtualQuoteReserveUsd | 1637.11 | 3.7% |
| observedPoolFeePips | 1470.76 | 3.4% |
| poolSizeToMarketCap | 947.29 | 2.2% |
| top10HolderShare | 924.97 | 2.1% |
| marketCapUsd | 882.37 | 2.0% |
| priorBuyVolumeUsd | 825.77 | 1.9% |
| priceChangeSinceFirstLiquidity | 699.78 | 1.6% |
| holderCount | 518.44 | 1.2% |
| initialMintRecipientShare | 398.56 | 0.9% |
| poolAgeBlocks | 391.47 | 0.9% |
| poolSizeUsd | 385.23 | 0.9% |
| hasHooks | 283.40 | 0.6% |
| dynamicFee | 44.65 | 0.1% |
| priorSwapCount | 29.83 | 0.1% |
| priorBuyCount | 21.64 | 0.0% |
| liquidityPositionCount | 0.00 | 0.0% |
| priorSellCount | 0.00 | 0.0% |
| priorSellVolumeUsd | 0.00 | 0.0% |
| priorSuccessfulSellers | 0.00 | 0.0% |
| attributedSellTransactions | 0.00 | 0.0% |
| priorSellRouterCount | 0.00 | 0.0% |
| sellerAttributionCoverage | 0.00 | 0.0% |
| isV4 | 0.00 | 0.0% |
### loss_over_5pct

| Feature | Gain | Gain share |
|---|---:|---:|
| quotePrincipalToPoolSize | 7781.19 | 33.7% |
| poolSizeToMarketCap | 4177.90 | 18.1% |
| top1HolderShare | 2803.28 | 12.1% |
| observedPoolFeePips | 2494.11 | 10.8% |
| poolQuotePrincipalUsd | 2183.71 | 9.4% |
| marketCapUsd | 734.19 | 3.2% |
| activeVirtualQuoteReserveUsd | 726.16 | 3.1% |
| top10HolderShare | 640.29 | 2.8% |
| poolAgeBlocks | 482.89 | 2.1% |
| poolSizeUsd | 410.37 | 1.8% |
| priceChangeSinceFirstLiquidity | 323.45 | 1.4% |
| priorBuyVolumeUsd | 192.59 | 0.8% |
| initialMintRecipientShare | 51.32 | 0.2% |
| holderCount | 40.64 | 0.2% |
| priorSwapCount | 35.15 | 0.2% |
| dynamicFee | 32.38 | 0.1% |
| liquidityPositionCount | 0.00 | 0.0% |
| hasHooks | 0.00 | 0.0% |
| priorBuyCount | 0.00 | 0.0% |
| priorSellCount | 0.00 | 0.0% |
| priorSellVolumeUsd | 0.00 | 0.0% |
| priorSuccessfulSellers | 0.00 | 0.0% |
| attributedSellTransactions | 0.00 | 0.0% |
| priorSellRouterCount | 0.00 | 0.0% |
| sellerAttributionCoverage | 0.00 | 0.0% |
| isV4 | 0.00 | 0.0% |

## Combined model filters

Both validation-selected gates applied together.

| Winner target / loss target | Kept entries | Kept P&L | Failed exits caught | Heavy losses caught | Loss dollars caught | Winners rejected |
|---|---:|---:|---:|---:|---:|---:|
| precision_80 / precision_80 | 263 | $659.68 | 90.8% | 85.3% | 87.6% | 34.3% |
| precision_80 / recall_90 | 215 | $559.29 | 91.3% | 92.6% | 92.7% | 44.5% |
| max_f1 / precision_80 | 486 | $833.74 | 32.6% | 43.4% | 53.9% | 13.3% |

## Simple chain rules

Single conditions use training-quantile cutoffs. Two-condition AND rules combine the best 16 distinct feature/direction conditions by validation F1. Final rules/targets use validation only. Winner rules KEEP matching positions; loss rules REJECT matching positions. Missing values never match a condition. A precision target absent below was unattainable on validation with at least 20 matches.

| Label / target | Condition | Test precision | Test recall | Failed exits caught | Heavy losses caught | Loss dollars caught | Winners rejected | Kept P&L |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| positive_pnl / max_f1 | poolQuotePrincipalUsd >= 204.007 AND quotePrincipalToPoolSize >= 0.219227 | 57.6% | 93.9% | 2.3% | 8.8% | 26.7% | 6.1% | $689.06 |
| positive_pnl / precision_80 | poolSizeToMarketCap >= 2 | 100.0% | 9.9% | 100.0% | 100.0% | 100.0% | 90.1% | $92.77 |
| positive_pnl / precision_90 | poolSizeToMarketCap >= 2 | 100.0% | 9.9% | 100.0% | 100.0% | 100.0% | 90.1% | $92.77 |
| loss_over_5pct / max_f1 | poolSizeToMarketCap <= 0.998382 AND quotePrincipalToPoolSize >= 0.00612842 | 60.9% | 62.8% | 0.0% | 66.2% | 49.2% | 16.9% | $735.59 |

Outputs: two native LightGBM model files, test-predictions.csv, full summary JSON and this report. Rerun train_screening.py against results468 with the isolated ml-env Python. Feature definitions remain in features-README.md.
