import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import staticPlugin from '@fastify/static';
import { sql } from '@paper/db';
import { ApiError, accountObject, quoteObject } from './domain.js';
import { auth, authenticate, registerAuth, registerSessionStream } from './auth.js';
import { registerTrading } from './trading.js';
import { registerAnalytics } from './analytics.js';

const publicRoutes = new Set(['/api/auth/register', '/api/auth/login', '/api/health']);
export async function buildApp(options: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: process.env.LOG_LEVEL ?? 'info',
            redact: [
              'req.headers.cookie',
              'req.headers.authorization',
              'req.body.password',
              'res.headers["set-cookie"]',
            ],
          },
    bodyLimit: 64 * 1024,
    trustProxy: process.env.TRUST_PROXY === 'true',
    requestTimeout: 30_000,
  });
  await app.register(cookie);
  const liveStreams = new Set<() => void>();

  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'same-origin')
      .header('X-Frame-Options', 'DENY');
    const url = request.url.split('?')[0]!;
    if (!url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const contentType = request.headers['content-type'];
      if (contentType && !/^application\/(?:[a-z0-9.-]+\+)?json(?:\s*;|$)/i.test(contentType))
        throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send this request as JSON.');
      const configured = process.env.PUBLIC_ORIGIN ?? process.env.APP_ORIGIN;
      const expected = configured
        ? new URL(configured).origin
        : `${request.protocol}://${request.headers.host}`;
      const origin = request.headers.origin;
      if (origin && origin !== expected)
        throw new ApiError(403, 'ORIGIN_REJECTED', 'This request did not originate from the app.');
      const fetchSite = request.headers['sec-fetch-site'];
      if (fetchSite === 'cross-site')
        throw new ApiError(403, 'ORIGIN_REJECTED', 'Cross-site requests are not allowed.');
    }
    if (!publicRoutes.has(url)) await authenticate(request);
  });
  app.setErrorHandler((error: any, request, reply) => {
    if (error instanceof ApiError)
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    if (error.validation || error.statusCode === 400)
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: error.message ?? 'Check the submitted values.',
        },
      });
    if (error.statusCode === 413)
      return reply.code(413).send({
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'The submitted request is too large.' },
      });
    if (error.statusCode === 415)
      return reply
        .code(415)
        .send({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Send this request as JSON.' } });
    if (error.code === '23505')
      return reply
        .code(409)
        .send({ error: { code: 'CONFLICT', message: 'This record already exists.' } });
    request.log.error({ err: error }, 'request failed');
    return reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' },
    });
  });

  app.get('/api/health', async (_request, reply) => {
    try {
      await sql`select 1`;
      const [state] = await sql`select heartbeat_at,status from engine_state where id=1`;
      const engine = state && Date.now() - new Date(state.heartbeat_at).getTime() < 90_000;
      return { status: 'ok', database: 'ready', engine: engine ? 'ready' : 'offline' };
    } catch {
      return reply.code(503).send({ status: 'unavailable', database: 'offline' });
    }
  });
  await registerAuth(app);
  await registerTrading(app);
  await registerAnalytics(app);

  app.get('/api/stream', async (request, reply) => {
    const a = auth(request);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write('retry: 3000\n\n');
    let closed = false,
      busy = false;
    let cursor = /^\d+$/.test(String(request.headers['last-event-id'] ?? ''))
      ? String(request.headers['last-event-id'])
      : '0';
    const send = (name: string, data: unknown, id?: string) => {
      if (closed || reply.raw.destroyed) return;
      if (Date.now() >= a.expiresAt.getTime()) {
        close();
        return;
      }
      const frame = `${id ? `id: ${id}\n` : ''}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
      if (!reply.raw.write(frame)) {
        close();
      }
    };
    let unregisterSession = () => {};
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      clearTimeout(expiryTimer);
      unregisterSession();
      liveStreams.delete(close);
      reply.raw.end();
    };
    const tick = async () => {
      if (closed || busy) return;
      busy = true;
      try {
        const [session] =
          await sql`select s.id from sessions s join users u on u.id=s.user_id where s.id=${a.sessionId} and s.expires_at>now() and u.enabled=true`;
        if (!session) {
          close();
          return;
        }
        const events =
          await sql`select id,type,trade_id,payload from trade_events where account_id=${a.accountId} and id>${cursor}::bigint order by id limit 200`;
        for (const e of events) {
          cursor = String(e.id);
          send(
            e.type === 'FILLED'
              ? 'trade_filled'
              : e.type === 'EXITED'
                ? 'trade_exited'
                : 'trade_updated',
            { tradeId: e.trade_id, ...e.payload },
            cursor,
          );
        }
        const quotes =
          await sql`select distinct q.* from latest_quotes q join trades t on t.symbol=q.symbol where t.account_id=${a.accountId} and t.status in ('OPEN','PENDING')`;
        for (const q of quotes) send('price', { symbol: q.symbol, ...quoteObject(q) });
        send('feed_status', (await accountObject(a.accountId)).feed);
        reply.raw.write(': heartbeat\n\n');
      } catch (error) {
        request.log.warn({ err: error }, 'stream interrupted');
        close();
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void tick(), 3000);
    timer.unref();
    liveStreams.add(close);
    const expiryTimer = setTimeout(close, Math.max(0, a.expiresAt.getTime() - Date.now()));
    expiryTimer.unref();
    unregisterSession = registerSessionStream(a.sessionId, close);
    request.raw.on('aborted', close);
    reply.raw.on('close', close);
    send('snapshot', { account: await accountObject(a.accountId) });
    void tick();
  });

  const webRoot = process.env.WEB_ROOT ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
  if (existsSync(path.join(webRoot, 'index.html'))) {
    await app.register(staticPlugin, { root: webRoot, prefix: '/', index: false });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/'))
        return reply
          .code(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } });
      if (request.method !== 'GET' && request.method !== 'HEAD')
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Page not found.' } });
      return reply
        .header(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'",
        )
        .sendFile('index.html');
    });
    app.get('/', async (_request, reply) =>
      reply
        .header(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'",
        )
        .sendFile('index.html'),
    );
  } else {
    app.setNotFoundHandler(async (_request, reply) =>
      reply.code(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Endpoint not found. Build the web app to serve the interface.',
        },
      }),
    );
  }
  app.addHook('preClose', async () => {
    for (const close of [...liveStreams]) close();
  });
  return app;
}
