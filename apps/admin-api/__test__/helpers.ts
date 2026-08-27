/**
 * 契约测试公共替身：fake facade + 有效会话令牌（app.request() 直连,无真实 IO）。
 * 断言口径 = wire 形状与错误码。
 */
import type { AdminAppDeps } from '../src/app';
import type { ControlPlane } from '@tillgate/control-plane';
import type { Observability } from '@tillgate/observability';
import type { SessionPayload } from '@tillgate/identity';

export const VALID_TOKEN = 'admin-session-token';
export const ADMIN_ID = 7;

export const sessionPayload: SessionPayload = {
  realm: 'admin',
  sub: String(ADMIN_ID),
  jti: 'jti-1',
  iss: 'tillgate:admin',
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
};

export function authHeader(token: string = VALID_TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** 未接线 fake 的显式失败(命中 = 测试漏覆写该动词) */
const notWired = async (): Promise<never> => {
  throw new Error('fake not wired');
};

/** 最小可启动 deps:各域 fake 以 vi.fn 注入,按测试覆写(覆写面松类型——替身处显式收窄) */
export function fakeDeps(overrides: {
  accounts?: Record<string, unknown>;
  wallet?: Record<string, unknown>;
  operations?: Record<string, unknown>;
  subscriptions?: Record<string, unknown>;
  plans?: Record<string, unknown>;
  redeemBatches?: Record<string, unknown>;
  review?: Record<string, unknown>;
  controlPlane?: Record<string, unknown>;
  observability?: Record<string, unknown>;
  notifications?: Record<string, unknown>;
  generationTasks?: Record<string, unknown>;
  paymentAdmin?: Record<string, unknown>;
  identity?: Record<string, unknown>;
  writeAudit?: AdminAppDeps['writeAudit'];
  pingDb?: () => Promise<void>;
  now?: () => Date;
}): AdminAppDeps {
  return {
    pingDb: overrides.pingDb ?? (async () => {}),
    // 词表注入面(真源 = ai 根出口;此处最小 fake——封闭性由 ai 包架构测试锁定)
    vendorCatalog: { protocols: ['openai-compatible'], vendors: ['openai'] },
    sessions: {
      validate: async (token: string) => (token === VALID_TOKEN ? sessionPayload : null),
      // 与生产装配同形:属主回查一条 join 带回授权面（super 短路全量）
      owner: async () => ({ status: 0, grants: { isSuper: true, codes: [] } }),
    },
    accounts: {
      adminListUsers: async () => ({ rows: [], total: 0 }),
      adminGetUser: async () => {
        throw new Error('fake not wired');
      },
      adminPatchUser: async () => {
        throw new Error('fake not wired');
      },
      adminListKeys: async () => ({ rows: [], total: 0 }),
      adminPatchKey: async () => {
        throw new Error('fake not wired');
      },
      userExists: async () => true,
      // 营销/邀请域动词(默认 fake not wired,测试覆写)
      getMarketingSettings: async () => {
        throw new Error('fake not wired');
      },
      updateMarketingSettings: async () => {
        throw new Error('fake not wired');
      },
      listReferralRelations: async () => ({ rows: [], total: 0 }),
      setReferralRelationStatus: async () => {
        throw new Error('fake not wired');
      },
      ...overrides.accounts,
    } as AdminAppDeps['accounts'],
    wallet: {
      accounts: async () => [],
      setCreditLimit: async () => {
        throw new Error('fake not wired');
      },
      credit: async () => {
        throw new Error('fake not wired');
      },
      transfer: async () => {
        throw new Error('fake not wired');
      },
      statement: async () => [],
      // 返利流水读侧(billing 接缝)
      referralPayouts: async () => ({ rows: [], total: 0 }),
      ...overrides.wallet,
    } as AdminAppDeps['wallet'],
    operations: {
      run: async () => {
        throw new Error('fake not wired');
      },
      ...overrides.operations,
    } as AdminAppDeps['operations'],
    writeAudit:
      overrides.writeAudit ??
      (async () => {
        /* 同事务审计替身:默认静默成功 */
      }),
    subscriptions: {
      adminList: async () => ({ rows: [], total: 0 }),
      purchase: async () => {
        throw new Error('fake not wired');
      },
      renew: async () => {
        throw new Error('fake not wired');
      },
      change: async () => {
        throw new Error('fake not wired');
      },
      cancel: async () => {
        throw new Error('fake not wired');
      },
      grantPack: async () => {
        throw new Error('fake not wired');
      },
      ...overrides.subscriptions,
    } as unknown as AdminAppDeps['subscriptions'],
    plans: {
      list: async () => ({ rows: [], total: 0 }),
      create: async () => {
        throw new Error('fake not wired');
      },
      update: async () => {
        throw new Error('fake not wired');
      },
      remove: async () => {
        throw new Error('fake not wired');
      },
      ...overrides.plans,
    } as AdminAppDeps['plans'],
    redeemBatches: {
      create: async () => {
        throw new Error('fake not wired');
      },
      list: async () => ({ rows: [], total: 0 }),
      detail: async () => {
        throw new Error('fake not wired');
      },
      codes: async () => ({ rows: [], total: 0 }),
      revoke: async () => {
        throw new Error('fake not wired');
      },
      ...overrides.redeemBatches,
    } as AdminAppDeps['redeemBatches'],
    review: {
      listDead: async () => ({ rows: [], total: 0 }),
      retryDead: async () => {
        throw new Error('fake not wired');
      },
      abandonDead: async () => {
        throw new Error('fake not wired');
      },
      ...overrides.review,
    } as AdminAppDeps['review'],
    postAudit: async () => {
      /* 后置审计替身:默认静默 */
    },
    controlPlane: fakeControlPlane(overrides.controlPlane),
    observability: fakeObservability(overrides.observability) as AdminAppDeps['observability'],
    // 通知渠道管理面(默认空列表;CRUD 动词测试覆写——键为 channels 动词名)
    notifications: {
      channels: {
        list: async () => [],
        create: notWired,
        patch: notWired,
        remove: notWired,
        test: notWired,
        ...(overrides.notifications as Record<string, unknown> | undefined),
      },
    } as AdminAppDeps['notifications'],
    // 生成任务管理读侧 + 支付订单管理面(默认最小 fake,测试覆写)
    generationTasks: {
      adminList: async () => ({ rows: [], total: 0 }),
      settledAmounts: async () => new Map<string, string>(),
      ...overrides.generationTasks,
    } as AdminAppDeps['generationTasks'],
    paymentAdmin: {
      list: async () => ({ rows: [], total: 0 }),
      close: notWired,
      ...(overrides.paymentAdmin as Record<string, unknown> | undefined),
    } as AdminAppDeps['paymentAdmin'],
    orderCloseReason: '管理员手动关闭',
    // 登录面:identity 动词 fake(不抛哑错——默认拒绝形态,auth 域测试经独立装配)
    identity: {
      passwords: { authenticate: notWired, change: notWired, reset: notWired },
      challenges: { begin: notWired, verify: notWired, abort: notWired },
      mfa: mfaStub(),
      credentials: { register: notWired },
      sessions: {
        sign: notWired,
        verify: notWired,
        validate: notWired,
        logout: async () => ({ ok: true as const }),
      },
      ...overrides.identity,
    } as AdminAppDeps['identity'],
    authGuards: {
      emailIp: {
        isLocked: async () => ({ locked: false, retryAfterSec: 0 }),
        recordFailure: async () => {},
        recordSuccess: async () => {},
      },
      ip: {
        isLocked: async () => ({ locked: false, retryAfterSec: 0 }),
        recordFailure: async () => {},
        recordSuccess: async () => {},
      },
    },
    trustedProxyHops: 0,
    mailerConfigured: () => false,
    loginAudit: async () => {},
    stepupAudit: async () => {},
    twoFactorAudit: async () => {},
    sessionTtlSec: 3600,
    corsOrigins: [],
    bodyLimitBytes: 1024 * 1024,
    now: overrides.now ?? (() => new Date('2026-08-23T00:00:00Z')),
  };
}

function fakeControlPlane(overrides?: Record<string, unknown>): ControlPlane {
  const base: ControlPlane = {
    providers: {
      create: notWired,
      update: notWired,
      delete: notWired,
      undelete: notWired,
      list: notWired,
    },
    channels: {
      create: notWired,
      update: notWired,
      delete: notWired,
      undelete: notWired,
      list: notWired,
      import: notWired,
      probe: notWired,
      recharge: notWired,
      adjust: notWired,
      listRecharges: notWired,
      loadVoucher: notWired,
    },
    models: {
      create: notWired,
      update: notWired,
      delete: notWired,
      undelete: notWired,
      list: notWired,
      bindChannels: notWired,
      probe: notWired,
    },
    rates: {
      createCard: notWired,
      updateCard: notWired,
      deleteCard: notWired,
      listCards: notWired,
      listCardUsers: notWired,
      cardHealth: notWired,
      findGlobalCoefficient: notWired,
    },
    fx: {
      state: notWired,
      refresh: notWired,
      setOverride: notWired,
      clearOverride: notWired,
      setBuffer: notWired,
    },
    // 运营系统配置面（默认 notWired——settings 域测试覆写）
    settings: {
      billingTimezone: {
        read: notWired,
        update: notWired,
      },
      integrations: {
        list: notWired,
        update: notWired,
      },
    },
    catalog: {
      listSources: () => [],
      comparison: notWired,
      priceHistory: notWired,
      import: notWired,
    },
    rbac: {
      roles: {
        find: async () => null,
        list: notWired,
        create: notWired,
        update: notWired,
        remove: notWired,
      },
      permissions: {
        tree: async () => [],
        create: notWired,
        update: notWired,
        remove: notWired,
        activeCodes: async () => [],
      },
      endpoints: {
        list: async () => [],
        create: notWired,
        update: notWired,
        remove: notWired,
      },
    },
    // 管理员资料面(密码/挑战在 identity;此处最小 fake,测试覆写)
    // RBAC 管理面动词(list/create/update/remove)同 fake——admins 域测试覆写
    admins: {
      find: notWired,
      findByEmail: notWired,
      findAccess: notWired,
      touchLastLogin: notWired,
      setTwoFactorEnabled: notWired,
      list: notWired,
      create: notWired,
      update: notWired,
      remove: notWired,
    },
  };
  return { ...base, ...overrides } as ControlPlane;
}

function fakeObservability(
  overrides?: Record<string, unknown>,
): Pick<Observability, 'traces' | 'audit' | 'requestLogs' | 'usage'> {
  const base = {
    traces: {
      recent: notWired,
      traceDetail: notWired,
      byRequest: notWired,
      topology: notWired,
      stats: notWired,
    },
    audit: {
      list: notWired,
      listByTarget: notWired,
    },
    requestLogs: {
      insert: notWired,
      list: notWired,
    },
    // 用量运维读侧(默认最小 fake;统计端点测试覆写)
    usage: {
      adminList: notWired,
      overview: notWired,
      groups: notWired,
      trends: notWired,
      channelTtft: notWired,
    },
  };
  return { ...base, ...overrides } as Pick<
    Observability,
    'traces' | 'audit' | 'requestLogs' | 'usage'
  >;
}

/** TOTP/MFA 替身:默认「未绑定」(登录不触发第二因子);绑定态用例传 {confirmed:true} */
export function mfaStub(
  over: { confirmed?: boolean; verifyError?: Error; stepupError?: Error } = {},
) {
  return {
    status: async () => ({ enrolled: over.confirmed === true, confirmed: over.confirmed === true }),
    enrollTotp: async () => ({
      secret: 'JBSWY3DPEHPK3PXP',
      otpauthUrl: 'otpauth://totp/Tillgate:test%40example.dev?secret=JBSWY3DPEHPK3PXP',
    }),
    confirmTotp: async () => ({ recoveryCodes: ['RVWXYZ2345'] }),
    verify:
      over.verifyError != null
        ? async () => {
            throw over.verifyError;
          }
        : async () => ({ method: 'totp' as const }),
    verifyTotpOnly:
      over.stepupError != null
        ? async () => {
            throw over.stepupError;
          }
        : async () => {},
    disableTotp: async () => ({ disabled: true }),
  };
}
