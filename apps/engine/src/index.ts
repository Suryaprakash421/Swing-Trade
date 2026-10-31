import 'dotenv/config';
import { closeDb } from '@paper/db';
import { runEngine } from './engine.js';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
runEngine(controller.signal)
  .catch((error) => {
    console.error(
      JSON.stringify({
        level: 'error',
        message: error instanceof Error ? error.message : 'Engine failed',
      }),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
