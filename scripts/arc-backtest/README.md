# Arc immediate baseline

Read-only research CLI with selectable block delays and take-profit policies. Stake is fixed at $2. Block delays are modeled execution latency from first active liquidity, not intentional waiting rules or production settings. No screening, signing, deployment, or production integration.

```sh
node scripts/arc-backtest/run.mjs --hours 72 --env-file .dev.vars
```

Requires the repository dependencies and installed `gmgn-cli`. Security uses the project `GMGN_API_KEY`, overriding the CLI's global key without changing credential files. Arc RPC defaults to the public endpoint; `ARC_RPC_URL` overrides it. Keep credential files and `.runtime/` outside Git.

Unresolved GMGN security fields use current GoPlus public contract reports, with AVE contract reports as an additional honeypot fallback when `AVE_API_KEY` is set. Both supplements are cached. A positive honeypot finding wins; tax priority is GMGN then GoPlus. No liquidity lock or holder screening is used. Provider quota/auth errors stop that supplemental provider and leave explicit missing data.

Raw RPC ranges and security responses are cached atomically. Resuming reuses the original captured security snapshots; use a new cache directory for a fresh study. Discovery ends 1,300 seconds behind the current head so all entries can have their 20-minute follow-up.

```sh
node scripts/arc-backtest/run.mjs \
  --dataset .runtime/arc-backtest/results/dataset.json \
  --security-file .runtime/arc-backtest/results/security.json \
  --output .runtime/arc-backtest/replay
```

Full session findings: [consolidated backtesting report](../../docs/reports/2026-10-03-arc-baseline-468-backtest.md).

Time stop: `--time-stop-minutes 20` (default). Optionally set `--time-stop-after-tp-minutes 20` or `30` to switch deadlines once partial TP actually fills; both deadlines are measured from entry. Longer timers need a dataset covering the full holding horizon; this session’s 15/20/25/30-minute runs use `dataset72h-30m.json` at `--trailing-ath-fraction 0.98`.

Trailing stop: `--trailing-ath-fraction 0.9` (default). Use `0.8` or `0.85` for a wider stop, retaining activation after take-profit and ATH since entry.

Model inputs: `--slippage-bps 50`, `--swap-gas-units 250000`, `--approval-gas-units 50000`. Gas price comes from the dataset's sampled Arc header. Slippage is an adverse fill haircut, separate from price impact and pool/token fees. A failed exit pays gas and writes off remaining inventory after one attempt. Active-range virtual reserves approximate concentrated-liquidity execution; this is not a forked-chain emulator.

Outputs: generated Markdown report, CSV comparison matrix, summary JSON and per-token fill ledger. Missing current security/taxes are retained with explicit optimistic/conservative scenarios, rather than dropping tokens. LP locking is not an exit rule.


For the full +4/+6/+8 block comparison:

```sh
node scripts/arc-backtest/run.mjs \
  --dataset .runtime/arc-backtest/dataset72h-enriched.json \
  --security-file .runtime/arc-backtest/security72h-gmgn.json \
  --delays 4,6,8 --take-profit-multiples 2.5,2 \
  --capture-entry-features --env-file .dev.vars \
  --output .runtime/arc-backtest/results468
```

Historical pool and Transfer logs use Arc RPC. When configured, Alchemy handles batched historical token metadata calls. Entry features are saved separately and joined to trades by `entryFeatureKey`, so screening rules can filter the existing ledger without another chain download or execution replay. See [feature definitions and offline filtering](features-README.md). To replay saved features, replace `--capture-entry-features` with `--features-file ENTRY_FEATURES.json`.

## Chain screening models

Train two LightGBM classifiers on the +4-block / 40% at 2.5x slice: positive net P&L and net loss greater than $0.10 (5% of stake). Only historical entry features enter the models. A chronological 60/20/20 token split purges the 20-minute holding horizon before validation and test. Model thresholds use validation only. Explicit five-feature rules use Optuna in the separate optimizer below.

```sh
python3 -m venv .runtime/arc-backtest/ml-env
.runtime/arc-backtest/ml-env/bin/pip install -r scripts/arc-backtest/requirements-ml.txt
.runtime/arc-backtest/ml-env/bin/python scripts/arc-backtest/train_screening.py \
  --input .runtime/arc-backtest/results468 \
  --output .runtime/arc-backtest/screening4 \
  --report docs/reports/2026-10-03-arc-chain-screening-lightgbm.md
.runtime/arc-backtest/ml-env/bin/python -m unittest discover -s test -p test_arc_screening.py
```

Outputs include two native LightGBM model files, held-out predictions, gain importance, precision/recall operating points, and screening effects on loss dollars, failed exits, heavy losses and retained P&L. Training labels follow the baseline's unknown-honeypot-clear case; retained P&L also shows the unknown-blocked case. Missing holder/fee treatment is explicit in each optimized rule. macOS LightGBM requires the OpenMP runtime (`libomp`).


Optimize an explicit rule with Optuna TPE, using USDC-side LP principal, its share of pool value, largest holder share, observed pool fee and market cap:

```sh
PYTHONDONTWRITEBYTECODE=1 .runtime/arc-backtest/ml-env/bin/python scripts/arc-backtest/optimize_rule.py \
  --input .runtime/arc-backtest/results468 \
  --output .runtime/arc-backtest/rule4 \
  --report docs/reports/2026-10-03-arc-explicit-screening-rule.md \
  --trials 5000 --seed 42
```

Repeat with seed 7 and a separate output directory for another TPE run. Select by fit-period P&L. The report distinguishes the development-selected rule's held-out result from fitting the entire observed sample. Native numeric rules can be evaluated offline through `apply_rule`; currency inputs and cutoffs use cents, shares six decimals, fees pips. Missing holder/fee behavior is explicit. No grid search is used.
