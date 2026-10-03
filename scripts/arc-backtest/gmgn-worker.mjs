// Keep CLI auth/config handling in the CLI; the project key wins after its global config loads.
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [entry, address] = process.argv.slice(2);
await import(pathToFileURL(join(dirname(entry), 'config.js')).href);
process.env.GMGN_API_KEY = process.env.ARC_BACKTEST_GMGN_KEY;
delete process.env.ARC_BACKTEST_GMGN_KEY;
delete process.env.GMGN_PRIVATE_KEY;
delete process.env.GMGN_DEBUG;
process.argv = [process.execPath, entry, 'token', 'security', '--chain', 'arc', '--address', address, '--raw'];
await import(pathToFileURL(entry).href);
