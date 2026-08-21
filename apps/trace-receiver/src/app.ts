import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { DecodeError, decodeOtlpJson, type TraceStore } from '@ai-gateway/tracing';
import { SpanBatcher } from './batcher.js';
import { errorHandler } from '@ai-gateway/http';
import { timingSafeEqual } from './token-compare.js';

/**
 * 链路接收端 HTTP 面（内网服务）：
 *
 *   POST /v1/traces     OTLP/HTTP JSON（ExportTraceServiceRequest）→ 解码 → 批量入队
 *   GET  /readyz        DB 探活
 *   GET  /internal/stats 运行指标（received/flushed/dropped/queueDepth + 存储侧 stats）
 *
 * 错误语义：415=protobuf 不支持（当前只收 JSON）；401=令牌缺失/错误；
 *           400=OTLP 结构非法；2xx=已接收（best-effort 落库，过载丢弃见 stats）。
 */

export interface ReceiverAppDeps {
  db: Db;
  store: TraceStore;
  /** 共享令牌；未设置（开发内网）时放行 */
  token?: string;
  batcher: SpanBatcher;
}

export function createReceiverApp({ db, store, token, batcher }: ReceiverAppDeps): Hono {
  const app = new Hono();
  // 统一兜底：未分类异常（含 drizzle/pg 错误）→ 500 信封而非 Hono 默认纯文本
  app.onError(errorHandler());

  // G1：/v1/traces 请求体上限 8MB（OTLP JSON 批次远小于此；无上限则 c.req.json()
  // 整读任意体积 → OOM/存储耗尽）。放在令牌校验之后＝通过认证的调用方同样受限。
  app.use('/v1/traces', bodyLimit({ maxSize: 8 * 1024 * 1024 }));

  app.use('*', async (c, next) => {
    if (!token) return next();
    const auth = c.req.header('authorization') ?? '';
    if (!timingSafeEqual(auth, `Bearer ${token}`)) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid receiver token' } }, 401);
    }
    return next();
  });

  app.post('/v1/traces', async (c) => {
    const contentType = c.req.header('content-type') ?? '';
    if (contentType.includes('x-protobuf') || contentType.includes('protobuf')) {
      return c.json(
        {
          error: {
            code: 'UNSUPPORTED_MEDIA_TYPE',
            message: 'This receiver only supports OTLP/HTTP JSON (application/json); please configure the exporter to use the http/json protocol',
          },
        },
        415,
      );
    }
    if (!contentType.includes('json')) {
      return c.json(
        { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'content-type must be application/json' } },
        415,
      );
    }
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } }, 400);
    }
    let decoded;
    try {
      decoded = decodeOtlpJson(payload);
    } catch (error) {
      if (error instanceof DecodeError) {
        return c.json({ error: { code: 'INVALID_OTLP', message: error.message } }, 400);
      }
      throw error;
    }
    const droppedOverflow = batcher.push(decoded.rows);
    return c.json(
      { accepted: decoded.rows.length - droppedOverflow, skippedMalformed: decoded.skipped, droppedOverflow },
      202,
    );
  });

  app.get('/readyz', async (c) => {
    try {
      await db.execute(sql`select 1`);
      return c.json({ status: 'ok', dependencies: { postgres: 'up' } });
    } catch (error) {
      return c.json(
        { status: 'fail', dependencies: { postgres: 'down' }, error: (error as Error).message },
        503,
      );
    }
  });

  app.get('/internal/stats', async (c) => {
    const batcherStats = batcher.getStats();
    let storage: Awaited<ReturnType<TraceStore['stats']>> | null = null;
    try {
      storage = await store.stats();
    } catch {
      storage = null; // 存储查询失败不掩盖 batcher 指标
    }
    return c.json({ batcher: batcherStats, storage });
  });

  return app;
}
