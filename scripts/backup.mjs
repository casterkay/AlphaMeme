// Nightly, inside the container: docker compose exec -T radar node scripts/backup.mjs
import { backupDatabases } from '../src/host/backup.mjs';

const dataDir = process.env.RADAR_DATA_DIR;
if (!dataDir) throw new TypeError('RADAR_DATA_DIR is required');
console.log(JSON.stringify({ event: 'backup_verified', ...backupDatabases({ dataDir }) }));
