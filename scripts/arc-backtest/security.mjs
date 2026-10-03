import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rename, mkdir, realpath } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
const execute = promisify(execFile);

export async function writeJson(path, value) {
  await writeFile(`${path}.tmp`, `${JSON.stringify(value)}\n`);
  await rename(`${path}.tmp`, path);
}
export async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function cliEntry() {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    try { return await realpath(join(directory, 'gmgn-cli')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('Install gmgn-cli before collecting security snapshots.');
}

export async function collectSecurity(tokens, { apiKey, cacheDirectory, onProgress = () => {}, requestIntervalMs = 1000, concurrency = 1 }) {
  if (!apiKey) throw new Error('GMGN_API_KEY is required for security collection.');
  const entry = await cliEntry(), worker = fileURLToPath(new URL('./gmgn-worker.mjs', import.meta.url));
  await mkdir(cacheDirectory, { recursive: true });
  const snapshots = {};
  let cursor = 0, complete = 0, nextRequestAt = 0, halted = false;
  const workerLoop = async () => {
  while (!halted && cursor < tokens.length) {
    const token = tokens[cursor++];
    const path = join(cacheDirectory, `${token}.json`);
    let snapshot = await readJson(path);
    if (!snapshot) {
      const wait = Math.max(0, nextRequestAt - Date.now());
      nextRequestAt = Date.now() + wait + requestIntervalMs;
      await sleep(wait);
      try {
        const { stdout } = await execute(process.execPath, [worker, entry, token], {
          timeout: 25_000, maxBuffer: 1_000_000,
          env: { ...process.env, ARC_BACKTEST_GMGN_KEY: apiKey, GMGN_DEBUG: '' }
        });
        const data = JSON.parse(stdout);
        snapshot = { capturedAt: new Date().toISOString(), status: 'ok', data };
      } catch (error) {
        if (!['number', 'string'].includes(typeof error.code) && !(error instanceof SyntaxError)) throw error;
        const detail = String(error.stderr ?? '').split(apiKey).join('<redacted>');
        if (/429|RATE_LIMIT|AUTH_KEY|401|403/.test(detail)) {
          halted = true;
          throw new Error(`GMGN collection paused: ${detail.slice(0, 400)}`);
        }
        snapshot = { capturedAt: new Date().toISOString(), status: 'unavailable', error: error.killed ? 'timeout' : 'no_security_response', data: null };
      }
      await writeJson(path, snapshot);
    }
    snapshots[token] = snapshot;
    complete++;
    if (complete % 20 === 0 || complete === tokens.length) onProgress({ phase: 'security', complete, total: tokens.length });
  }
  };
  const results = await Promise.allSettled(Array.from({ length: concurrency }, workerLoop));
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  return snapshots;
}
