import { Hono } from 'hono';
import { pgSqlState } from '@tokenlens/db'; // 纯 SQLSTATE 分类函数(http errorHandler 的文档化注入点;非 Db 类型)
import { composeErrorCatalogs } from '@tokenlens/errors';
import { HttpErrors, bodyParserLimit, errorHandler, timingSafeTokenEqual } from '@tokenlens/http';
import {
  decodeOtlpJson,
  observabilityErrors,
  type SpanBatcher,
  type TraceStore,
  type TraceStoreStats,
} from '@tokenlens/observability';

/**
 * 链路接收端 HTTP 面（内网服务；v1 app.ts 平移,错误面入 v2 目录体系）。
 * 本文件是 app 非装配代码:不引用数据库连接类型、composition 或任何 adapter——
 * DB 探活以闭包注入(P5:app 只持有 facade 与纯契约类型)。
 *
 *   POST /v1/traces      OTLP/HTTP JSON（ExportTraceServiceRequest）→ 解码 → 批量入队
 *   GET  /readyz         DB 探活（K8s/compose healthcheck 不带 Bearer,豁免鉴权）
 *   GET  /internal/stats 运行指标（batcher 计数器 + 存储侧 stats）
 *
 * 错误语义：415=protobuf/非 JSON 不支持；401=令牌缺失/错误；413=请求体超限；
 *           400=坏 JSON 或 OTLP 结构非法（observability.invalid_otlp_payload）；
 *           202=已接收（best-effort 落库,过载丢弃见 stats）。
 */

export interface ReceiverAppDeps {
  /** DB 探活(readyz 用;装配绑定 ping(db),app 不接触 Db 类型) */
  pingDb: () => Promise<void>;
  store: TraceStore;
  batcher: SpanBatcher;
  /** 共享令牌;未配置（开发内网）时放行——生产强制由 config 层 fail-fast */
  token?: string;
  /** 5xx 服务端日志出口(pino 结构兼容;缺省静默) */
  logger?: { error(obj: Record<string, unknown>, msg?: string): void };
}

/** /v1/traces 请求体上限:OTLP JSON 批次远小于此;无上限则整读任意体积 → OOM/存储耗尽(v1 G1 语义) */
const TRACE_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

export function createReceiverApp(deps: ReceiverAppDeps): Hono {
  const app = new Hono();

  // 统一兜底:流动错误按 v2 目录渲染(http+observability 合成),PG SQLSTATE 探测注入
  app.onError(
    errorHandler({
      catalog: composeErrorCatalogs(HttpErrors, observabilityErrors),
      sqlState: pgSqlState,
      ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
    }),
  );

  // 放在令牌校验之后＝通过认证的调用方同样受限(v1 语义);超限 413 经 http 信封
  app.use('/v1/traces', bodyParserLimit(TRACE_BODY_LIMIT_BYTES));

  app.use('*', async (c, next) => {
    // 健康探针豁免鉴权:/readyz /livez 只返回探活状态、无敏感数据——
    // 若一并挡 401,compose/K8s healthcheck（不带 Bearer）会让容器永久 unhealthy
    if (c.req.path === '/readyz' || c.req.path === '/livez') return next();
    if (deps.token === undefined) return next();
    const auth = c.req.header('authorization') ?? '';
    if (!timingSafeTokenEqual(auth, `Bearer ${deps.token}`)) {
      throw HttpErrors.business('unauthorized'); // → 401(自有码 status 修正)
    }
    return next();
  });

  app.post('/v1/traces', async (c) => {
    const contentType = c.req.header('content-type') ?? '';
    // OTLP SDK 缺省走 protobuf——明确告知改配 http/json,这是最常见的接入错误
    if (contentType.includes('protobuf')) {
      throw HttpErrors.business('unsupported_media_type', {
        received: contentType,
        hint: 'configure the OTLP exporter to use the http/json protocol (application/json)',
      });
    }
    if (!contentType.includes('json')) {
      throw HttpErrors.business('unsupported_media_type', { received: contentType });
    }
    const payload: unknown = await c.req.json(); // 坏 JSON 抛 SyntaxError → onError → 400 http.invalid_json
    const decoded = decodeOtlpJson(payload); // 结构错误抛 business → 400 observability.invalid_otlp_payload(G6)
    const droppedOverflow = deps.batcher.push(decoded.rows);
    return c.json(
      {
        accepted: decoded.rows.length - droppedOverflow,
        skippedMalformed: decoded.skipped,
        droppedOverflow,
      },
      202,
    );
  });

  app.get('/readyz', async (c) => {
    try {
      await deps.pingDb();
      return c.json({ status: 'ok', dependencies: { postgres: 'up' } });
    } catch (error) {
      return c.json(
        { status: 'fail', dependencies: { postgres: 'down' }, error: (error as Error).message },
        503,
      );
    }
  });

  app.get('/internal/stats', async (c) => {
    const batcher = deps.batcher.getStats();
    let storage: TraceStoreStats | null = null;
    try {
      storage = await deps.store.stats();
    } catch {
      storage = null; // 存储查询失败不掩盖 batcher 指标(v1 语义)
    }
    return c.json({ batcher, storage });
  });

  return app;
}
