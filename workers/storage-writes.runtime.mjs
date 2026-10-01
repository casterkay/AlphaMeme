import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

const HOT_LIST_SIZE = 100;
const PASSING = 10;
const WARM_UP_CYCLES = 6;
const MEASURED_CYCLES = 20;
// Cloudflare bills each SQL row written and each setAlarm() call. A steady-state
// cycle over this hot list billed 159 rows while unchanged scheduler,
// notification and audit-queue rows were rewritten, and bills 59 once they are
// skipped: 34 fixed SQL rows (scheduler lease and alarm state, the cycle
// checkpoint, AVE admission, feed and health snapshots), 5 alarms, and one
// refreshed lead and one refreshed queue row per passing token. Alerts are on
// by default, so the notification baseline also refreshes each alerted lead's
// quiet time, about 10 rows a cycle more (69). Restoring any one of the removed
// rewrites costs at least 20 rows a cycle, so this bound bites.
const MAX_ROWS_PER_CYCLE = 75;

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

/** A hot list whose first PASSING tokens pass the AVE market screen; the rest fail on market cap. */
function hotList() {
  const nowSec = Math.floor(Date.now() / 1000);
  return Array.from({ length: HOT_LIST_SIZE }, (_, index) => ({
    token: `0x${(index + 1).toString(16).padStart(40, '0')}`, chain: 'arc', symbol: `T${index}`, name: 'Arc test token',
    current_price_usd: '0.5', market_cap: index < PASSING ? '50000' : '1000', main_pair_tvl: '12000',
    token_tx_volume_usd_5m: '800', updated_at: nowSec - 1, launch_at: nowSec - 600
  }));
}

/** Counts billed rows per statement (and per scheduler_state key), plus one per setAlarm(), while enabled. */
function rowsWrittenMeter(storage) {
  const { sql } = storage, exec = sql.exec, setAlarm = storage.setAlarm;
  const cursors = [];
  let enabled = false, alarms = 0;
  storage.setAlarm = function (...args) { if (enabled) alarms += 1; return setAlarm.apply(this, args); };
  sql.exec = function (query, ...args) {
    const cursor = exec.call(this, query, ...args);
    if (enabled) {
      const statement = query.replace(/\s+/g, ' ').trim().slice(0, 60);
      cursors.push({ label: /scheduler_state/.test(query) && /^INSERT/.test(statement) ? `scheduler_state ${args[1]}` : statement, cursor });
    }
    return cursor;
  };
  return {
    measure: async operation => { enabled = true; try { return await operation(); } finally { enabled = false; } },
    breakdown: () => cursors.reduce((totals, { label, cursor }) => {
      if (cursor.rowsWritten) totals[label] = (totals[label] || 0) + cursor.rowsWritten;
      return totals;
    }, alarms ? { setAlarm: alarms } : {}),
    restore: () => { sql.exec = exec; storage.setAlarm = setAlarm; }
  };
}

describe('Durable Object storage writes', () => {
  it('keeps a steady-state scan cycle over a 100-token hot list within the rows-written budget', async () => {
    const tenantId = '19040';
    const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
    const key = 'ave-radar-storage-writes-key';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      const target = String(url);
      if (target.startsWith('https://prod.ave-api.com/v2/tokens/trending?chain=arc')) return jsonResponse({ status: 1, data: { tokens: hotList() } });
      if (target.startsWith('https://prod.ave-api.com/v2/tokens/0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c-bsc')) {
        return jsonResponse({ status: 1, data: { token: { token: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', chain: 'bsc', current_price_usd: '600' }, pairs: [] } });
      }
      if (target.startsWith('https://api.telegram.org/')) return jsonResponse({ ok: true, result: { message_id: 1, date: 1, chat: { id: Number(tenantId), type: 'private' } } });
      return jsonResponse({}, 404);
    });

    try {
      await runInDurableObject(radar, async (instance, state) => {
        const meter = rowsWrittenMeter(state.storage);
        try {
          const now = Date.now();
          await instance.receiveTelegramCredential({
            tenantId, actorUserId: tenantId, updateId: '7', commandType: 'credential', payload: { source: 'message' },
            dueAt: now, messageDate: Math.floor(now / 1000), sourceMessageId: '70', locale: 'zh'
          }, `/setkey ${key}`);
          const scanCount = () => JSON.parse(state.storage.sql
            .exec('SELECT value_json FROM scheduler_state WHERE tenant_id = ? AND key = ?', tenantId, 'runtime.global').toArray()[0]?.value_json ?? '{"scanCount":0}').scanCount;
          // Release the scan cadence and AVE spacing between alarms instead of waiting them out; these test writes are not counted.
          const release = async () => {
            const { tasks } = await instance.getSchedulerSnapshot(tenantId);
            await instance.replaceSchedulerTasks({ tenantId, tasks: tasks.map(task => ({ ...task, dueAt: Math.min(task.dueAt, Date.now()) })) });
            await instance.setAveAdmissionState({ tenantId, state: { ...(await instance.getAveAdmissionState(tenantId)), spacingReadyAt: 0 } });
          };
          const runCycles = async (cycles, measured) => {
            const target = scanCount() + cycles;
            for (let step = 0; scanCount() < target; step++) {
              if (step >= cycles * 40) throw new Error(`scheduler did not finish ${cycles} scan cycles within ${cycles * 40} alarms`);
              await release();
              await (measured ? meter.measure(() => instance.alarm()) : instance.alarm());
            }
          };

          await runCycles(WARM_UP_CYCLES, false);
          expect((await instance.getStatus(tenantId)).control).toMatchObject({ configured: true, activeChain: 'arc' });
          expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM candidates WHERE tenant_id = ? AND status IN ('LIVE_READY', 'X_REVIEW')", tenantId).one().count).toBe(PASSING);
          await runCycles(MEASURED_CYCLES, true);
          const breakdown = meter.breakdown();
          const rowsPerCycle = Object.values(breakdown).reduce((sum, rows) => sum + rows, 0) / MEASURED_CYCLES;
          expect(breakdown.setAlarm, 'setAlarm is billed and must be metered').toBeGreaterThan(0);
          expect(rowsPerCycle, JSON.stringify(breakdown)).toBeLessThanOrEqual(MAX_ROWS_PER_CYCLE);
        } finally {
          meter.restore();
        }
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
