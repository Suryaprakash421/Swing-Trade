/** Optional local PostgreSQL 16 runner. Production uses the Compose database. */
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const databaseDir = path.resolve('.local/postgres');
mkdirSync(path.dirname(databaseDir), { recursive: true });
const port = Number(process.env.LOCAL_DB_PORT ?? 55432);
const database = new EmbeddedPostgres({
  databaseDir,
  port,
  user: 'paperlane',
  password: 'local-development-only',
  authMethod: 'scram-sha-256',
  persistent: true,
  autoRehydrateSymlinks: true,
  postgresFlags: ['-h', '127.0.0.1', '-k', '/tmp'],
  onLog: () => {},
  onError: (error) => console.error(String(error)),
});
if (!existsSync(path.join(databaseDir, 'PG_VERSION'))) await database.initialise();
await database.start();
const admin = database.getPgClient('postgres', '127.0.0.1');
await admin.connect();
try {
  await admin.query('CREATE DATABASE papertrade');
} catch (error: any) {
  if (error.code !== '42P04') throw error;
} finally {
  await admin.end();
}
console.log(`Local PostgreSQL is ready on 127.0.0.1:${port}.`);
console.log(
  'Development DATABASE_URL: postgresql://paperlane:local-development-only@127.0.0.1:' +
    port +
    '/papertrade',
);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await database.stop();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
setInterval(() => {}, 60_000);
