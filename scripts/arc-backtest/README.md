# Arc immediate baseline

Read-only research CLI for the five entry delays and three exit policies discussed in the report. Stake is fixed at $2. No screening, signing, deployment, or production integration.

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

Model inputs: `--slippage-bps 50`, `--swap-gas-units 250000`, `--approval-gas-units 50000`. Gas price comes from the dataset's sampled Arc header. Slippage is an adverse fill haircut, separate from price impact and pool/token fees. A failed exit pays gas and writes off remaining inventory after one attempt. Active-range virtual reserves approximate concentrated-liquidity execution; this is not a forked-chain emulator.

Outputs: generated Markdown report, 15-row CSV matrix, summary JSON and per-token fill ledger. Missing current security/taxes are retained with explicit optimistic/conservative scenarios, rather than dropping tokens. LP locking is not an exit rule.
