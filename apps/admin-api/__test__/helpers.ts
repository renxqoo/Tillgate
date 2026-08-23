/**
 * 契约测试公共替身：fake facade + 有效会话令牌（app.request() 直连,无真实 IO）。
 * 断言口径 = v1 wire 形状与错误码（MIGRATION §1 行为规格来源）。
 */
import type { AdminAppDeps } from '../src/app';
import type { ControlPlane } from '@tokenlens/control-plane';
import type { Observability } from '@tokenlens/observability';
import type { SessionPayload } from '@tokenlens/identity';

export const VALID_TOKEN = 'admin-session-token';
export const ADMIN_ID = 7;

export const sessionPayload: SessionPayload = {
  realm: 'admin',
  sub: String(ADMIN_ID),
  jti: 'jti-1',
  iss: 'tokenlens:admin',
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
  controlPlane?: Record<string, unknown>;
  observability?: Record<string, unknown>;
  writeAudit?: AdminAppDeps['writeAudit'];
  pingDb?: () => Promise<void>;
  now?: () => Date;
}): AdminAppDeps {
  return {
    pingDb: overrides.pingDb ?? (async () => undefined),
    sessions: {
      validate: async (token: string) => (token === VALID_TOKEN ? sessionPayload : null),
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
    } as AdminAppDeps['subscriptions'],
    controlPlane: fakeControlPlane(overrides.controlPlane),
    observability: fakeObservability(overrides.observability) as AdminAppDeps['observability'],
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
      retire: notWired,
      list: notWired,
    },
    channels: {
      create: notWired,
      update: notWired,
      retire: notWired,
      list: notWired,
      import: notWired,
      probe: notWired,
      recharge: notWired,
      adjust: notWired,
      listRecharges: notWired,
    },
    models: {
      create: notWired,
      update: notWired,
      retire: notWired,
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
    },
    fx: {
      state: notWired,
      refresh: notWired,
      setOverride: notWired,
      clearOverride: notWired,
      setBuffer: notWired,
    },
    catalog: {
      listSources: () => [],
      comparison: notWired,
      priceHistory: notWired,
      import: notWired,
    },
  };
  return { ...base, ...overrides } as ControlPlane;
}

function fakeObservability(
  overrides?: Record<string, unknown>,
): Pick<Observability, 'traces' | 'audit' | 'requestLogs'> {
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
  };
  return { ...base, ...overrides } as Pick<Observability, 'traces' | 'audit' | 'requestLogs'>;
}
