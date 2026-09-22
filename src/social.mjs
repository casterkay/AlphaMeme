import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { socialGate } from './scanner-parity.mjs';

const execFileAsync = promisify(execFile);

export { socialGate };

export async function xCapability() {
  try {
    const { stdout } = await execFileAsync('agent-reach', ['doctor', '--json'], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
    const result = JSON.parse(stdout)?.twitter || {};
    return {
      available: result.status === 'ok' && Boolean(result.active_backend),
      backend: result.active_backend || '',
      reason: result.active_backend ? result.message || '' : '未配置可用的X只读后端'
    };
  } catch {
    return { available: false, backend: '', reason: 'X只读检查暂时不可用，候选只能进入人工复核' };
  }
}
