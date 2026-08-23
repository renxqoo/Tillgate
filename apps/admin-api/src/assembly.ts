import { createDb, type Db, type TxRetryPolicy } from '@tokenlens/db';
import { createLogger, createCipher, type Logger } from '@tokenlens/runtime';
import { SUPPORTED_PROTOCOLS } from '@tokenlens/ai';
import { createIdentity, type Identity } from '@tokenlens/identity';
import {
  createBilling,
  createOperationsUseCase,
  type Billing,
  type OperationRun,
} from '@tokenlens/billing';
// ./composition 子入口仅 assembly 引用(§5.3):postgres store 装配便捷件
import {
  createPostgresBillingStore,
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
// writeAudit/createBestEffortAuditSink = 跨能力审计桥原语(G1;仅 assembly 可引用)
import { writeAudit, createBestEffortAuditSink } from '@tokenlens/observability/composition';
import { ADMIN_SESSION_ISSUER, type AdminApiConfig } from './config';
import { createUpstreamProbe } from './adapters/upstream-probe';
import { createAdminFundingResolver } from './adapters/funding-resolver';
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
  readonly observability: Observability;
  /** 调账/赠送幂等用例（ledger_operations 档案;store 装配件在装配域内创建） */
  readonly operations: ReturnType<typeof createOperationsUseCase>;
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
    logger,
    metricsExportIntervalMs: config.otelMetricsIntervalMs,
  });
  const db = createDb({ url: config.databaseUrl, ...config.dbPool });

  // identity:admin realm 会话验证是本波唯一消费面;词表/挑战/TOTP 形状合法即装配
  const identity = createIdentity({
    db,
    txRetry: TX_RETRY,
    clock: { now: () => new Date() },
    logger,
    config: {
      identifiers: ['email'],
      providers: ['github'],
      challengeKinds: ['admin_login_code'],
      realms: ['admin'],
      codePepper: config.identityCodePepper,
      sessions: {
        admin: {
          issuer: ADMIN_SESSION_ISSUER,
          secret: config.adminJwtSecret,
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

  const controlPlane = createControlPlane({
    db,
    cipher: createCipher(config.encryptionKey),
    // D1(DESIGN §5):vendor 档案词表待 ai 根出口(1 行接缝,P6);protocols 全词表
    capabilities: { protocols: SUPPORTED_PROTOCOLS, vendorProfiles: [] },
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

  return {
    logger,
    otel,
    db,
    identity,
    billing,
    accounts,
    controlPlane,
    observability,
    operations: createOperationsUseCase({ store: billingStore }),
    // WalletTx 是 billing 的不透明事务句柄（仅 adapters 构造;根出口不可名状）;
    // 同事务审计桥在唯一装配面做一次形状适配——底层即同一 drizzle 事务,业务代码零感知
    writeAuditInTx: (
      tx: Parameters<OperationRun<Record<string, unknown>>['execute']>[0],
      entry: Parameters<typeof writeAudit>[1],
    ) => writeAudit(tx as unknown as Parameters<typeof writeAudit>[0], entry),
  };
}
