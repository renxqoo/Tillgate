/**
 * admin-api HTTP app（协议适配层,v1 app.ts 平移;错误面入 v2 目录体系）。
 * 本文件是 app 非装配代码:不引用数据库连接类型、composition 或任何 adapter——
 * DB 探活以闭包注入(P5:app 只持有 facade 与纯契约类型)。
 * 会话中间件逐路由挂载（未注册路径 404 而非 401——v1 语义）。
 */
import { Hono } from 'hono';
import { ZodError } from 'zod';
import { pgSqlState } from '@tokenlens/db'; // 纯 SQLSTATE 分类函数(errorHandler 文档化注入点;非 Db 类型)
import { errorBody, errorHandler, renderError, HttpErrors } from '@tokenlens/http';
import { localeFromContext } from '@tokenlens/http';
import type { AccountUseCases } from '@tokenlens/accounts';
import type { SubscriptionsApi, WalletApi } from '@tokenlens/billing';
import type { ControlPlane } from '@tokenlens/control-plane';
import type { Observability } from '@tokenlens/observability';
import type { Identity } from '@tokenlens/identity';
import { adminErrorCatalog } from './http/error-face';
import { sessionMiddleware, type SessionEnv } from './http/middleware/session';
import { protocolStack } from './http/middleware/protocol';
import type { OperationsUseCase, WriteAuditInTx } from './http/routes/users-funds';
import { usersRoutes } from './http/routes/users';
import { usersFundsRoutes } from './http/routes/users-funds';
import { keysRoutes } from './http/routes/keys';
import { providersRoutes } from './http/routes/providers';
import { channelsRoutes } from './http/routes/channels';
import { channelFundsRoutes } from './http/routes/channel-funds';
import { modelsRoutes } from './http/routes/models';
import { rateCardsRoutes } from './http/routes/rate-cards';
import { fxRoutes } from './http/routes/fx';
import { catalogRoutes } from './http/routes/catalog';
import { subscriptionsRoutes } from './http/routes/subscriptions';
import { tracingRoutes } from './http/routes/tracing';
import { opsLogsRoutes } from './http/routes/ops-logs';

export interface AdminAppDeps {
  /** DB 探活(healthz/readyz 用;装配绑定 ping(db),app 不接触 Db 类型) */
  pingDb: () => Promise<void>;
  /** 5xx 服务端日志出口(pino 结构兼容;缺省静默) */
  logger?: { error(obj: Record<string, unknown>, msg?: string): void };
  /** admin realm 会话验证(identity facade 结构子集) */
  sessions: Pick<Identity['sessions'], 'validate'>;
  accounts: Pick<
    AccountUseCases,
    | 'adminListUsers'
    | 'adminGetUser'
    | 'adminPatchUser'
    | 'adminListKeys'
    | 'adminPatchKey'
    | 'userExists'
  >;
  wallet: Pick<WalletApi, 'accounts' | 'setCreditLimit' | 'credit' | 'transfer' | 'statement'>;
  /** 调账/赠送幂等用例(billing operations;装配创建) */
  operations: OperationsUseCase;
  /** 同事务审计原语(装配闭包注入——observability/composition writeAudit 桥) */
  writeAudit: WriteAuditInTx;
  subscriptions: SubscriptionsApi;
  controlPlane: ControlPlane;
  observability: Pick<Observability, 'traces' | 'audit' | 'requestLogs'>;
  corsOrigins: readonly string[];
  bodyLimitBytes: number;
  /** 时钟注入(请求日志 30 天窗;测试可冻结) */
  now: () => Date;
}

export function createAdminApp(deps: AdminAppDeps): Hono<SessionEnv> {
  const app = new Hono<SessionEnv>();

  // 统一兜底:contracts 层 zod parse 的 ZodError 先行翻译(validation_failed——v1
  // invalid_request 语义);其余流动错误按 v2 目录渲染,PG SQLSTATE 探测注入
  const handler = errorHandler({
    catalog: adminErrorCatalog,
    sqlState: pgSqlState,
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
  });
  app.onError((error, c) => {
    if (error instanceof ZodError) {
      return handler(
        HttpErrors.business('validation_failed', {
          issues: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        }),
        c,
      );
    }
    return handler(error, c);
  });

  app.notFound((c) => {
    const rendered = renderError(HttpErrors.business('not_found'), {
      locale: localeFromContext(c),
      catalog: adminErrorCatalog,
    });
    return c.json(errorBody(rendered), rendered.status as 404);
  });

  for (const middleware of protocolStack({
    corsOrigins: deps.corsOrigins,
    bodyLimitBytes: deps.bodyLimitBytes,
  })) {
    app.use('*', middleware);
  }

  const session = sessionMiddleware(deps.sessions);

  // 探针:healthz/readyz 查 DB(livez 纯 200);K8s/compose healthcheck 不带 Bearer
  app.get('/healthz', async (c) => {
    try {
      await deps.pingDb();
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ ok: false, error: (error as Error).message }, 503);
    }
  });
  app.get('/livez', (c) => c.json({ ok: true }));
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

  app.route('/', usersRoutes({ accounts: deps.accounts, wallet: deps.wallet }, session));
  app.route(
    '/',
    usersFundsRoutes(
      {
        accounts: deps.accounts,
        wallet: deps.wallet,
        operations: deps.operations,
        writeAudit: deps.writeAudit,
        audit: deps.observability.audit,
      },
      session,
    ),
  );
  app.route('/', keysRoutes({ accounts: deps.accounts }, session));
  app.route('/', providersRoutes({ controlPlane: deps.controlPlane }, session));
  app.route('/', channelsRoutes({ controlPlane: deps.controlPlane }, session));
  app.route('/', channelFundsRoutes({ controlPlane: deps.controlPlane }, session));
  app.route('/', modelsRoutes({ controlPlane: deps.controlPlane }, session));
  app.route('/', rateCardsRoutes({ controlPlane: deps.controlPlane }, session));
  app.route('/', fxRoutes({ controlPlane: deps.controlPlane }, session));
  app.route('/', catalogRoutes({ controlPlane: deps.controlPlane }, session));
  app.route('/', subscriptionsRoutes({ subscriptions: deps.subscriptions }, session));
  app.route('/', tracingRoutes({ observability: deps.observability }, session));
  app.route('/', opsLogsRoutes({ observability: deps.observability, now: deps.now }, session));

  return app;
}
