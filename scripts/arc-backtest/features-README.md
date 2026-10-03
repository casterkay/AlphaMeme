Entry features are collected once per token and entry delay, independently of exit policy. Join a trade's `entryFeatureKey` to `${token}:${delayBlocks}`. Cutoff is the end of the historical entry block, immediately before the simulated purchase. Features contain no exit outcomes or current security snapshots.

- `activeLiquidityRaw` is the pool's active concentrated liquidity. `activeVirtualQuoteReserveUsd`, `activeVirtualTokenReserveRaw`, `estimatedTradableDepthUsd`, and `stakeToDepthRatio` describe the same active-range approximation used for $2 fills.
- `poolQuotePrincipalUsd`, `poolTokenPrincipalRaw`, and `poolSizeUsd` reconstruct outstanding liquidity-position principal across all ranges at the entry price, excluding accrued fees. `liquidityPositionCount` counts outstanding positions, including out-of-range positions. They are separate from active virtual reserves and from the shared v4 manager's token balances.
- `marketCapUsd` is historical `totalSupply()` times spot price, including supply held by custody or burn addresses. Each delay gets its own historical supply call. `tokenDecimals` is read at the earliest requested entry and treated as static token metadata.
- Swap counts and quote-denominated buy/sell volumes include successful pool events through the cutoff. `priorSuccessfulSellers` counts distinct token Transfer payers into the v3 pool or v4 manager in transactions containing a successful sell swap. These payers can be routers. `priorSellRouterCount` separately counts Swap senders. `sellerAttributionCoverage` shows the fraction of sell events with an attributable payer; zero attributed sellers does not imply that selling was impossible.
- Holder balances are reconstructed from token Transfer events only when `eth_getCode` is empty immediately before the query bucket: this proves the token's deployment is inside the captured history. Older tokens retain null holder fields. Unsupported/nonstandard transfer accounting also leaves holder fields null. No current GMGN holder snapshot is substituted.
- `holderCount` counts positive balances outside the pool/v4 manager; `top1HolderShare` and `top10HolderShare` divide those outside-custody balances by historical total supply. `initialMintRecipientShare` describes the first mint recipient, not a proven developer wallet.
- `observedPoolFeePips` is the fee known by entry. A dynamic pool's fee is null until its first historical Swap supplies a fee; later fees never fill this feature retroactively.

Use `featureStatus`, `metadataStatus`, and `holderHistoryStatus` when evaluating nulls. Null means unavailable; it is never silently treated as zero. Unfunded tokens remain represented with `featureStatus: never_funded`.

RPC inputs are cached atomically and replayable. Public Arc RPC supplies grouped historical Transfer queries. An optional `metadataRpcUrl` can route batched historical calls to Alchemy's Arc RPC, since the public endpoint limits the number of calls per batch. Credential URLs are never included in feature output.

Evaluate a screening idea offline without recapturing data (paths below refer to one saved result directory):

```js
import { readFile } from 'node:fs/promises';
import { summarizeTrades } from './replay.mjs';
const load = async name => JSON.parse(await readFile(`results/${name}.json`, 'utf8'));
const features = new Map((await load('entry-features')).map(row => [`${row.token}:${row.delayBlocks}`, row]));
const selected = (await load('trades')).filter(trade => {
  const entry = features.get(trade.entryFeatureKey);
  return trade.delayBlocks === 4 && trade.policy === '40% at 2.5x'
    && entry?.poolSizeUsd >= 1000 && entry?.priorSuccessfulSellers >= 2;
});
console.log(summarizeTrades(selected, 4, '40% at 2.5x'));
```

This example explicitly rejects unavailable feature values; choose missing-data treatment for each screening policy. The original unfiltered cohort remains available for comparison.
