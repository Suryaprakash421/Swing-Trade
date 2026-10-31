import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { sql } from '@paper/db';
import { ApiError, bad } from './domain.js';

export interface Auth {
  userId: string;
  username: string;
  accountId: string;
  sessionId: string;
  expiresAt: Date;
}
export const auths = new WeakMap<FastifyRequest, Auth>();
const sessionStreams = new Map<string, Set<() => void>>();
export function registerSessionStream(sessionId: string, close: () => void) {
  const streams = sessionStreams.get(sessionId) ?? new Set<() => void>();
  streams.add(close);
  sessionStreams.set(sessionId, streams);
  return () => {
    streams.delete(close);
    if (!streams.size) sessionStreams.delete(sessionId);
  };
}
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const cookieName = 'paperlane_session';
const sessionSeconds = 7 * 24 * 60 * 60;
const hashOptions = { memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 };
let dummyHash: Promise<string> | undefined;
let activeHashes = 0;

async function boundedHash(password: string) {
  if (activeHashes >= 3)
    throw new ApiError(429, 'AUTH_BUSY', 'Please wait a moment and try again.');
  activeHashes++;
  try {
    return await hash(password, hashOptions);
  } finally {
    activeHashes--;
  }
}

export const cookieSettings = () => ({
  path: '/',
  httpOnly: true,
  secure:
    process.env.COOKIE_SECURE === undefined
      ? process.env.NODE_ENV === 'production'
      : process.env.COOKIE_SECURE === 'true',
  sameSite: 'strict' as const,
  maxAge: sessionSeconds,
});

export async function authenticate(request: FastifyRequest): Promise<Auth> {
  const token = request.cookies[cookieName];
  if (!token || !/^[a-f0-9]{64}$/.test(token))
    throw new ApiError(401, 'UNAUTHENTICATED', 'Please log in to continue.');
  const sessionId = tokenHash(token);
  const [row] = await sql`
    select s.id, s.expires_at, u.id as user_id, u.username, a.id as account_id
    from sessions s join users u on u.id = s.user_id join accounts a on a.user_id = u.id
    where s.id = ${sessionId} and s.expires_at > now() and u.enabled = true`;
  if (!row)
    throw new ApiError(401, 'UNAUTHENTICATED', 'Your session has ended. Please log in again.');
  const auth = {
    userId: row.user_id,
    username: row.username,
    accountId: row.account_id,
    sessionId,
    expiresAt: new Date(row.expires_at),
  };
  auths.set(request, auth);
  return auth;
}

export function auth(request: FastifyRequest) {
  const a = auths.get(request);
  if (!a) throw new ApiError(401, 'UNAUTHENTICATED', 'Please log in to continue.');
  return a;
}

async function consumeLimit(key: string, maximum: number) {
  const [limit] = await sql`
    insert into rate_limits (key, count, reset_at) values (${key},1,now() + interval '15 minutes')
    on conflict (key) do update set
      count = case when rate_limits.reset_at <= now() then 1 else rate_limits.count + 1 end,
      reset_at = case when rate_limits.reset_at <= now() then now() + interval '15 minutes' else rate_limits.reset_at end
    returning count`;
  if (limit.count > maximum)
    throw new ApiError(429, 'RATE_LIMITED', 'Too many attempts. Please try again in 15 minutes.');
}

async function setSession(reply: FastifyReply, userId: string, db: any = sql) {
  const token = randomBytes(32).toString('hex');
  await db`insert into sessions (id,user_id,expires_at) values (${tokenHash(token)},${userId},${new Date(Date.now() + sessionSeconds * 1000)})`;
  reply.setCookie(cookieName, token, cookieSettings());
}

export async function registerAuth(app: FastifyInstance) {
  const credentials = z
    .object({
      username: z
        .string()
        .trim()
        .toLowerCase()
        .min(3)
        .max(30)
        .regex(/^[a-z0-9_]+$/, 'Use letters, numbers, and underscores for your username.'),
      password: z.string().min(12, 'Use at least 12 characters for your password.').max(128),
    })
    .strict();
  app.post('/api/auth/register', async (request, reply) => {
    if (process.env.ALLOW_REGISTRATION === 'false' || process.env.REGISTRATION_ENABLED === 'false')
      throw new ApiError(403, 'REGISTRATION_CLOSED', 'New accounts are currently disabled.');
    await consumeLimit(`register:ip:${request.ip}`, 10);
    const parsed = credentials.safeParse(request.body);
    if (!parsed.success)
      bad(parsed.error.issues[0]?.message ?? 'Check your username and password.');
    const { username, password } = parsed.data;
    const passwordHash = await boundedHash(password);
    const userId = randomUUID(),
      accountId = randomUUID();
    try {
      await sql.begin(async (db) => {
        await db`insert into users (id,username,password_hash) values (${userId},${username},${passwordHash})`;
        await db`insert into accounts (id,user_id) values (${accountId},${userId})`;
        await db`insert into notification_preferences (account_id) values (${accountId})`;
        await setSession(reply, userId, db);
      });
    } catch (error: any) {
      if (error.code === '23505')
        throw new ApiError(409, 'USERNAME_TAKEN', 'That username is already in use.');
      throw error;
    }
    return reply.code(201).send({ user: { id: userId, username }, accountId });
  });

  app.post('/api/auth/login', async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
    await consumeLimit(`login:ip:${request.ip}`, 20);
    await consumeLimit(`login:user:${username.slice(0, 100)}`, 5);
    const parsed = credentials.safeParse(request.body);
    if (!parsed.success)
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Username or password is incorrect.');
    const [user] =
      await sql`select u.*, a.id as account_id from users u join accounts a on a.user_id = u.id where u.username = ${username}`;
    dummyHash ??= hash(randomBytes(24).toString('hex'), hashOptions);
    if (activeHashes >= 3)
      throw new ApiError(429, 'AUTH_BUSY', 'Please wait a moment and try again.');
    activeHashes++;
    let correct: boolean;
    try {
      correct = await verify(user?.password_hash ?? (await dummyHash), parsed.data.password);
    } finally {
      activeHashes--;
    }
    if (!user || !user.enabled || !correct)
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Username or password is incorrect.');
    await setSession(reply, user.id);
    return { user: { id: user.id, username: user.username }, accountId: user.account_id };
  });

  app.get('/api/auth/me', async (request) => {
    const a = auth(request);
    return { user: { id: a.userId, username: a.username }, accountId: a.accountId };
  });
  app.post('/api/auth/logout', async (request, reply) => {
    const sessionId = auth(request).sessionId;
    await sql`delete from sessions where id = ${sessionId}`;
    for (const close of [...(sessionStreams.get(sessionId) ?? [])]) close();
    reply.clearCookie(cookieName, {
      path: '/',
      httpOnly: true,
      secure: cookieSettings().secure,
      sameSite: 'strict',
    });
    return reply.code(204).send();
  });
}
