/**
 * admin-api HTTP app（协议适配层）。
 * 本文件是 app 非装配代码:不引用数据库连接类型、composition 或任何 adapter——
 * DB 探活以闭包注入(app 只持有 facade 与纯契约类型)。
 * 会话中间件逐路由挂载（未注册路径 404 而非 401）。
 */
import { Hono } from 'hono';
import { ZodError } from 'zod';
import { pgSqlState } from '@tillgate/db'; // 纯 SQLSTATE 分类函数(errorHandler 文档化注入点;非 Db 类型)
import {
  errorBody,
  errorHandler,
  renderError,
  HttpErrors,
  dbBudgetMiddleware,
} from '@tillgate/http';
import { localeFromContext } from '@tillgate/http';
import type { AccountUseCases } from '@tillgate/accounts';
import type {
  PlansApi,
  RedeemBatchesApi,
  SettlementApi,
  SubscriptionsApi,
  WalletApi,
} from '@tillgate/billing';
import type { ControlPlane } from '@tillgate/control-plane';
import type { Observability } from '@tillgate/observability';
import type { Notifications } from '@tillgate/notifications';
import type { Identity } from '@tillgate/identity';
import type { PaymentAdminApi } from '@tillgate/billing';
import type { GenerationTaskStore } from '@tillgate/inference';
import { adminErrorCatalog, ADMIN_FACE_OVERRIDES } from './http/error-face';
import type { SessionEnv, SessionValidator } from './http/middleware/session';
import { createAclMiddleware, matchBinding } from './http/middleware/acl';
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
import { settingsRoutes } from './http/routes/settings';
import { catalogRoutes } from './http/routes/catalog';
import { subscriptionsRoutes } from './http/routes/subscriptions';
import { plansRoutes } from './http/routes/plans';
import { redeemRoutes, type PostAudit } from './http/routes/redeem';
import { billingOperationsRoutes } from './http/routes/billing-operations';
import { tracingRoutes } from './http/routes/tracing';
import { opsLogsRoutes } from './http/routes/ops-logs';
import { opsUsageRoutes } from './http/routes/ops-usage';
import { opsTasksRoutes } from './http/routes/ops-tasks';
import { opsOrdersRoutes } from './http/routes/ops-orders';
import { marketingRoutes } from './http/routes/marketing';
import { referralRoutes } from './http/routes/referrals';
import { vouchersRoutes } from './http/routes/vouchers';
import { notificationsRoutes } from './http/routes/notifications';
import { adminsRoutes } from './http/routes/admins';
import { rolesRoutes } from './http/routes/roles';
import { permissionsRoutes } from './http/routes/permissions';
import { endpointsRoutes } from './http/routes/endpoints';
import { authRoutes, type AuthGuard, type AuthRoutesDeps } from './http/routes/auth';
import { meRoutes } from './http/routes/me';

export interface AdminAppDeps {
  /** DB 探活(healthz/readyz 用;装配绑定 ping(db),app 不接触 Db 类型) */
  pingDb: () => Promise<void>;
  /** DB 并发预算门(管理面批量脚本/导出的入口排队;缺省关闭——不注入即旁路) */
  dbBudget?: { limit: number; maxQueue: number; waitTimeoutMs: number };
  /** 5xx 服务端日志出口(pino 结构兼容;缺省静默) */
  logger?: { error(obj: Record<string, unknown>, msg?: string): void };
  /** admin realm 会话验证(identity facade 结构子集)+ 属主回查 */
  sessions: SessionValidator;
  accounts: Pick<
    AccountUseCases,
    | 'adminListUsers'
    | 'adminGetUser'
    | 'adminPatchUser'
    | 'adminListKeys'
    | 'adminPatchKey'
    | 'userExists'
    | 'getMarketingSettings'
    | 'updateMarketingSettings'
    | 'listReferralRelations'
    | 'setReferralRelationStatus'
  >;
  wallet: Pick<
    WalletApi,
    'accounts' | 'setCreditLimit' | 'credit' | 'transfer' | 'statement' | 'referralPayouts'
  >;
  /** 调账/赠送幂等用例(billing operations;装配创建) */
  operations: OperationsUseCase;
  /** 同事务审计原语(装配闭包注入——observability/composition writeAudit 桥) */
  writeAudit: WriteAuditInTx;
  subscriptions: SubscriptionsApi;
  /** plans 目录管理 + 兑换批次管理 + 死信复核 */
  plans: PlansApi;
  redeemBatches: RedeemBatchesApi;
  review: SettlementApi['review'];
  /** 后置审计闭包(plans/redeem 域——提交后旁路语义) */
  postAudit: PostAudit;
  controlPlane: ControlPlane;
  /** 词表(protocols/vendors)——assembly 自 ai 根出口装配,/v1/vendor-catalog 消费 */
  vendorCatalog: { readonly protocols: readonly string[]; readonly vendors: readonly string[] };
  observability: Pick<Observability, 'traces' | 'audit' | 'requestLogs' | 'usage'>;
  /** 通知渠道管理面（CRUD/测试入箱;投递在 worker） */
  notifications: Pick<Notifications, 'channels'>;
  /** 生成任务管理读侧（inference 任务存储;装配 postgres 适配器） */
  generationTasks: Pick<GenerationTaskStore, 'adminList' | 'settledAmounts'>;
  /** 支付订单管理面（billing payments 组;列表 + 手动关单） */
  paymentAdmin: PaymentAdminApi;
  /** 手动关单 failureReason 留痕文案（审计数据,装配层显式持有） */
  orderCloseReason: string;
  /** 登录面:identity 动词面（鉴别/挑战/会话——编排件在路由内组装）;
   *  credentials.register = RBAC 建管理员凭据 */
  identity: Pick<Identity, 'passwords' | 'challenges' | 'sessions' | 'mfa' | 'credentials'>;
  /** 爆破双闸（runtime Redis 守卫产物） */
  authGuards: { emailIp: AuthGuard; ip: AuthGuard };
  /** 信任代理跳数（守卫键的 IP 提取） */
  trustedProxyHops: number;
  /** SMTP 是否已配置（2FA fail-closed 前置） */
  mailerConfigured: () => boolean;
  /** 登录三审计（后置旁路——提交后记录,失败不阻断） */
  loginAudit: AuthRoutesDeps['loginAudit'];
  /** step-up 失败审计（action 自由词面：settings.stepup.failed 等） */
  stepupAudit: (entry: { action: string; adminId: number; ip: string | null }) => Promise<void>;
  /** 2FA 开关成功审计（admin-email-2fa——settings.two_factor,后置旁路） */
  twoFactorAudit: (entry: {
    adminId: number;
    enabledFrom: boolean;
    enabledTo: boolean;
  }) => Promise<void>;
  /** 会话 TTL（签发面） */
  sessionTtlSec: number;
  corsOrigins: readonly string[];
  bodyLimitBytes: number;
  /** 时钟注入(请求日志 30 天窗;测试可冻结) */
  now: () => Date;
}

// eslint-disable-next-line max-lines-per-function, max-statements -- 应用装配:错误处理/中间件栈/路由挂载线性平铺,每条语句即一个挂载步骤
export function createAdminApp(deps: AdminAppDeps): Hono<SessionEnv> {
  const app = new Hono<SessionEnv>();

  // DB 并发预算门先行(探针路径在门内旁路):管理端批量操作/导出脚本防打满小池
  if (deps.dbBudget != null) app.use('*', dbBudgetMiddleware(deps.dbBudget));

  // 统一兜底:contracts 层 zod parse 的 ZodError 先行翻译(validation_failed,
  // 即 invalid_request 语义);其余流动错误按目录渲染,PG SQLSTATE 探测注入
  const handler = errorHandler({
    catalog: adminErrorCatalog,
    overrides: ADMIN_FACE_OVERRIDES,
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

  // RBAC 全局 ACL（执行面数据化——接口→权限绑定住 endpoint_permissions,
  // 单一事实源）。公开/自身白名单在中间件内;未绑定默认拒绝（fail-closed,超管短路
  // 可进后台补配绑定 = 兜底恢复路径）。每请求绑定表+权限树各一次查询（~百行小表,
  // 管理面 QPS 无感;缓存挂账）。
  const resolveBinding = async (method: string, path: string) => {
    const [bindings, nodes] = await Promise.all([
      deps.controlPlane.rbac.endpoints.list(),
      deps.controlPlane.rbac.permissions.tree(),
    ]);
    const matched = matchBinding(
      bindings.map((row) => ({
        method: row.method,
        path: row.path,
        code: nodes.find((node) => node.id === row.permissionId)?.code ?? '',
      })),
      method,
      path,
    );
    return matched != null && matched.code !== '' ? matched : null;
  };
  app.use('*', createAclMiddleware(deps.sessions, resolveBinding));

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

  app.route(
    '/',
    usersRoutes({
      accounts: deps.accounts,
      wallet: deps.wallet,
      identity: deps.identity,
      rates: deps.controlPlane.rates,
      postAudit: deps.postAudit,
    }),
  );
  app.route(
    '/',
    usersFundsRoutes({
      accounts: deps.accounts,
      wallet: deps.wallet,
      operations: deps.operations,
      writeAudit: deps.writeAudit,
      audit: deps.observability.audit,
    }),
  );
  app.route('/', keysRoutes({ accounts: deps.accounts }));
  app.route('/', providersRoutes({ controlPlane: deps.controlPlane }));
  app.route('/', channelsRoutes({ controlPlane: deps.controlPlane }));
  app.route('/', channelFundsRoutes({ controlPlane: deps.controlPlane }));
  app.route('/', modelsRoutes({ controlPlane: deps.controlPlane }));
  app.route('/', rateCardsRoutes({ controlPlane: deps.controlPlane }));
  app.route('/', fxRoutes({ controlPlane: deps.controlPlane }));
  app.route(
    '/',
    settingsRoutes({
      controlPlane: deps.controlPlane,
      identity: deps.identity,
      guards: deps.authGuards,
      audit: deps.stepupAudit,
      trustedProxyHops: deps.trustedProxyHops,
    }),
  );
  app.route(
    '/',
    catalogRoutes({ controlPlane: deps.controlPlane, vendorCatalog: deps.vendorCatalog }),
  );
  app.route('/', subscriptionsRoutes({ subscriptions: deps.subscriptions }));
  app.route('/', plansRoutes({ plans: deps.plans, postAudit: deps.postAudit }));
  app.route('/', redeemRoutes({ redeemBatches: deps.redeemBatches, postAudit: deps.postAudit }));
  app.route('/', billingOperationsRoutes({ review: deps.review }));
  app.route('/', tracingRoutes({ observability: deps.observability }));
  app.route('/', opsLogsRoutes({ observability: deps.observability, now: deps.now }));
  app.route('/', opsUsageRoutes({ observability: deps.observability, now: deps.now }));
  app.route('/', opsTasksRoutes({ generationTasks: deps.generationTasks }));
  app.route(
    '/',
    opsOrdersRoutes({ paymentAdmin: deps.paymentAdmin, orderCloseReason: deps.orderCloseReason }),
  );
  app.route('/', marketingRoutes({ accounts: deps.accounts }));
  app.route('/', referralRoutes({ accounts: deps.accounts, wallet: deps.wallet }));
  app.route('/', vouchersRoutes({ controlPlane: deps.controlPlane }));
  app.route('/', notificationsRoutes({ notifications: deps.notifications }));
  // 动态 RBAC 管理面（admins 域码——roles/permissions CRUD 与管理员管理同域同受众）
  app.route(
    '/',
    adminsRoutes({
      admins: deps.controlPlane.admins,
      identity: deps.identity,
      postAudit: deps.postAudit,
    }),
  );
  app.route('/', rolesRoutes({ rbac: deps.controlPlane.rbac, postAudit: deps.postAudit }));
  app.route('/', permissionsRoutes({ rbac: deps.controlPlane.rbac, postAudit: deps.postAudit }));
  app.route('/', endpointsRoutes({ rbac: deps.controlPlane.rbac, postAudit: deps.postAudit }));
  // 登录面:auth 公开组（登录/验码不挂会话件;logout 挂）+ me 会话组
  app.route(
    '/',
    authRoutes({
      identity: deps.identity,
      admins: deps.controlPlane.admins,
      guards: deps.authGuards,
      loginAudit: deps.loginAudit,
      trustedProxyHops: deps.trustedProxyHops,
      mailerConfigured: deps.mailerConfigured,
      sessionTtlSec: deps.sessionTtlSec,
    }),
  );
  app.route(
    '/',
    meRoutes({
      identity: deps.identity,
      twoFactorAudit: deps.twoFactorAudit,
      admins: deps.controlPlane.admins,
      rbac: deps.controlPlane.rbac,
      trustedProxyHops: deps.trustedProxyHops,
      sessionTtlSec: deps.sessionTtlSec,
    }),
  );

  return app;
}
