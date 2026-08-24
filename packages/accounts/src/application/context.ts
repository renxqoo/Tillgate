/**
 * 用例上下文与装配策略(DESIGN §2.2/§6)。
 * policy 全部可变阈值必填注入(铁律 3;v1 等价值见字段注释);
 * now 是输入预检时钟(仅 expiresAt 未来性等创建前判定),落库时间一律存储时钟。
 */
import type { Db } from '@tillgate/db';
import type { TxRetryPolicy } from '@tillgate/db';
import type { AccountStorePort } from '../ports/account-store.js';
import type { WalletCreditPort } from '../ports/wallet-credit.js';
import type { AuditPort } from '../ports/audit.js';
import type { SessionInvalidationPort } from '../ports/session-invalidation.js';

export interface AccountsPolicy {
  /** Key 前缀(^[a-z][a-z0-9_-]{1,15}$;与网关分派端同一 env;v1 等价 'sk_') */
  readonly keyPrefix: string;
  /** 邀请有效期毫秒(v1 等价 7 天) */
  readonly invitationTtlMs: number;
  /** 待接受上限系数(v1 等价 2;上限 = min(max(剩余席位,1)×factor, cap)) */
  readonly invitationPendingFactor: number;
  /** 待接受上限封顶(v1 等价 20) */
  readonly invitationPendingCap: number;
  /** 金额类上限上界(十进制串;v1 等价 '1000000000000') */
  readonly amountLimitUpper: string;
  /** rpm 上界(v1 等价 1_000_000) */
  readonly rpmLimitMax: number;
  /** tpm 上界(v1 等价 100_000_000) */
  readonly tpmLimitMax: number;
  /** App scope.models 条数上界(v1 等价 100) */
  readonly scopeModelsMax: number;
  /** 概览被邀名单长度(v1 等价 100) */
  readonly referralInviteeLimit: number;
  /** 列表缺省与上界(v1 等价 page=1 / limit=20 / max=100) */
  readonly listPage: { readonly page: number; readonly limit: number; readonly maxLimit: number };
  /** 封禁缺省原因(v1 等价「管理员封禁」) */
  readonly banDefaultReason: string;
}

export interface UseCaseContext {
  readonly db: Db;
  readonly store: AccountStorePort;
  readonly walletCredit: WalletCreditPort;
  /** 会话失效 bridge(§3.4 唯一所有者 = identity;email 变更同事务推进吊销线) */
  readonly sessionInvalidation: SessionInvalidationPort;
  readonly audit: AuditPort;
  readonly policy: AccountsPolicy;
  readonly txRetry: TxRetryPolicy;
  readonly now: () => Date;
}
