/**
 * 包内测试 harness:内存替身 + 快照回滚 fake db + 绑定用例表。
 * 仅 __test__ 消费;不进入公共 exports。
 */
import type { Db, TxRetryPolicy } from '@tillgate/db';
import type { AccountsPolicy } from '../application/context.js';
import { createAccountUseCases, type AccountUseCases } from '../application/create-use-cases.js';
import type { UseCaseContext } from '../application/context.js';
import type { AuditPort, AuditAction } from '../ports/audit.js';
import type { CreditCommand, CreditResult, WalletCreditPort } from '../ports/wallet-credit.js';
import type { SessionInvalidationPort } from '../ports/session-invalidation.js';
import {
  createInMemoryAccountStore,
  type InMemoryAccountStore,
} from './in-memory-account-store.js';

/** 内存会话失效 bridge:记录调用序供断言(语义等价 identity anchor advance 的观察面) */
export interface InMemorySessionInvalidation extends SessionInvalidationPort {
  readonly calls: Array<{ realm: string; userId: number }>;
}

export function createInMemorySessionInvalidation(): InMemorySessionInvalidation {
  const calls: InMemorySessionInvalidation['calls'] = [];
  return {
    calls,
    async invalidateUserSessions(_db, input) {
      calls.push({ realm: input.realm, userId: input.userId });
    },
  };
}

/** 事务重试策略(装配缺省由 app 持有;测试用等价值断行为) */
export const V1_TX_RETRY: TxRetryPolicy = { maxAttempts: 5, baseDelayMs: 15, maxJitterMs: 20 };

export const V1_POLICY: AccountsPolicy = {
  keyPrefix: 'sk_',
  invitationTtlMs: 7 * 86_400_000,
  invitationPendingFactor: 2,
  invitationPendingCap: 20,
  amountLimitUpper: '1000000000000',
  rpmLimitMax: 1_000_000,
  tpmLimitMax: 100_000_000,
  scopeModelsMax: 100,
  referralInviteeLimit: 100,
  listPage: { page: 1, limit: 20, maxLimit: 100 },
  banDefaultReason: '管理员封禁',
};

/** 内存 wallet 替身:自然键幂等 + 失败注入(broken wallet 验证回滚) */
export interface InMemoryWalletCredit extends WalletCreditPort {
  readonly credits: CreditCommand[];
  /** 命中即抛(注入 side 匹配的 refId) */
  failOnRefId(refId: string): void;
}

export function createInMemoryWalletCredit(): InMemoryWalletCredit {
  const credits: CreditCommand[] = [];
  let failRefId: string | null = null;
  return {
    credits,
    failOnRefId(refId) {
      failRefId = refId;
    },
    async credit(_db, command) {
      if (failRefId !== null && command.refId === failRefId) {
        throw new Error(`wallet credit failed: ${command.refId}`);
      }
      const replayed = credits.some(
        (c) => c.refType === command.refType && c.refId === command.refId,
      );
      if (!replayed) credits.push(command);
      const result: CreditResult = { replayed };
      return result;
    },
  };
}

/** 内存审计替身 */
export interface InMemoryAuditSink extends AuditPort {
  readonly actions: AuditAction[];
}

export function createInMemoryAuditSink(): InMemoryAuditSink {
  const actions: AuditAction[] = [];
  return {
    actions,
    async record(_db, action) {
      actions.push(action);
    },
  };
}

export interface TestHarness {
  readonly api: AccountUseCases;
  readonly ctx: UseCaseContext;
  readonly store: InMemoryAccountStore;
  readonly wallet: InMemoryWalletCredit;
  readonly audit: InMemoryAuditSink;
  readonly sessionInvalidation: InMemorySessionInvalidation;
  readonly setClock: (when: Date) => void;
  readonly advanceClockMs: (ms: number) => void;
}

/**
 * fake db:transaction = 快照 → 执行 → 异常恢复快照后重抛(回滚语义)。
 * 满足 runTx 的 Db 形状(仅用到 .transaction)。
 */
function createFakeDb(store: InMemoryAccountStore): Db {
  return {
    transaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => {
      const snap = store.snapshot();
      try {
        return await fn(fakeDb);
      } catch (error) {
        store.restore(snap);
        throw error;
      }
    },
  } as unknown as Db;
}

let fakeDb: Db;

export function createTestHarness(policy: AccountsPolicy = V1_POLICY): TestHarness {
  let clock = new Date('2026-08-23T00:00:00Z');
  const store = createInMemoryAccountStore(() => clock);
  const wallet = createInMemoryWalletCredit();
  const audit = createInMemoryAuditSink();
  const sessionInvalidation = createInMemorySessionInvalidation();
  fakeDb = createFakeDb(store);
  const ctx: UseCaseContext = {
    db: fakeDb,
    store,
    walletCredit: wallet,
    sessionInvalidation,
    audit,
    policy,
    txRetry: V1_TX_RETRY,
    now: () => clock,
  };
  return {
    api: createAccountUseCases(ctx),
    ctx,
    store,
    wallet,
    audit,
    sessionInvalidation,
    setClock: (when) => {
      clock = when;
    },
    advanceClockMs: (ms) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}
