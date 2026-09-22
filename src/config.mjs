import { scannerSettings } from './scanner-settings.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export const config = Object.freeze({
  ...scannerSettings,
  port: boundedInteger(process.env.RADAR_PORT, 3791, 1024, 65_535),
  scanIntervalMs: boundedInteger(process.env.SCAN_INTERVAL_MS, scannerSettings.scanIntervalMs, 30_000, 30 * 60_000),
  maxDeepAuditsPerCycle: boundedInteger(process.env.MAX_DEEP_AUDITS_PER_CYCLE, scannerSettings.maxDeepAuditsPerCycle, 1, 12),
  stateDir: path.join(ROOT, 'state'),
  publicDir: path.join(ROOT, 'public')
});
