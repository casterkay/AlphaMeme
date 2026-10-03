# Arc follow-up studies: conditional timers, pool age and delayed honeypot checks

Three separate experiments against the same control: **+4 blocks after first active liquidity, 40% of original quantity at 2.5x, 98% ATH since entry after TP, flat 15-minute time stop, 50% hard stop and $2 stake**. The existing full-sample Optuna rule is fixed. Control P&L is **$6,224.55 unfiltered / $6,416.98 screened**. No rule or model is retrained. Historical capture extends through 2026-10-03 16:29:25 Asia/Taipei, covering every requested deadline.

## 1. Different deadlines before and after TP fills

Both deadlines are measured from entry. A successful partial sale changes the applicable deadline to 20m or 30m; a signal or failed TP attempt does not. Until TP fills, exit at 5m, 10m or 15m. The 98%-ATH trail still exits earlier when triggered.

| TP not filled deadline | TP filled deadline | Unfiltered P&L | Fixed-rule P&L | Change vs flat 15m | Screened losses ≥$1 |
|---|---|---:|---:|---:|---:|
| 15m | 15m (control) | $6,224.55 | $6,416.98 | $0.00 | 451 |
| 5m | 20m | $5,888.71 | $6,081.69 | $-335.29 | 413 |
| 5m | 30m | $5,807.36 | $6,000.34 | $-416.64 | 413 |
| 10m | 20m | $6,077.83 | $6,270.02 | $-146.96 | 440 |
| 10m | 30m | $5,995.37 | $6,187.56 | $-229.42 | 440 |
| 15m | 20m | $6,155.81 | $6,348.24 | $-68.74 | 451 |
| 15m | 30m | $6,082.12 | $6,274.55 | $-142.43 | 451 |

**Flat 15m remains better.** The best split policy (15m unfilled / 20m filled) yields $6,348.24 screened, $68.74 below the flat 15m control; 15m / 30m loses $142.43. At the 5m cutoff, extending filled-TP positions to 20m improves over flat 5m, but still does not beat flat 15m. Twenty minutes beats 30 minutes for each unfilled deadline. The screened heavy-loss count is unchanged by switching 20m to 30m after TP; these changes mostly affect already-profitable positions.

## 2. Add pool age ≤30s, 60s or 90s to the fixed rule

As clarified by the user, age means **pool creation age**, not token contract deployment age. Use entry timestamp minus the pool’s original creation timestamp, with inclusive cutoffs. The original flat 15m control stays fixed. Entry age subtracts the historical pool-creation timestamp from the replay entry timestamp. As in the existing replay, entry blocks without pool events use sampled block-time interpolation; no current provider age is used.

| Maximum pool age at entry | Entries | Net P&L | Change vs no age limit | Win rate | Failed exits | Losses ≥$1 |
|---|---:|---:|---:|---:|---:|---:|
| None | 4626 | $6,416.98 | $0.00 | 41.03% | 267 | 451 |
| 30s | 4607 | $6,414.94 | $-2.04 | 41.15% | 267 | 451 |
| 60s | 4612 | $6,414.71 | $-2.27 | 41.11% | 267 | 451 |
| 90s | 4615 | $6,414.54 | $-2.44 | 41.08% | 267 | 451 |

The limits remove 19 / 14 / 11 positions, including two profitable positions in every case, but no failed exits, >5% losses or ≥$1 losses. Removed positions have net positive P&L of $2.04 / $2.27 / $2.44, so the age limits slightly reduce total P&L. **The age restriction adds no useful loss protection in this cohort.** Local `followup-studies/entry-age.json` retains the entry and pool-creation timestamps for all 6,200 entries.

## 3. Perfect honeypot check costing four additional blocks

“Modeled honeypots” are provider-flagged tokens whose labels are used by the replay, not tokens independently confirmed through buy→sell simulation. In this cohort, **all 16 flagged tokens have a positive honeypot flag in the saved GMGN token-security responses**. GoPlus and AVE supplement unresolved security fields, but add no further flagged tokens to these 16. The snapshots are current provider information applied throughout historical trading, not historical flags observed at each entry.

The replay makes those 16 tokens fail their first sale attempt and writes off the remaining inventory. No stateful buy→approve→sell simulation was performed. Another **2,988 tokens have unknown honeypot status**: the main case assumes they can sell; the separate unknown-blocked scenario assumes they cannot. The hypothetical perfect-check study rejects the 16 provider-flagged tokens before purchase; it does not establish how many of the unclassified tokens a real check would detect.

Assume the check rejects all 16 provider-flagged honeypots before buying, has no false positives, charges no gas/service fee, and adds four blocks (about 2.03s) to passed entries. The primary experiment screens at the original +4 decision, then delays those same approved tokens to +8. Thus the entry population cannot change merely because screening features improve during the check. Delay remains anchored to first active liquidity, as in prior studies; the age experiment separately uses pool creation.

| Entry delay | Perfect check | Unfiltered P&L | Same +4 approved tokens: P&L | Screened entries | Screened failed exits | Screened losses ≥$1 |
|---|---|---:|---:|---:|---:|---:|
| +4 | No | $6,224.55 | $6,416.98 | 4626 | 267 | 451 |
| +4 | Yes | $6,256.73 | $6,421.00 | 4624 | 265 | 449 |
| +8 | No | $6,095.51 | $6,294.62 | 4619 | 282 | 469 |
| +8 | Yes | $6,127.69 | $6,298.64 | 4617 | 280 | 467 |

**Not worth the delay under the modeled honeypot labels.** The fixed rule already rejects 14 of the 16 honeypots. Avoiding the remaining two saves $4.02, while delaying the same approved candidates costs $122.36; +8 with the check therefore loses **$118.34** versus +4 without it. Delayed entries also suffer seven failed entry attempts after liquidity disappears; those attempted-buy gas charges are included. Unfiltered, the check saves $32.18 against a $129.04 delay cost, leaving **$96.86 lower P&L**.

If the same rule is instead re-evaluated using +8 entry features, +8 without/with the check yields $6,337.87 / $6,341.89, still $75.09 below the +4 control. That secondary result changes the admitted set (4,654 / 4,652 entered positions) and is therefore shown separately from the primary pure-delay experiment.

The perfect check removes current modeled honeypot losses; it does not remove future liquidity-disappearance losses. Main-case unknown honeypot flags remain clear, as in the rest of this session. This answers the assumed-delay tradeoff for the 16 labeled honeypots rather than inventing outcomes for 2,988 unclassified tokens.

## Missing-security scenario

All main-case figures above assume unknown honeypot flags are clear. For reproducibility, the existing unknown-blocked scenario is retained separately. The check still only identifies the 16 provider-flagged honeypots; it is not silently assumed to identify every unknown.

| Setting | Screened unknown-blocked P&L |
|---|---:|
| Control flat 15m | $-1,576.51 |
| 5m before / 20m after TP | $-1,909.87 |
| 5m before / 30m after TP | $-1,991.23 |
| 10m before / 20m after TP | $-1,722.78 |
| 10m before / 30m after TP | $-1,805.24 |
| 15m before / 20m after TP | $-1,645.25 |
| 15m before / 30m after TP | $-1,718.94 |
| Pool age ≤30s | $-1,549.99 |
| Pool age ≤60s | $-1,558.10 |
| Pool age ≤90s | $-1,564.14 |
| +4 / check no, frozen admission | $-1,576.51 |
| +4 / check yes, frozen admission | $-1,572.49 |
| +8 / check no, frozen admission | $-1,588.00 |
| +8 / check yes, frozen admission | $-1,583.98 |

## Evidence and reproduction

The JSON companion contains exact rules, definitions, main/unknown-blocked outcomes, loss counts, rejected populations, both delayed-screening interpretations and TP-fill counts. Runtime evidence is in `.runtime/arc-backtest/`: six `tp-time-BEFORE-AFTER/` ledgers, `time-stop15/`, `honeypot-delay8/`, saved `results468/entry-features.json`, `dataset72h-enriched.json`, `dataset72h-30m.json`, `security72h.json`, and `followup-studies/summary.json` plus `entry-age.json`.

Reproduce conditional timers with `run.mjs --dataset DATASET72H-30M.json --security-file SECURITY.json --delays 4 --take-profit-multiples 2.5 --trailing-ath-fraction 0.98 --time-stop-minutes BEFORE --time-stop-after-tp-minutes AFTER --output OUTPUT`. BEFORE is 5/10/15, AFTER is 20/30. Both timers start at entry. Omitting the after-TP flag preserves the previous unconditional timer behavior.

Replay the delayed-entry control with `--delays 8 --time-stop-minutes 15` and no after-TP flag; apply the same +4 admitted token set and remove the known-honeypot set for the primary perfect-check result. The secondary result uses +8 features. Age-filter rows use the +4 control ledger and exact saved pool creation ages.

Thirty replay tests pass, including all six conditional timer combinations and the existing timer/horizon/TP/trailing execution boundaries. This is the same historical cohort used for earlier parameter choices; none of these follow-up results is new held-out validation. The best observed settings remain the simple flat 15-minute policy and the existing rule, with no age cutoff or added four-block check.
