/** Full local integration/browser verification with an isolated real PostgreSQL 16 cluster. */
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';

const databaseDir = await mkdtemp('/tmp/paperlane-verify-');
const port = Number(process.env.VERIFY_DB_PORT ?? 55433);
const password = 'isolated-verification-only';
const database = new EmbeddedPostgres({
  databaseDir,
  port,
  user: 'paperlane',
  password,
  persistent: false,
  authMethod: 'scram-sha-256',
  autoRehydrateSymlinks: true,
  postgresFlags: ['-h', '127.0.0.1', '-k', '/tmp'],
  onLog: () => {},
  onError: (error) => console.error(String(error)),
});
const environment = {
  ...process.env,
  DATABASE_URL: `postgresql://paperlane:${password}@127.0.0.1:${port}/papertrade`,
  NODE_ENV: 'test',
  COOKIE_SECURE: 'false',
  APP_ORIGIN: 'http://127.0.0.1:3100',
  HOST: '127.0.0.1',
  PORT: '3100',
  NODE_USE_ENV_PROXY: '1',
  CHROMIUM_PATH: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
};
let api: ChildProcess | undefined;
async function run(command: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: environment });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`)),
    );
  });
}
try {
  await database.initialise();
  await database.start();
  // Use IPv4 explicitly instead of the package's localhost helper on IPv6-default hosts.
  const admin = postgres({
    host: '127.0.0.1',
    port,
    user: 'paperlane',
    password,
    database: 'postgres',
  });
  await admin.unsafe('CREATE DATABASE papertrade');
  await admin.end();
  console.log('Verification PostgreSQL 16 ready.');
  await run('npm', ['run', 'migrate']);
  await run('npm', ['run', 'typecheck']);
  await run('npm', ['test']);
  await run('npm', ['run', 'build']);
  api = spawn(process.execPath, ['--import', 'tsx', 'apps/api/src/server.ts'], {
    stdio: 'inherit',
    env: environment,
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:3100/api/health');
      if (response.ok) break;
    } catch {
      /* Server is starting. */
    }
    if (attempt === 99) throw new Error('API did not become ready');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await mkdir('.local/screenshots', { recursive: true });
  await run('npx', ['playwright', 'test']);
  console.log('Full local verification passed. Screenshots: .local/screenshots/');
} finally {
  if (api && api.exitCode === null) {
    api.kill('SIGTERM');
    await new Promise((resolve) => {
      api!.once('exit', resolve);
      setTimeout(resolve, 5000).unref();
    });
    if (api.exitCode === null) api.kill('SIGKILL');
  }
  await database.stop();
}
