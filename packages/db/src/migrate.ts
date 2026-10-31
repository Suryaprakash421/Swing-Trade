import { closeDb, migrate } from './index.js';

try {
  await migrate();
  console.log('Database migrations are up to date.');
} catch (error) {
  console.error(
    'Database migration failed:',
    error instanceof Error ? error.message : 'Unknown error',
  );
  process.exitCode = 1;
} finally {
  await closeDb();
}
