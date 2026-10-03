/** Scoring and scheduling defaults for the Worker scanner. */
export const scannerSettings = Object.freeze({
  // The target cadence; AVE admission stretches it when the monthly credit
  // allowance would otherwise run out before it resets.
  scanIntervalMs: 15_000,
  // GoPlus checks cost no AVE credits; bound them per cycle.
  maxSecondaryChecksPerCycle: 3,
  auditCycleBudgetMs: 60_000,
  // Historical one-minute candle backfills (10 credits each) are opt-in, as upstream.
  outcomeReadsPerCycle: 0,
  // A lead stays shown this long after the hot list last confirmed it.
  liveLeadRetentionMs: 30 * 60_000,
  minAgeSec: 5 * 60,
  maxAgeSec: 7 * 86400,
  discoveryMinMarketCap: 10_000,
  discoveryMaxMarketCap: 150_000,
  priorityMinMarketCap: 20_000,
  priorityMaxMarketCap: 80_000,
  minLiquidity: 3_000,
  // A new pool on the watchlist is screened only once it trades this much in 5 minutes,
  // within the market-cap band, above minLiquidity and at least minAgeSec old.
  onchainMinVolume5m: 300,
  onchainMinBuys5m: 5,
  strictLiquidity: 8_000,
  // Fast alerts should favor current activity. These are dynamic opportunity
  // gates, not permanent contract-risk exclusions.
  matureMarketAgeSec: 60 * 60,
  oldMarketAgeSec: 6 * 60 * 60,
  minMatureVolume5mUsd: 100,
  minOldVolume5mUsd: 250,
  minMatureTurnover5m: 0.005,
  minOldTurnover5m: 0.01,
  maxRugRatio: 0.20,
  maxTop10Rate: 0.30,
  maxInsiderRate: 0.15,
  maxBundlerRate: 0.15,
  maxSniperHoldRate: 0.08,
  maxBotHoldRate: 0.20,
  maxLinkedHoldRate: 0.10,
  maxBuyTax: 0.05,
  maxSellTax: 0.05,
  minLpLockedRate: 0.80,
  minOrdinaryWallets: 8,
  dynamicRecheckMs: 2 * 60_000,
  chainPassRecheckMs: 5 * 60_000,
  hardRejectRecheckMs: 6 * 60 * 60_000,
  queueRetentionMs: 24 * 60 * 60_000,
  candidateRetentionMs: 2 * 60 * 60_000,
  staleCandidateMs: 10 * 60_000,
  outcomeRetentionMs: 7 * 24 * 60 * 60_000,
});

/** Whether a settings object carries every key above as a finite number, as a cycle's snapshot must. */
export const completeScannerSettings = value => value !== null && typeof value === 'object'
  && Object.keys(scannerSettings).every(key => Number.isFinite(value[key]));
