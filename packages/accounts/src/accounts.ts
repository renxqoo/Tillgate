/**
 * createAccounts facade(DESIGN §2.2):唯一公共装配入口。
 * db/walletCredit/policy/txRetry/now 必填(零隐藏默认,铁律 3);store/auditSink
 * 是测试缝——省略时内部装配 postgres 适配器(生产单一路径)。
 */
import type { Db, TxRetryPolicy } from '@tokenlens/db';
import { createPostgresAccountStore } from './adapters/postgres/account-store.js';
import { createPostgresAuditSink } from './adapters/postgres/audit-sink.js';
import type { AccountStorePort } from './ports/account-store.js';
import type { WalletCreditPort } from './ports/wallet-credit.js';
import type { AuditPort } from './ports/audit.js';
import { createAccountUseCases, type AccountUseCases } from './application/create-use-cases.js';
import type { AccountsPolicy, UseCaseContext } from './application/context.js';

export interface AccountsEnv {
  readonly db: Db;
  readonly walletCredit: WalletCreditPort;
  readonly policy: AccountsPolicy;
  readonly txRetry: TxRetryPolicy;
  /** 输入预检时钟(创建前 expiresAt 未来性等);落库时间一律存储时钟(DESIGN §5) */
  readonly now: () => Date;
  /** 测试缝:持久化替身;省略时装配 postgres 适配器 */
  readonly store?: AccountStorePort;
  /** 测试缝:审计替身;省略时装配 postgres audit-sink */
  readonly auditSink?: AuditPort;
}

export function createAccounts(env: AccountsEnv): AccountUseCases {
  const store = env.store ?? createPostgresAccountStore();
  const audit = env.auditSink ?? createPostgresAuditSink();
  const ctx: UseCaseContext = {
    db: env.db,
    store,
    walletCredit: env.walletCredit,
    audit,
    policy: env.policy,
    txRetry: env.txRetry,
    now: env.now,
  };
  return createAccountUseCases(ctx);
}
