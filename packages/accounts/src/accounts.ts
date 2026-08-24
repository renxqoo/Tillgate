/**
 * createAccounts facade(DESIGN §2.2):唯一公共装配入口。
 * db/walletCredit/policy/txRetry/now 必填(零隐藏默认,铁律 3);store/auditSink
 * 是测试缝——省略时内部装配 postgres 适配器(生产单一路径)。
 */
import type { Db, TxRetryPolicy } from '@tillgate/db';
import { createPostgresAccountStore } from './adapters/postgres/account-store.js';
import { createPostgresAuditSink } from './adapters/postgres/audit-sink.js';
import { isValidKeyPrefix } from './domain/credentials.js';
import type { AccountStorePort } from './ports/account-store.js';
import type { WalletCreditPort } from './ports/wallet-credit.js';
import type { AuditPort } from './ports/audit.js';
import type { SessionInvalidationPort } from './ports/session-invalidation.js';
import { createAccountUseCases, type AccountUseCases } from './application/create-use-cases.js';
import type { AccountsPolicy, UseCaseContext } from './application/context.js';

export interface AccountsEnv {
  readonly db: Db;
  readonly walletCredit: WalletCreditPort;
  /** 会话失效 bridge(§3.4 唯一所有者 = identity;必填——生产由 assembly 桥接 anchor advance) */
  readonly sessionInvalidation: SessionInvalidationPort;
  readonly policy: AccountsPolicy;
  readonly txRetry: TxRetryPolicy;
  /** 输入预检时钟(创建前 expiresAt 未来性等);落库时间一律存储时钟(DESIGN §5) */
  readonly now: () => Date;
  /** 测试缝:持久化替身;省略时装配 postgres 适配器 */
  readonly store?: AccountStorePort;
  /** 测试缝:审计替身;省略时装配 postgres audit-sink */
  readonly auditSink?: AuditPort;
}

/** 装配期 policy fail-fast(铁律 3:必填且形状合法——非法 keyPrefix 会产出网关不可分派的 Key) */
function assertPolicyShape(policy: AccountsPolicy): void {
  if (policy == null || typeof policy !== 'object') {
    throw new Error('accounts policy invalid: policy object is required');
  }
  if (!isValidKeyPrefix(policy.keyPrefix)) {
    throw new Error(
      `accounts policy invalid: keyPrefix '${policy.keyPrefix}' must match ^[a-z][a-z0-9_-]{1,15}$`,
    );
  }
  if (!Number.isFinite(policy.invitationTtlMs) || policy.invitationTtlMs <= 0) {
    throw new Error('accounts policy invalid: invitationTtlMs must be a positive number');
  }
  if (!Number.isFinite(policy.invitationPendingFactor) || policy.invitationPendingFactor <= 0) {
    throw new Error('accounts policy invalid: invitationPendingFactor must be positive');
  }
  if (!Number.isInteger(policy.invitationPendingCap) || policy.invitationPendingCap <= 0) {
    throw new Error('accounts policy invalid: invitationPendingCap must be a positive integer');
  }
  if (!Number.isInteger(policy.rpmLimitMax) || policy.rpmLimitMax <= 0) {
    throw new Error('accounts policy invalid: rpmLimitMax must be a positive integer');
  }
  if (!Number.isInteger(policy.tpmLimitMax) || policy.tpmLimitMax <= 0) {
    throw new Error('accounts policy invalid: tpmLimitMax must be a positive integer');
  }
  if (typeof policy.banDefaultReason !== 'string' || policy.banDefaultReason.length === 0) {
    throw new Error('accounts policy invalid: banDefaultReason must be a non-empty string');
  }
}

export function createAccounts(env: AccountsEnv): AccountUseCases {
  assertPolicyShape(env.policy);
  const store = env.store ?? createPostgresAccountStore();
  const audit = env.auditSink ?? createPostgresAuditSink();
  const ctx: UseCaseContext = {
    db: env.db,
    store,
    walletCredit: env.walletCredit,
    sessionInvalidation: env.sessionInvalidation,
    audit,
    policy: env.policy,
    txRetry: env.txRetry,
    now: env.now,
  };
  return createAccountUseCases(ctx);
}
