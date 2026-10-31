import { randomBytes } from 'node:crypto';
import { emitKeypressEvents } from 'node:readline';
import { hash, Algorithm } from '@node-rs/argon2';
import { sql, closeDb } from '@paper/db';

async function readPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      'Run in an interactive terminal; passwords are never accepted as command-line arguments.',
    );
  process.stdout.write(prompt);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      process.stdin.removeListener('keypress', onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const onKey = (text: string | undefined, key: { name?: string; ctrl?: boolean }) => {
      if (key?.ctrl && key.name === 'c') {
        cleanup();
        reject(new Error('Cancelled.'));
        return;
      }
      if (key?.name === 'return' || key?.name === 'enter') {
        cleanup();
        resolve(value);
        return;
      }
      if (key?.name === 'backspace') {
        value = Array.from(value).slice(0, -1).join('');
        return;
      }
      if (text && !key?.ctrl && !/[\u0000-\u001f\u007f]/.test(text)) value += text;
    };
    process.stdin.on('keypress', onKey);
  });
}

try {
  const username = process.argv[2]?.trim().toLowerCase();
  if (!username || process.argv.length !== 3)
    throw new Error('Usage: node --import tsx scripts/reset-password.ts <username>');
  const password = await readPassword('New password (input hidden): ');
  const confirmation = await readPassword('Confirm new password: ');
  if (password.length < 12 || password.length > 128)
    throw new Error('Use a password of 12–128 characters.');
  if (password !== confirmation) throw new Error('Passwords do not match.');
  const passwordHash = await hash(password, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  const auditId = randomBytes(8).toString('hex');
  await sql.begin(async (tx) => {
    const users = await tx`select id from users where username = ${username} for update`;
    if (!users[0]) throw new Error('User does not exist.');
    await tx`update users set password_hash = ${passwordHash} where id = ${users[0].id}`;
    await tx`delete from sessions where user_id = ${users[0].id}`;
  });
  // The operator's protected terminal/log is the audit record; never log the password or hash.
  console.info(
    JSON.stringify({
      event: 'operator_password_reset',
      username,
      auditId,
      at: new Date().toISOString(),
      sessionsRevoked: true,
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Password reset failed.');
  process.exitCode = 1;
} finally {
  await closeDb();
}
