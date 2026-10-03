# AVE and GMGN screening comparison

Date: 2026-10-03, Asia/Taipei. Status: research and recommendation; no provider migration implemented.

## Recommendation

**Use GMGN as the preferred source for holder-risk screening, subject to validation on the intended runtime. Do not replace AVE discovery solely on the basis of this probe.**

GMGN supplied developer exposure, sniper exposure, wallet classifications, and suspicious-holder flags that AVE's public API did not supply for the tested token. Its holder balances also agreed with AVE's. This is a concrete reason to restore a GMGN-backed screening path. It is not evidence that every GMGN security flag or aggregate is reliable, nor that its discovery feed finds opportunities sooner.

The proposed division of responsibility is AVE for existing discovery and market observations, GMGN for additional holder evidence, and separately validated contract evidence for security decisions. A full move to GMGN for discovery remains a candidate, to be decided by a comparison of discovery coverage, first-seen latency, availability, and cost from the intended deployment environment.

Neither provider's unresolved values should silently become a pass. Introduce new checks in shadow mode, measure their results, then enforce only checks whose semantics and coverage have been established. This recommendation follows the current [development plan](../DEVELOPMENT-PLAN.md); it does not change that plan or authorize implementation.

## Scope and evidence

The token is ArcStocks (ASTOCK) on Arc:

`0x4c9b47dbd5933aa4574b2c27f82419e4dbbd0222`

AVE search returned several same-name tokens. The selected address matches the Audit screenshot's `0x4c…0222`, the ASTOCK symbol, approximately $629K market capitalization, and approximately 1.51K holders. Identification used the address and market observations together, not the symbol alone.

Requests were made locally at approximately 13:11–13:13 on 2026-10-03, Asia/Taipei. Exact per-request timestamps were not recorded. The final response bundle was assembled afterward. Calls were sequential, not an atomic snapshot, and no production runtime was probed. This is a one-token case study, not a representative provider benchmark.

Both API keys came from `.dev.vars`. AVE was accessed through authenticated read-only HTTP requests; GMGN through the installed `gmgn-cli` version 1.6.4 with raw JSON output. GMGN raw output contains decoded response data, not the complete HTTP envelope. No keys, authentication headers, private keys, or RPC credentials are included in the report.

The companion [evidence JSON](2026-10-03-ave-gmgn-screening-evidence.json) preserves the complete AVE contract response and GMGN security object, selected market/statistical fields, all 100 sampled holder identities and risk fields from each provider, and the smart-money filtered rows. It intentionally excludes unrelated marketing text and detailed wallet transaction/P&L records. SHA-256 hashes identify the original successful response files retained during the probe; those scratch files are not required to reproduce the calculations from the companion data.

Local implementation context was inspected at revision `00fc8f6fd788a3af331ac17420b6ddc2b3c97009`. This is the inspected checkout revision, not a verified deployed revision.

## Endpoints probed

| Provider | Endpoint or CLI command | Outcome |
|---|---|---|
| AVE | `GET /v2/tokens?keyword=ASTOCK&chain=arc&limit=100` | Successful search after an initial 429 |
| AVE | `GET /v2/tokens/{address}-arc` | Token detail and five pairs |
| AVE | `GET /v2/contracts/{address}-arc` | Successful but incomplete contract report |
| AVE | `GET /v2/tokens/top100/{address}-arc` | 100 holders |
| AVE | `GET /v2/tokens/holders/{address}-arc?limit=100&sort_by=balance&order=desc` | 100 holders; no populated `new_tags` |
| GMGN | `token info --chain arc --address … --raw` | Successful token/market/statistics data |
| GMGN | `token security --chain arc --address … --raw` | Successful security data |
| GMGN | `token holders --chain arc --address … --limit 100 --raw` | 100 holders |
| GMGN | Same holder command with `--tag smart_degen` | 19 rows, all with zero current balances |

AVE's public REST documentation lists top-100 holders and contract risk at 10 CU each. The alternative holder endpoint is described in AVE's official client reference. Endpoint success here establishes local access for this key/token/chain only; it does not establish other chains' coverage or sustained throughput.

Sources: [AVE REST tokens](https://ave-cloud.gitbook.io/data-api/rest/tokens), [AVE v2 reference](https://docs.ave.ai/reference/api-reference/v2), [AVE official client reference](https://github.com/avecloud/ave-cloud-skill/blob/main/references/data-api-doc.md). These documents provide context; the companion JSON is the evidence for the live findings below.

## Base Info and holder classification

| Information | AVE live API | GMGN live API | Screening implication |
|---|---|---|---|
| Holder count | Token detail: 1,519 | `holder_count`: 1,519 | Agreement on this observation |
| Top-10 aggregate | Absent in the tested responses | `stat.top_10_holder_rate`: `"0.2207"`; same value in security and dev objects | Available, but aggregation rule needs clarification |
| Creator holdings | Creator ownership fields absent from contract report | `stat.creator_hold_rate`: `"0.0189"`; creator balance 18,900,000 | 1.89% of stated 1B supply |
| Dev-team holdings | No comparable field returned | `stat.dev_team_hold_rate`: `"0.0189466082"` | 1.89466082%; separate from creator-only exposure |
| Snipers | No comparable aggregate returned | 17 sniper wallets; `stat.top70_sniper_hold_rate`: `"0.0370190542"` | Count and 3.70190542% exposure are different quantities |
| Insiders | No comparable aggregate returned | Rat-trader wallets: 0; `stat.top_rat_trader_percentage`: `"0"` | Preserve the provider field; do not rename it to verified insider holdings |
| Bundlers | No comparable aggregate returned | Bundler wallets: 142; `stat.top_bundler_trader_percentage`: `"0"` | Count and aggregate cannot be treated as interchangeable |
| Cabal | No returned Cabal label or aggregate | `stat.top_entrapment_trader_percentage`: `"0.3475"` | 34.75% numerically; not established as equivalent to AVE Cabal |
| Smart money | No holder tags returned | `wallet_tags_stat.smart_wallets`: 37 | Current positive holdings not established by this count |
| Wallet classification | `new_tags` null for every sampled holder | `tags`, `maker_token_tags`, `is_suspicious`, address type and exchange | GMGN offers substantially richer row-level evidence |

AVE's screenshot showed Top10 24%, Dev 1.8%, Sniper/Insiders/Bundle 0, and Cabal 31%. Screenshots and probes were taken at different times, and provider definitions may differ. This report does not attribute each numeric difference to a bug. In particular, AVE Cabal and GMGN entrapment must remain separate provider concepts until their definitions are verified.

GMGN did not return `rug_ratio`, `is_wash_trading`, or a dedicated `suspected_insider_hold_rate` in the tested info/security responses. A switch therefore would not automatically restore every field expected by the legacy deep audit.

### Balances agree; Top 10 definitions remain unresolved

The two unfiltered holder lists contained the same 100 addresses. Every matched holding ratio agreed within an absolute tolerance of `1e-12`. This is strong agreement between the two snapshots; it is not independent on-chain verification, and common upstream sourcing was not investigated.

AVE's first ten rows sum to **33.1997887549%**, including the burn address and a holder GMGN identifies as an exchange/pool address. Removing only the zero and dead addresses, then taking the first ten remaining rows, gives **27.9907013031%**. Summing the ten largest rows GMGN classifies as ordinary addresses (`addr_type == 0`) gives **22.4864184358%**. GMGN's published aggregate is **22.07%**.

These are explicitly different computations. Neither the ordinary-address sum nor the provider aggregate can be asserted to reproduce AVE's 24% UI figure. Sorting, exclusions, denominator, aggregate update time, and address classification need verification before a concentration threshold is enforced. Preserve the chosen definition alongside the value.

### The screenshot's Cabal wallet

The screenshot highlighted `0x9564…72b2` at 2.66%. Both APIs returned the full address:

`0x95647f729d02bfbd8c161354b463ff05ecb772b2`

Both returned a holding ratio of approximately `0.026641495806341602`, or **2.66414958%**. AVE returned `new_tags: null`; GMGN returned `is_suspicious: true`, `maker_token_tags: ["top_holder"]`, and an empty general `tags` array. GMGN thus supplies a suspicion flag for the exact wallet, but does not establish the screenshot's Cabal attribution or any linked cluster.

Across the top-100 GMGN sample, six addresses were marked suspicious, with combined holdings of **10.9745959662%**. This is sample-scoped evidence, not a token-wide Cabal percentage. Sample token tags included seven bundler rows and three sniper rows; wallet-level tags included `sandwich_bot`, `fomo`, `gmgn`, and `fresh_wallet`.

### Smart-money filter and aggregate scope

GMGN's info response reported 37 smart wallets. Its `smart_degen` holder-filter request returned 19 addresses, each with current balance and holding ratio zero. The rows contained smart-money tags, but they did not demonstrate current positive exposure.

Possible explanations include historical membership, differences in aggregation scope, stale summaries, or endpoint behavior. None was established. A positive smart-money signal must require positive current balances and a known denominator; tagged participation alone is insufficient. An empty or zero-balance filter should not silently contradict or validate an aggregate count.

Similarly, 142 bundler wallets alongside a zero bundle aggregate is a reason to investigate scope and units, not proof that either value is fabricated. The local skill describes some trader percentages as volume-related. They must not be used as supply holdings without a confirmed contract.

## Audit panel versus actual security responses

| Screenshot concept | AVE contract response | GMGN security response | Interpretation |
|---|---|---|---|
| Risk assessment | `risk_score: 55`, `risk_level: 0` | No comparable score | AVE score matches screenshot; score semantics not validated |
| Contract identity | Matching token and Arc chain | Matching address | Correct token addressed |
| Creator | Absent | Available in token info | AVE contract report is incomplete for creator evidence |
| Owner/renunciation | Nonzero owner; `has_owner_removed_risk: 1` | `is_renounced: true`, `renounced: 1` | Unresolved disagreement with screenshot's retained-admin warning |
| Honeypot | `is_honeypot: -1` | `is_honeypot: false`, `honeypot: 0` | AVE enum semantics unresolved; GMGN claim is not execution proof |
| Open source | `has_code: 1` | `is_open_source: true`, `open_source: 1` | GMGN gives an explicit claim; AVE field meaning needs confirmation |
| Owner changing balances | `owner_change_balance: "0"` | No matching field returned | AVE capability evidence; not independently verified |
| Proxy | `is_proxy: "0"` | No matching field returned | AVE has a field GMGN omitted in this probe |
| Whitelist / blacklist | `has_white_method: 0`, `has_black_method: 0` | `is_blacklist: false`, `blacklist: 0` | Provider claims with different coverage |
| Minting | `has_mint_method: 0` | `renounced_mint: false` | Method availability and authority renunciation are different concepts |
| Reclaiming ownership | `can_take_back_ownership: "0"` | No matching field returned | AVE has additional contract fields |
| Buy / sell tax | Both fields absent | Both `"0"` | AVE cannot substantiate displayed zero taxes from this report |
| Holder count / ranks | Both absent | Count and concentration elsewhere | Screenshot's Holders(0) is not supported as a factual holder count |
| LP holder count / supply | `pair_holders: 0`, `pair_total: 0` | No directly equivalent complete LP inventory | Zero LP-holder evidence does not establish absence of pools |
| LP locking | Lock percentage absent | `lockInfo: null`; internally ambiguous `lock_summary` | No reliable normalized locked percentage established |
| Community votes | Support/opposition fields absent | Not returned | Not API-verified for this token |

AVE returned owner `0xfE661B0F0F14F1Aa7248f545Ce38e92a797d6D7c`, matching the screenshot and GMGN's creator address after case normalization. An on-chain `owner()` check was not completed: `.dev.vars` had no `ARC_RPC_URL`, and no alternate RPC was selected. Consequently this report does not declare either ownership interpretation correct.

GMGN's LP summary contains `is_locked: true`, a lock-detail entry with `percent: "0.95"` and a zero-address pool, while `lock_percent` and `left_lock_percent` are both `"0"`; `lockInfo` is null. These fields do not justify stating that 95% of this token's LP is locked. Pool identity and Uniswap v4 position semantics need verification. Likewise, GMGN's `can_sell: 0` and `can_not_sell: 0` do not establish a successful sell simulation.

### What is actually wrong with the Audit evidence?

The confirmed problem is incomplete and discordant API evidence. AVE's market response reports 1,519 holders and five pairs, while its contract response omits holder evidence and returns zero LP-holder totals. The contract response contains a DEX list, so `pair_holders: 0` is especially not synonymous with “no trading pairs.” Its main DEX entry reports approximately $11,528 liquidity, whereas token detail reports approximately $127,712 main-pair TVL. GMGN reports approximately $74,830 liquidity. Freshness, accounting, and provider methodology were not reconciled.

The screenshot displays zeros where the probed contract report has missing tax and holder fields. This is consistent with incomplete upstream audit coverage and UI defaults, but AVE frontend code/network traffic was not inspected. A specific frontend rendering defect or backend root cause is therefore an inference, not proven. The UI's honeypot wording also cannot settle what API value `-1` means.

The earlier documentation-only assessment was too optimistic about panel parity. Real responses show that documented fields can be absent for an actual Arc token. Successful HTTP status and `audited_by_ave: 1` are not completeness guarantees.

## Operational findings

The first AVE search returned HTTP 429 with `status: 2` and `msg: "too many requests"`; a later attempt succeeded. This demonstrates a local rate-limit event, not its exact cause, plan limit, or sustained capacity. The current application admission code has a minimum 15-second AVE gap. Adding holder/contract reads to that same lane would compete with discovery unless scheduling changes.

Initial GMGN commands returned HTTP 401 `AUTH_KEY_INVALID`. Inspection of the installed CLI showed that it loads `~/.config/gmgn/.env` with `override: true`, overwriting the process-supplied key. Loading the CLI configuration first, then assigning the `.dev.vars` key before command execution, resolved authentication. Neither credential file was changed. The earlier 401 was not evidence that the supplied project key was invalid.

An IPv6 diagnostic was inconclusive; the IPv6 echo request failed. No IPv6 root cause was established, and no network setting was changed. Successful GMGN calls after correcting key selection explain the relevant failure.

Existing project documentation records GMGN problems from Cloudflare egress and a proposed VPS migration. Those statements were not freshly tested here. Local success must not be promoted to deployed availability. Rate-limit handling, timeout/cancellation behavior, persistent admission, credential rotation, and recovery still require acceptance from the actual host.

## Implications for the current implementation

The current [AVE provider](../../src/providers/ave.mjs) projects market data and candles, leaving several risk fields unknown. It does not currently fetch the holder/contract endpoints used in this investigation. [AVE admission](../../src/ave-admission.mjs) owns spacing and credit pacing.

The legacy [security normalization](../../src/scoring/index.mjs) contains some GMGN-shaped fallbacks, but should not simply be reactivated unchanged:

- `securityView` can select rat/bundler trader percentages for rules expressed as holder exposure. Those units need confirmation before use.
- Its sniper exposure lookup does not include the live response's `info.stat.top70_sniper_hold_rate` location.
- The actual security object uses booleans and numeric flags, rather than uniformly returning the yes/no strings described in parts of the local skill.
- Rug and wash-trading evidence were absent in this sample; a provider switch cannot manufacture them.
- Wallet rows distinguish exchange/pool addresses from ordinary addresses. Concentration and suspicious-exposure calculations need explicit, recorded exclusions.

These are migration requirements, not fixes made by this report. Current production execution of legacy code was not established.

## Proposed rollout and acceptance criteria

1. **Validate GMGN from the intended runtime.** Use the project's credential, read-only routes, explicit timeouts, bounded idempotent retries, and durable rate admission. Cover Arc plus each intended scan chain, multiple token ages, busy and inactive tokens, and at least one known incomplete/security-risk case. Record auth failures, rate limits, missing fields, request latency, freshness, and recovery after restart.
2. **Define each screening input.** Preserve provider, original field, token/chain identity, capture time, upstream time when available, units, scope, and completeness. Represent clear, hit, and unknown separately. Verify Top10 exclusions, suspected-holder semantics, current versus historical membership, and Uniswap v4 LP interpretation.
3. **Add holder screening in shadow mode.** Start with positive current developer exposure, ordinary-address concentration under an explicit definition, suspicious sample exposure, and correctly scoped sniper/bundler evidence. Display unverified classifications as provider claims. Do not block initial discovery alerts on extra per-token requests under the current product contract.
4. **Evaluate outcomes before enforcement.** Measure how frequently new rules veto leads, how often evidence is absent or contradictory, false positives, and cohort outcomes using the project's outcome recorder. Choose enforcement thresholds from measured behavior, not the one ASTOCK sample.
5. **Benchmark discovery separately.** Compare AVE and GMGN on the same chains and period using first-seen times, market eligibility at discovery, unique useful leads, omissions, feed refresh, candle availability, request budgets, and runtime reliability. A wholesale switch requires evidence that GMGN meets the discovery and outcome-recording contracts.

The minimum useful migration is a GMGN holder-risk provider integrated after discovery, with independent contract evidence and explicit unknowns. It addresses the demonstrated information gap while keeping the broader discovery decision evidence-based. A full GMGN replacement may eventually be simpler, but removing AVE before validating discovery coverage, runtime access, and outcome sampling would exceed what this case study supports.

## Limits and reproducibility

No trading, signing, provider migration, deployment, or application-code change occurred. There was no on-chain audit, sell simulation, credentialed production test, cross-chain benchmark, or examination of AVE's private frontend endpoints. Neither Bubble graph edges nor exact Cabal/phishing labels were obtained. Sample suspicion and smart-money metrics are not token-wide estimates.

For recomputation, use `ave.holders[*].balance_ratio` and `gmgn.holders[*].amount_percentage` in the companion JSON. Match rows by lowercase address and compare ratios at tolerance `1e-12`. Sum the first ten AVE rows for the inclusive number; remove zero/dead addresses before taking ten for the burn-excluded number; select GMGN rows with `addr_type == 0` before taking ten for the ordinary-address number. Sum only sampled GMGN rows whose `is_suspicious` is true for sampled suspicious exposure. These calculations deliberately retain total-supply ratios rather than silently renormalizing the denominator.

The evidence JSON was checked for both API keys, parsed successfully, and checked against the report's counts and ratios. Application tests were not run because this change adds research documentation and evidence only.
