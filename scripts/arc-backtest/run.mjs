#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { collectArc } from './collect.mjs';
import { collectSecurity, readJson, writeJson } from './security.mjs';
import { supplementSecurity } from './supplement.mjs';
import { DEFAULT_COSTS, DELAYS, POLICIES, runMatrix, normalizeSecurity } from './replay.mjs';

const { values } = parseArgs({ options: {
  hours: { type: 'string', default: '72' }, end: { type: 'string' }, dataset: { type: 'string' },
  'security-file': { type: 'string' }, cache: { type: 'string', default: '.runtime/arc-backtest/cache' },
  output: { type: 'string', default: '.runtime/arc-backtest/results' },
  'env-file': { type: 'string', default: '.dev.vars' }, report: { type: 'string' },
  'slippage-bps': { type: 'string', default: '50' }, 'swap-gas-units': { type: 'string', default: '250000' },
  'approval-gas-units': { type: 'string', default: '50000' },
  delays: { type: 'string', default: DELAYS.join(',') },
  'take-profit-multiples': { type: 'string', default: POLICIES.map(policy => policy.multiple).join(',') },
  'trailing-ath-fraction': { type: 'string', default: '0.9' },
  'capture-entry-features': { type: 'boolean', default: false }, 'features-file': { type: 'string' }
} });
const number = (name, min, max) => {
  const value = Number(values[name]);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid --${name}`);
  return value;
};
const output = resolve(values.output), cache = resolve(values.cache);
const delays = [...new Set(values.delays.split(',').map(Number))];
if (!delays.length || delays.some(delay => !Number.isInteger(delay) || delay < 1 || delay > 20)) throw new Error('--delays must contain integers between 1 and 20');
const multiples = [...new Set(values['take-profit-multiples'].split(',').map(Number))];
const selectedPolicies = multiples.map(multiple => POLICIES.find(policy => policy.multiple === multiple));
if (!selectedPolicies.length || selectedPolicies.some(policy => !policy)) throw new Error('--take-profit-multiples must select 1.6, 2 or 2.5');
const trailingAthFraction = number('trailing-ath-fraction', 0.01, 1);
const policies = selectedPolicies.map(policy => ({ ...policy, trailingAthFraction }));
await mkdir(output, { recursive: true });
const progress = value => process.stderr.write(`${JSON.stringify(value)}\n`);
let variables = {};
if (!values.dataset || !values['security-file'] || values['capture-entry-features']) variables = parseEnv(await readFile(resolve(values['env-file']), 'utf8'));
const rpcUrl = variables.ARC_RPC_URL || 'https://rpc.mainnet.arc.io';
let dataset;
if (values.dataset) {
  dataset = await readJson(resolve(values.dataset));
  if (!dataset) throw new Error('Dataset file not found');
} else {
  const end = values.end ? Date.parse(values.end) / 1000 : Math.floor(Date.now() / 1000) - 1300;
  if (!Number.isFinite(end)) throw new Error('Invalid --end ISO timestamp');
  dataset = await collectArc({ rpcUrl, fromTimestamp: end - number('hours', 0.1, 720) * 3600, toTimestamp: end,
    cacheDirectory: join(cache, 'rpc'), onProgress: progress });
  await writeJson(join(output, 'dataset.json'), dataset);
}
let snapshots;
if (values['security-file']) {
  snapshots = await readJson(resolve(values['security-file']));
  if (!snapshots) throw new Error('Security snapshot file not found');
} else {
  // An unfunded pool cannot create a position; security calls for it add no information.
  const tokens = dataset.pools.filter(pool => pool.states.some(point => BigInt(point.liquidity) > 0n)).map(pool => pool.token);
  snapshots = await collectSecurity(tokens, { apiKey: variables.GMGN_API_KEY, cacheDirectory: join(cache, 'security'), onProgress: progress });
  snapshots = await supplementSecurity(snapshots, { cacheDirectory: join(cache, 'supplement'), aveApiKey: variables.AVE_API_KEY, onProgress: progress });
  await writeJson(join(output, 'security.json'), snapshots);
}
const costs = { ...DEFAULT_COSTS,
  gasPriceUsdPerUnit: Number(BigInt(dataset.manifest.sampledBaseFeePerGas)) / 1e18,
  slippageBps: number('slippage-bps', 0, 9999), swapGasUnits: number('swap-gas-units', 1, 10_000_000),
  approvalGasUnits: number('approval-gas-units', 0, 1_000_000) };
let entryFeatures = [];
if (values['features-file']) {
  entryFeatures = await readJson(resolve(values['features-file']));
  if (!Array.isArray(entryFeatures)) throw new Error('Entry features file must contain an array');
} else if (values['capture-entry-features']) {
  const { deriveEntryFeatures } = await import('./features.mjs');
  const metadataRpcUrl = variables.ALCHEMY_API_KEY ? `https://arc-mainnet.g.alchemy.com/v2/${variables.ALCHEMY_API_KEY}` : rpcUrl;
  entryFeatures = await deriveEntryFeatures(dataset, { delays, rpcUrl, metadataRpcUrl, cacheDirectory: join(cache, 'entry-features'), onProgress: progress });
}
if (entryFeatures.length) await writeJson(join(output, 'entry-features.json'), entryFeatures);
const { rows, trades } = runMatrix(dataset, snapshots, costs, { delays, policies, entryFeatures });
const securitySummary = { queried: Object.keys(snapshots).length, unavailableResponses: 0, honeypots: 0, incomplete: 0, missingBuyTax: 0, missingSellTax: 0 };
for (const snapshot of Object.values(snapshots)) {
  if ((snapshot.providers?.gmgn ?? snapshot).status === 'unavailable') securitySummary.unavailableResponses++;
  const normalized = normalizeSecurity(snapshot.data);
  if (normalized.honeypot === true) securitySummary.honeypots++;
  if (Object.values(normalized).some(value => value === null)) securitySummary.incomplete++;
  if (normalized.buyTax === null) securitySummary.missingBuyTax++;
  if (normalized.sellTax === null) securitySummary.missingSellTax++;
}
const featureCoverage = {};
const featureFields = new Set(entryFeatures.flatMap(feature => Object.entries(feature)
  .filter(([, value]) => value === null || typeof value !== 'object').map(([name]) => name)));
for (const name of featureFields) {
  const available = entryFeatures.filter(feature => feature[name] !== null && feature[name] !== undefined).length;
  featureCoverage[name] = { available, missing: entryFeatures.length - available };
}
const summary = { generatedAt: new Date().toISOString(), manifest: dataset.manifest, costs, securitySummary, configuration: { delays, policies }, entryFeatureCount: entryFeatures.length, featureCoverage, rows };
await writeJson(join(output, 'summary.json'), summary);
await writeJson(join(output, 'trades.json'), trades);
const columns = ['delayBlocks', 'policy', 'entered', 'spentUsd', 'proceedsUsd', 'gasUsd', 'netUsd', 'conservativeNetUsd', 'evPerEntryUsd', 'winRate', 'failedExits', 'securityUnknown'];
const csvCell = value => typeof value === 'string' ? `"${value.replaceAll('"', '""')}"` : value ?? '';
await writeFile(join(output, 'matrix.csv'), `${columns.join(',')}\n${rows.map(row => columns.map(column => csvCell(row[column])).join(',')).join('\n')}\n`);
const fixed = value => value === null ? '—' : Number(value).toFixed(2);
const utc = seconds => new Date(seconds * 1000).toISOString();
const report = `# Arc immediate-entry baseline backtest\n\nGenerated: ${summary.generatedAt}. Research replay; no transactions sent.\n\n` +
  `Discovery window: ${utc(dataset.manifest.fromTimestamp)} to ${utc(dataset.manifest.toTimestamp)} (${fixed((dataset.manifest.toTimestamp - dataset.manifest.fromTimestamp) / 3600)} hours). Follow-up through ${utc(dataset.manifest.captureToTimestamp)}.\n\n` +
  `Scope: ${dataset.manifest.scope}. ${dataset.pools.length} distinct token/pool records; ${dataset.manifest.fundedPools} funded and ${dataset.manifest.noFundedPools} never funded during capture.\n\n` +
  `## Execution model\n\n` +
  `- One $2 purchase per token, at the end of block ${delays.map(delay => `+${delay}`).join('/')} after first active liquidity. No security or liquidity-size entry filter.\n` +
  `- Independent policies: ${policies.map(policy => `${policy.fraction * 100}% of original quantity at ${policy.multiple}x`).join('; ')}. After that fill, sell the remainder at ${trailingAthFraction * 100}% of ATH since entry. Hard stop at 50% of average entry cost per received token; time stop at 20 minutes after entry.\n` +
  `- Observe ordered pool events; fills use the state at the end of the next block. A full exit takes precedence over a partial take-profit when signals coincide. The timer runs without swaps.\n` +
  `- Active-range virtual reserves price the $2 buy and actual sell quantity, including pool fee, price impact, current token taxes and ${fixed(costs.slippageBps / 100)}% adverse slippage on each fill. Historical markets do not react to our trades; no complete tick-crossing or hook emulator.\n` +
  `- Before the first dynamic-fee Swap, use that pool's first observed ordinary fee; when none exists, assume ${fixed(costs.dynamicFeePips / 10000)}%. Current token security/taxes are applied throughout history.\n` +
  `- Gas: ${costs.swapGasUnits} units per buy/sell/failed sell, ${costs.approvalGasUnits} units once before the first sell, at ${(costs.gasPriceUsdPerUnit * 1e9).toFixed(2)} USDC gwei from the sampled Arc header. Gas is additional to the $2 stake.\n` +
  `- A honeypot or zero active liquidity at execution makes the sale fail. One failed sale writes off remaining inventory and still pays approval/swap gas. LP lock and zero-valued can_sell/can_not_sell fields are unused.\n` +
  `- GMGN supplies current security/taxes. Available GoPlus contract reports supplement unresolved fields; AVE contract reports can supply an unresolved honeypot flag. A positive honeypot finding wins; tax priority is GMGN then GoPlus. AVE market flags are unused.\n` +
  `- Missing security/tax inputs are shown as scenarios: main result assumes missing flags are non-honeypot and missing taxes zero; conservative result assumes missing honeypot flags block selling and missing taxes are 100%. Tokens remain in the cohort. These are missing-data scenarios, not bounds on all execution-model error.\n` +
  `- Late funding without a complete 20-minute holding horizon is counted as incomplete_horizon, without a fabricated buy or sale.\n\n` +
  `## Security coverage\n\n${securitySummary.queried} current security snapshots (${securitySummary.unavailableResponses} unavailable primary responses); ${securitySummary.honeypots} marked honeypot; ${securitySummary.incomplete} have at least one missing/conflicting required field. Missing buy tax: ${securitySummary.missingBuyTax}; missing sell tax: ${securitySummary.missingSellTax}.\n\n` +
  `## Comparison matrix\n\n| Delay blocks (~seconds) | Take-profit | Entries | Win rate | Net P&L USD | EV/entry USD | Gas USD | Failed exits | Conservative P&L USD |\n|---|---|---:|---:|---:|---:|---:|---:|---:|\n` +
  rows.map(row => `| ${row.delayBlocks} (~${fixed(row.delayBlocks * dataset.manifest.blockSeconds)}) | ${row.policy} | ${row.entered} | ${fixed(row.winRate === null ? null : row.winRate * 100)}% | ${fixed(row.netUsd)} | ${fixed(row.evPerEntryUsd)} | ${fixed(row.gasUsd)} | ${row.failedExits} | ${fixed(row.conservativeNetUsd)} |`).join('\n') +
  `\n\n## Exit reasons\n\n| Delay | Policy | Reasons (counts) |\n|---|---|---|\n` +
  rows.map(row => `| ${row.delayBlocks} | ${row.policy} | ${Object.entries(row.exitReasons).map(([reason, count]) => `${reason}: ${count}`).join(', ')} |`).join('\n') +
  (entryFeatures.length ? `\n\n## Entry-time features\n\n${entryFeatures.length} entry snapshots in entry-features.json, joined to trades by entryFeatureKey (token:delayBlocks). Features use only chain observations through their entry block. Missing fields remain null. Current security snapshots model trading taxes and sale success; they do not screen entries or populate historical entry features.\n\n| Field | Available | Missing |\n|---|---:|---:|\n${Object.entries(featureCoverage).map(([name, coverage]) => `| ${name} | ${coverage.available} | ${coverage.missing} |`).join('\n')}\n` : '') +
  `\n\n## Reproduction\n\nRun \`node scripts/arc-backtest/run.mjs --dataset DATASET.json --security-file SECURITY.json --delays ${delays.join(',')} --take-profit-multiples ${multiples.join(',')} --trailing-ath-fraction ${trailingAthFraction}${entryFeatures.length ? ' --features-file ENTRY_FEATURES.json' : ''} --output OUTPUT\` to replay without network calls.\n\nOutputs: summary.json, matrix.csv and trades.json (every simulated buy, sell and failed exit), plus entry-features.json when requested. Raw RPC chunks and current security snapshots are resumable local evidence, kept outside Git.\n`;
await writeFile(join(output, 'report.md'), report);
if (values.report) {
  await writeFile(resolve(values.report), report);
  await writeJson(resolve(values.report).replace(/\.md$/, '.json'), summary);
}
process.stdout.write(`${JSON.stringify({ output, securitySummary, rows })}\n`);
