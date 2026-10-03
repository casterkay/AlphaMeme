# Arc immediate-entry baseline backtest

Generated: 2026-10-03T12:41:38.031Z. Research replay; no transactions sent.

Discovery window: 2026-09-30T07:58:45.000Z to 2026-10-03T07:58:45.000Z (72.00 hours). Follow-up through 2026-10-03T08:19:25.000Z.

Scope: Earliest native-USDC or ERC20-USDC paired pool per token created in window, across the two configured Arc Uniswap v3/v4 factories; not token deployment or pre-migration curves. 6770 distinct token/pool records; 6200 funded and 570 never funded during capture.

## Execution model

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

## Security coverage

6200 current security snapshots (0 unavailable primary responses); 16 marked honeypot; 2988 have at least one missing/conflicting required field. Missing buy tax: 0; missing sell tax: 0.

## Comparison matrix

| Delay blocks (~seconds) | Take-profit | Entries | Win rate | Net P&L USD | EV/entry USD | Gas USD | Failed exits | Conservative P&L USD |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 4 (~2.03) | 40% at 2.5x | 6200 | 24.40% | 4657.79 | 0.75 | 77.55 | 821 | -3912.14 |
| 4 (~2.03) | 50% at 2x | 6200 | 26.65% | 4195.48 | 0.68 | 78.14 | 751 | -3960.60 |
| 6 (~3.04) | 40% at 2.5x | 6200 | 24.23% | 4583.05 | 0.74 | 77.50 | 833 | -3928.25 |
| 6 (~3.04) | 50% at 2x | 6200 | 26.35% | 4136.50 | 0.67 | 78.09 | 755 | -3982.85 |
| 8 (~4.06) | 40% at 2.5x | 6193 | 24.17% | 4535.69 | 0.73 | 77.39 | 833 | -3922.71 |
| 8 (~4.06) | 50% at 2x | 6193 | 26.22% | 4096.37 | 0.66 | 77.99 | 753 | -3984.85 |

## Exit reasons

| Delay | Policy | Reasons (counts) |
|---|---|---|
| 4 | 40% at 2.5x | time_stop: 3833, trailing_stop: 1294, honeypot: 16, stop_loss: 252, liquidity_disappeared: 805, never_funded: 570 |
| 4 | 50% at 2x | time_stop: 3818, trailing_stop: 1404, honeypot: 16, stop_loss: 227, liquidity_disappeared: 735, never_funded: 570 |
| 6 | 40% at 2.5x | time_stop: 3827, trailing_stop: 1282, honeypot: 16, stop_loss: 258, liquidity_disappeared: 817, never_funded: 570 |
| 6 | 50% at 2x | time_stop: 3814, trailing_stop: 1397, honeypot: 16, stop_loss: 234, liquidity_disappeared: 739, never_funded: 570 |
| 8 | 40% at 2.5x | time_stop: 3830, trailing_stop: 1270, honeypot: 16, stop_loss: 260, liquidity_disappeared: 817, never_funded: 570, entry_no_liquidity: 7 |
| 8 | 50% at 2x | time_stop: 3817, trailing_stop: 1387, honeypot: 16, stop_loss: 236, liquidity_disappeared: 737, never_funded: 570, entry_no_liquidity: 7 |

## Entry-time features

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


## Reproduction

Run `node scripts/arc-backtest/run.mjs --dataset DATASET.json --security-file SECURITY.json --delays 4,6,8 --take-profit-multiples 2.5,2 --features-file ENTRY_FEATURES.json --output OUTPUT` to replay without network calls.

Outputs: summary.json, matrix.csv and trades.json (every simulated buy, sell and failed exit), plus entry-features.json when requested. Raw RPC chunks and current security snapshots are resumable local evidence, kept outside Git.
