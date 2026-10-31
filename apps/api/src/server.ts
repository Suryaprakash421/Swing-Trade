import { migrate, closeDb } from '@paper/db';
import { buildApp } from './app.js';

await migrate();
const app = await buildApp();
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  try {
    await app.close();
    await closeDb();
    process.exitCode = 0;
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
try {
  await app.listen({ host: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
} catch (error) {
  app.log.error(error);
  await closeDb();
  process.exitCode = 1;
}
