import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { DecodeError, decodeOtlpJson, type TraceStore } from '@ai-gateway/tracing';
import { SpanBatcher } from './batcher.js';

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

  app.use('*', async (c, next) => {
    if (!token) return next();
    const auth = c.req.header('authorization');
    if (auth !== `Bearer ${token}`) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: '缺少或错误的接收端令牌' } }, 401);
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
            message: '本接收端只支持 OTLP/HTTP JSON（application/json）；请配置导出器使用 http/json 协议',
          },
        },
        415,
      );
    }
    if (!contentType.includes('json')) {
      return c.json(
        { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'content-type 必须为 application/json' } },
        415,
      );
    }
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: { code: 'INVALID_JSON', message: '请求体不是合法 JSON' } }, 400);
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
