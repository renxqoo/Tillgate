/**
 * 包内测试 harness:内存替身 + 快照回滚 fake db + facade 组装(默认门禁无 PG/Redis/
 * SMTP,全部走替身与注入)。仅 __test__ 消费;不进入公共 exports。
 */
import type { Db, TxRetryPolicy } from '@tokenlens/db';
import type { IdentityConfigInput } from '../domain/config.js';
import type { IdentityAuditEvent } from '../domain/audit-events.js';
import type { Captcha } from '../ports/captcha.js';
import type { Mailer } from '../ports/mailer.js';
import type { OAuthStateStore } from '../ports/oauth-state-store.js';
import type { SessionRevocationStore } from '../ports/session-revocation-store.js';
import type { Clock } from '../ports/clock.js';
import type { IdentityUseCaseContext } from '../application/context.js';
import { createIdentity, buildIdentityContext, type Identity } from '../identity.js';
import {
  createInMemoryIdentityStore,
  type InMemoryIdentityStore,
} from './in-memory-identity-store.js';

/** v1 等价事务重试(装配缺省由 app 持有;测试用等价值断行为) */
export const V1_TX_RETRY: TxRetryPolicy = { maxAttempts: 5, baseDelayMs: 15, maxJitterMs: 20 };

/** 测试配置:v1 消费面等价值(挑战 6 位/300s/60s/5 次;双 realm;宽词表) */
export const TEST_CONFIG: IdentityConfigInput = {
  identifiers: ['email', 'phone', 'username'],
  providers: ['github', 'google'],
  challengeKinds: ['user_login_code', 'user_register_code', 'admin_login_code'],
  realms: ['user', 'admin'],
  passwordPolicy: { minLength: 10, maxLength: 128 },
  challenge: { digits: 6, ttlMs: 300_000, cooldownMs: 60_000, maxAttempts: 5 },
  codePepper: 'test-pepper-0123456789abcdef',
  totp: { issuer: 'tokenlens-test', stepSec: 30, windowSteps: 1, recoveryCount: 10 },
  sessions: {
    user: { issuer: 'tokenlens-console', secret: 'test-user-secret-0123456789', ttlSec: 86_400 },
    admin: { issuer: 'tokenlens-admin', secret: 'test-admin-secret-0123456789', ttlSec: 86_400 },
  },
  oauth: {
    github: { clientId: 'gh-client', clientSecret: 'gh-secret' },
    google: { clientId: 'gg-client', clientSecret: 'gg-secret' },
  },
  oauthStateTtlSec: 600,
};

export interface InMemoryAuditSink {
  readonly events: IdentityAuditEvent[];
  record(event: IdentityAuditEvent): Promise<void>;
}

export function createInMemoryAuditSink(): InMemoryAuditSink {
  const events: IdentityAuditEvent[] = [];
  return {
    events,
    async record(event) {
      events.push(event);
    },
  };
}

export interface InMemoryMailer extends Mailer {
  readonly sent: Array<{ to: string; code: string; ip: string; locale?: 'en' | 'zh' }>;
  failNext(): void;
}

export function createInMemoryMailer(): InMemoryMailer {
  const sent: InMemoryMailer['sent'] = [];
  let fail = false;
  return {
    sent,
    failNext() {
      fail = true;
    },
    async sendLoginCode(to, code, ctx) {
      if (fail) {
        fail = false;
        throw new Error('smtp delivery failed');
      }
      sent.push({ to, code, ip: ctx.ip, ...(ctx.locale != null ? { locale: ctx.locale } : {}) });
    },
  };
}

export interface InMemoryRevocationStore extends SessionRevocationStore {
  readonly revoked: Map<string, number>;
  failReads: boolean;
}

export function createInMemoryRevocationStore(): InMemoryRevocationStore {
  const revoked = new Map<string, number>();
  return {
    revoked,
    failReads: false,
    async revoke(jti, remainingTtlSec) {
      revoked.set(jti, remainingTtlSec);
    },
    async isRevoked(jti) {
      if (this.failReads) throw new Error('redis unavailable');
      return revoked.has(jti);
    },
  };
}

export interface InMemoryOAuthStateStore extends OAuthStateStore {
  readonly saved: Map<string, { provider: string; next?: string }>;
  failWrites: boolean;
}

export function createInMemoryOAuthStateStore(): InMemoryOAuthStateStore {
  const saved = new Map<string, { provider: string; next?: string }>();
  return {
    saved,
    failWrites: false,
    async save(state, payload) {
      if (this.failWrites) throw new Error('redis unavailable');
      saved.set(state, payload);
    },
    async consume(state) {
      const payload = saved.get(state) ?? null;
      saved.delete(state);
      return payload;
    },
  };
}

export interface TestCaptcha extends Captcha {
  next: { ok: true } | { ok: false; reason: 'invalid' | 'unavailable' };
}

export function createTestCaptcha(): TestCaptcha {
  return {
    next: { ok: true },
    async verify() {
      return this.next;
    },
  };
}

export interface TestHarness {
  readonly api: Identity;
  readonly ctx: IdentityUseCaseContext;
  readonly store: InMemoryIdentityStore;
  readonly mailer: InMemoryMailer;
  readonly revocation: InMemoryRevocationStore;
  readonly oauthState: InMemoryOAuthStateStore;
  readonly captcha: TestCaptcha;
  readonly audit: InMemoryAuditSink;
  readonly setClock: (when: Date) => void;
  readonly advanceClockMs: (ms: number) => void;
}

/** fake db:transaction = 快照 → 执行 → 异常恢复快照后重抛(回滚语义,accounts 同款);
 * execute = no-op(满足 runTx 的 Db 形状与 advisoryLock 的 SQL 执行面——内存替身
 * 单线程临界区,锁语义由真实 PG 门禁复验)。tx 自引用经闭包捕获(不落模块级)。 */
function createFakeDb(store: InMemoryIdentityStore): Db {
  const fakeDb = {
    transaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => {
      const snap = store.snapshot();
      try {
        return await fn(fakeDb as unknown as Db);
      } catch (error) {
        store.restore(snap);
        throw error;
      }
    },
    execute: async () => ({ rows: [] }),
  } as unknown as Db;
  return fakeDb;
}

export function createTestHarness(config: IdentityConfigInput = TEST_CONFIG): TestHarness {
  let clock = new Date('2026-08-23T00:00:00Z');
  const clockPort: Clock = { now: () => clock };
  const store = createInMemoryIdentityStore(clockPort);
  const mailer = createInMemoryMailer();
  const revocation = createInMemoryRevocationStore();
  const oauthState = createInMemoryOAuthStateStore();
  const captcha = createTestCaptcha();
  const audit = createInMemoryAuditSink();
  const fakeDb = createFakeDb(store);

  const api = createIdentity({
    db: fakeDb,
    txRetry: V1_TX_RETRY,
    clock: clockPort,
    logger: { warn: () => undefined },
    config,
    store,
    mailer,
    captcha,
    sessionRevocation: revocation,
    oauthStateStore: oauthState,
    auditSink: audit,
  });

  const ctx = buildIdentityContext({
    db: fakeDb,
    txRetry: V1_TX_RETRY,
    clock: clockPort,
    logger: { warn: () => undefined },
    config,
    store,
    mailer,
    captcha,
    sessionRevocation: revocation,
    oauthStateStore: oauthState,
    auditSink: audit,
  });

  return {
    api,
    ctx,
    store,
    mailer,
    revocation,
    oauthState,
    captcha,
    audit,
    setClock: (when) => {
      clock = when;
    },
    advanceClockMs: (ms) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}
