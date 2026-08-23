import { createDb, type Db, type TxRetryPolicy } from '@tokenlens/db';
import type Redis from 'ioredis';
import {
  createLogger,
  createCipher,
  createRedisClient,
  createKeyBruteForceGuard,
  createAuthFailureGuard,
  type Logger,
} from '@tokenlens/runtime';
import { SUPPORTED_PROTOCOLS, vendorProfileNames, assertSafeUrl } from '@tokenlens/ai';
import { createIdentity, type Identity } from '@tokenlens/identity';
import {
  createBilling,
  createOperationsUseCase,
  createPaymentAdminApi,
  createRedeemBatchApi,
  type Billing,
  type OperationRun,
  type RedeemBatchesApi,
} from '@tokenlens/billing';
import { generateRedeemCode } from '@tokenlens/http';
// ./composition 子入口仅 assembly 引用(§5.3):postgres store 装配便捷件
import {
  createPostgresBillingStore,
  createPostgresPaymentOrderStore,
  createPostgresRedeemCodeStore,
  createPostgresWalletStore,
} from '@tokenlens/billing/composition';
import { createAccounts, type AccountUseCases } from '@tokenlens/accounts';
import { createControlPlane, type ControlPlane } from '@tokenlens/control-plane';
// 目录源 adapter 不出 control-plane 根入口(§5.3)——装配经 composition 取件
import { modelsDevSource, createOpenRouterSource } from '@tokenlens/control-plane/composition';
import {
  createObservability,
  initOtel,
  type Observability,
  type OtelHandle,
} from '@tokenlens/observability';
import { createNotifications, type Notifications } from '@tokenlens/notifications';
import { createPostgresGenerationTaskStore } from '@tokenlens/inference';
// writeAudit/createBestEffortAuditSink = 跨能力审计桥原语(G1;仅 assembly 可引用)
import { writeAudit, createBestEffortAuditSink } from '@tokenlens/observability/composition';
import { ADMIN_SESSION_ISSUER, type AdminApiConfig } from './config';
import type { AuthGuard } from './http/routes/auth';
import { createUpstreamProbe } from './adapters/upstream-probe';
import { createAdminFundingResolver } from './adapters/funding-resolver';
import { createIdentityAuditSinkBridge } from './adapters/identity-audit-bridge';
import { createSmtpAdminMailer } from './adapters/smtp-admin-mailer';
import { createAdminSessionRevocation } from './adapters/redis-session-revocation';
import {
  createAuditSinkBridge,
  createSessionInvalidationBridge,
  createWalletCreditBridge,
} from './adapters/accounts-bridges';

/**
 * 唯一依赖装配根:config → logger/otel/db/identity/billing/accounts/control-plane/observability。
 * 进程启动(index.ts)只调这里与 createAdminApp,不自行拼装依赖。
 * 审计桥(observability G1):accounts/control-plane 的 AuditPort/AuditSink 在此桥接
 * observability 写入原语——同事务者随业务回滚,best-effort 者提交后旁路。
 */

/** 事务重试策略(db 包词表;v1 等价值——装配显式持有) */
const TX_RETRY: TxRetryPolicy = { maxAttempts: 5, baseDelayMs: 15, maxJitterMs: 20 };

/** accounts 装配 policy(v1 等价值——铁律 3,装配层显式持有) */
const ACCOUNTS_POLICY = {
  keyPrefix: 'ag_',
  invitationTtlMs: 7 * 24 * 60 * 60 * 1000,
  invitationPendingFactor: 2,
  invitationPendingCap: 20,
  amountLimitUpper: '1000000000000',
  rpmLimitMax: 1_000_000,
  tpmLimitMax: 100_000_000,
  scopeModelsMax: 100,
  referralInviteeLimit: 100,
  listPage: { page: 1, limit: 20, maxLimit: 100 },
  banDefaultReason: '管理员封禁',
} as const;

export interface AdminApiAssembly {
  readonly logger: Logger;
  readonly otel: OtelHandle;
  readonly db: Db;
  readonly identity: Identity;
  readonly billing: Billing;
  readonly accounts: AccountUseCases;
  readonly controlPlane: ControlPlane;
  /** P6/D1:协议/厂商档案词表——单一事实源 = ai 根出口(capabilities 校验与 vendor-catalog 端点同源) */
  readonly vendorCatalog: {
    readonly protocols: readonly string[];
    readonly vendors: readonly string[];
  };
  readonly observability: Observability;
  /** P5:通知渠道管理面（CRUD/测试入箱;投递在 worker） */
  readonly notifications: Notifications;
  /** P2:Redis 连接（守卫双闸/jti 吊销面共用;shutdown 收口 quit） */
  readonly redis: Redis;
  /** P2:爆破双闸（routes/auth 消费;Redis 形态） */
  readonly authGuards: { emailIp: AuthGuard; ip: AuthGuard };
  /** P2:SMTP 是否已配置 */
  readonly mailerConfigured: boolean;
  /** P2:登录三审计（后置旁路,失败不阻断） */
  readonly loginAudit: (entry: {
    action: 'auth.login.invalid_credentials' | 'auth.login.2fa_challenge' | 'auth.login.success';
    adminId: number | null;
    ip: string | null;
    email?: string;
    twoFactor?: boolean;
  }) => Promise<void>;
  /** P4:生成任务管理读侧（generation_tasks postgres 适配器根出口装配件） */
  readonly generationTasks: ReturnType<typeof createPostgresGenerationTaskStore>;
  /** P4:支付订单管理面（列表 + 手动关单;billing payments 组,无渠道凭证依赖） */
  readonly paymentAdmin: ReturnType<typeof createPaymentAdminApi>;
  /** 调账/赠送幂等用例（ledger_operations 档案;store 装配件在装配域内创建） */
  readonly operations: ReturnType<typeof createOperationsUseCase>;
  /** 兑换批次管理面(U6;明文码生成器 = http generateRedeemCode 注入——billing 不 import http) */
  readonly redeemBatches: RedeemBatchesApi;
  /** 后置审计闭包(plans/redeem 域——v1 recordAudit 提交后旁路语义) */
  readonly postAudit: (entry: {
    actor: 'admin';
    adminId: number;
    action: string;
    targetType: string;
    targetId: string | number;
    detail: Record<string, unknown> | null;
  }) => Promise<void>;
  /** 同事务审计原语(G1 桥;users-funds 调账/赠送在幂等事务内消费;WalletTx 经装配适配) */
  readonly writeAuditInTx: (
    tx: Parameters<OperationRun<Record<string, unknown>>['execute']>[0],
    entry: Parameters<typeof writeAudit>[1],
  ) => Promise<void>;
}

export function assembleAdminApi(config: AdminApiConfig): AdminApiAssembly {
  const logger = createLogger({ level: config.logLevel, serviceName: 'admin-api', pretty: false });
  const otel = initOtel({
    serviceName: 'admin-api',
    serviceVersion: config.serviceVersion,
    mode: config.otelMode,
    endpoint: config.otelEndpoint,
    ...(config.otelAuthToken != null ? { authToken: config.otelAuthToken } : {}),
    logger,
    metricsExportIntervalMs: config.otelMetricsIntervalMs,
  });
  const db = createDb({ url: config.databaseUrl, ...config.dbPool });

  // P2 登录面装置:Redis 守卫双闸（不可达 fail-closed 503,路由层翻译）+
  // SMTP mailer（三要素齐才建,null = 2FA fail-closed）+ jti 吊销面
  const redis = createRedisClient(config.redisUrl, {
    serviceName: 'admin-api',
    logThrottleMs: 60_000,
    log: (message) => logger.warn({ component: 'redis' }, message),
  });
  const loginGuard = createKeyBruteForceGuard(redis, {
    failureThreshold: config.loginGuard.failureThreshold,
    failureWindowS: config.loginGuard.failureWindowS,
    lockS: config.loginGuard.lockS,
  });
  const ipGuard = createAuthFailureGuard(redis, {
    limit: config.ipGuard.limit,
    windowS: config.ipGuard.windowS,
  });
  const mailer =
    config.smtp != null
      ? createSmtpAdminMailer(
          config.smtp,
          {
            brand: 'TokenLens 管理后台',
            brandEn: 'TokenLens Admin',
            brandSub: 'TOKENLENS · ADMIN CONSOLE',
          },
          { ttlMinutes: 5, maxAttempts: 5 },
          () => new Date(),
        )
      : null;
  const sessionRevocation = createAdminSessionRevocation(redis);

  // identity:admin realm 会话/挑战 + user realm 失效线（D6）;词表/挑战/TOTP 形状合法即装配
  const identity = createIdentity({
    db,
    txRetry: TX_RETRY,
    clock: { now: () => new Date() },
    logger,
    config: {
      identifiers: ['email'],
      providers: ['github'],
      challengeKinds: ['admin_login_code'],
      // user realm 在词表内 = set-password 推进 user 失效线（D6 全网下线）;
      // 本 app 绝不签发 user 会话（无任何 sign('user') 调用路径）
      realms: ['user', 'admin'],
      codePepper: config.identityCodePepper,
      sessions: {
        admin: {
          issuer: ADMIN_SESSION_ISSUER,
          secret: config.adminJwtSecret,
          ttlSec: config.sessionTtlSec,
        },
        // 词表一致性占位（identity 要求 sessions 键 = realms 全集）;
        // secret 用部署级用户面值,但无签发路径——不可用于铸造 user token
        user: {
          issuer: 'tokenlens:user',
          secret: config.userJwtSecret,
          ttlSec: config.sessionTtlSec,
        },
      },
      oauth: {},
      // OAuth 回调白名单:identity 配置要求非空——占位哨兵值(不可达域名),P2 登录波
      // 引入真实回调登记时升为 config 显式键(fail-closed:不在词表内直接拒绝)
      oauthRedirectAllowlist: ['https://admin.invalid/oauth/callback'],
      passwordPolicy: { minLength: 8, maxLength: 128 },
      challenge: { digits: 6, ttlMs: 5 * 60_000, cooldownMs: 60_000, maxAttempts: 5 },
      totp: { issuer: 'TokenLens Admin', stepSec: 30, windowSteps: 1, recoveryCount: 8 },
      oauthStateTtlSec: 600,
    },
    // P2:2FA 邮箱码投递（SMTP 缺省 = fail-closed,不静默降级单密码）+ jti 吊销面
    //（logout）+ identity 审计桥（observability G1 剩余半边——事件→audit_logs）
    ...(mailer != null ? { mailer } : {}),
    sessionRevocation,
    auditSink: createIdentityAuditSinkBridge((dbLike, entry) => writeAudit(dbLike, entry)),
  });

  // billing:postgres store 细粒度直组(store 引用留在手上——operations 幂等用例需要)
  const billingStore = createPostgresBillingStore(db, { retry: TX_RETRY });
  const walletStore = createPostgresWalletStore(db, { retry: TX_RETRY });
  const billing = createBilling(
    {
      walletStore,
      store: billingStore,
      quota: billingStore.quotaStore,
      channels: billingStore.channelStore,
      accounts: billingStore.accountContext,
    },
    {
      guards: config.walletGuards,
      currency: config.currency,
      resolver: createAdminFundingResolver(),
      failurePolicy: config.settlePolicy,
      clock: () => new Date(),
      onError: (error, context) => {
        logger.error({ err: error, context }, 'admin-api settlement onError');
      },
      // 死信复核同事务审计桥(G1 同口径;WalletTx→DbLike 形状适配在唯一装配面)
      reviewAuditTx: (tx, entry) =>
        writeAudit(tx as unknown as Parameters<typeof writeAudit>[0], entry),
    },
  );

  const accounts = createAccounts({
    db,
    // 三桥裁决(D9/D10/G1)见 src/adapters/accounts-bridges.ts 文件头
    walletCredit: createWalletCreditBridge(billing.wallet),
    sessionInvalidation: createSessionInvalidationBridge(identity.revocation),
    auditSink: createAuditSinkBridge(writeAudit),
    policy: ACCOUNTS_POLICY,
    txRetry: TX_RETRY,
    now: () => new Date(),
  });

  // P6/D1:词表全量自 ai 根出口装配(app 不复制词表,双事实源禁令)
  const vendorCatalog: AdminApiAssembly['vendorCatalog'] = {
    protocols: SUPPORTED_PROTOCOLS,
    vendors: vendorProfileNames(),
  };

  const controlPlane = createControlPlane({
    db,
    cipher: createCipher(config.encryptionKey),
    capabilities: { protocols: vendorCatalog.protocols, vendorProfiles: vendorCatalog.vendors },
    probe: createUpstreamProbe(),
    defaultProtocol: 'openai-compatible',
    importMaxChannels: config.channelImportMax,
    sources: [
      modelsDevSource,
      createOpenRouterSource({
        url: config.openrouterCatalogUrl,
        timeoutMs: config.catalogFetchTimeoutMs,
      }),
    ],
    catalogTtlMs: config.catalogCacheTtlMs,
    catalogChannelRpm: config.catalogFreeChannelRpm,
    catalogChannelBudget: config.catalogFreeChannelBudget,
    voucherMaxBytes: config.voucherMaxBytes,
    fx: config.fx,
    // 审计桥 G1:best-effort 运营审计(provider/model/fx/目录);资金类同事务缺省 postgres
    audit: createBestEffortAuditSink(db, (obj, msg) => logger.error(obj, msg)),
  });

  const observability = createObservability({ db });

  // P5:通知渠道管理面（CRUD/测试入箱;实际投递在 worker dispatchOnce）。
  // emailSender 不注入 = email 渠道 fail-closed（发送归 worker,admin 面无需 SMTP）;
  // DispatchConfig 为 facade 必填形状——admin 面无投递路径,取 worker 同值缺省的
  // 装配字面量（铁律 3:装配层显式持有,不藏全局默认）。
  const notifications: Notifications = createNotifications({
    db,
    cipher: createCipher(config.encryptionKey),
    urlGuard: { assert: (url, opts) => assertSafeUrl(url, { allowLocal: opts.allowLocal }) },
    logger: { warn: (obj, msg) => logger.warn(obj, msg) },
    webhookAllowLocalUrl: config.webhookAllowLocalUrl,
    config: {
      claimLeaseMs: 60_000,
      maxAttempts: 5,
      loopBatchLimit: 50,
      webhookTimeoutMs: 10_000,
      backoffBaseMs: 1_000,
      backoffCapMs: 300_000,
      emailBrand: 'TokenLens',
    },
  });

  return {
    logger,
    otel,
    db,
    identity,
    billing,
    accounts,
    controlPlane,
    vendorCatalog,
    observability,
    notifications,
    // P2 登录面装置（authGuards/loginAudit 消费面在 routes/auth）
    redis,
    authGuards: { emailIp: loginGuard, ip: ipGuard },
    mailerConfigured: mailer != null,
    loginAudit: (entry) =>
      writeAudit(db, {
        actor: 'system',
        ...(entry.adminId != null ? { adminId: entry.adminId } : { adminId: null }),
        action: entry.action,
        targetType: 'admin',
        targetId: entry.adminId,
        detail: {
          ...(entry.ip != null ? { ip: entry.ip } : {}),
          ...(entry.email !== undefined ? { email: entry.email } : {}),
          ...(entry.twoFactor !== undefined ? { twoFactor: entry.twoFactor } : {}),
        },
      }).catch(() => undefined),
    // P4:任务存储直组 postgres 适配器（管理读侧不装配 createInference 全家桶——
    // 本 app 无推理热路径,任务表读侧是唯一消费面）
    generationTasks: createPostgresGenerationTaskStore(db),
    // P4:订单 store 与 billing store 共享会话/事务面（read + 单语句 CAS）
    paymentAdmin: createPaymentAdminApi({
      store: billingStore,
      orders: createPostgresPaymentOrderStore(db),
    }),
    operations: createOperationsUseCase({ store: billingStore }),
    redeemBatches: createRedeemBatchApi({
      store: billingStore,
      codes: createPostgresRedeemCodeStore(db),
      generateCode: generateRedeemCode,
    }),
    postAudit: (entry) =>
      writeAudit(db, {
        actor: entry.actor,
        adminId: entry.adminId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        ...(entry.detail !== null ? { detail: entry.detail } : {}),
      }),
    // WalletTx 是 billing 的不透明事务句柄（仅 adapters 构造;根出口不可名状）;
    // 同事务审计桥在唯一装配面做一次形状适配——底层即同一 drizzle 事务,业务代码零感知
    writeAuditInTx: (
      tx: Parameters<OperationRun<Record<string, unknown>>['execute']>[0],
      entry: Parameters<typeof writeAudit>[1],
    ) => writeAudit(tx as unknown as Parameters<typeof writeAudit>[0], entry),
  };
}
