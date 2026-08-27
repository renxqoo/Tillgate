/**
 * 用例上下文与装配策略。
 * policy 全部可变阈值必填注入;
 * now 是输入预检时钟(仅 expiresAt 未来性等创建前判定),落库时间一律存储时钟。
 */
import type { Db } from '@tillgate/db';
import type { TxRetryPolicy } from '@tillgate/db';
import type { AccountStorePort } from '../ports/account-store.js';
import type { WalletCreditPort } from '../ports/wallet-credit.js';
import type { AuditPort } from '../ports/audit.js';
import type { SessionInvalidationPort } from '../ports/session-invalidation.js';

export interface AccountsPolicy {
  /** Key 前缀(^[a-z][a-z0-9_-]{1,15}$;与网关分派端同一 env) */
  readonly keyPrefix: string;
  /** 邀请有效期毫秒 */
  readonly invitationTtlMs: number;
  /** 待接受上限系数(上限 = min(max(剩余席位,1)×factor, cap)) */
  readonly invitationPendingFactor: number;
  /** 待接受上限封顶 */
  readonly invitationPendingCap: number;
  /** 金额类上限上界(十进制串) */
  readonly amountLimitUpper: string;
  /** rpm 上界 */
  readonly rpmLimitMax: number;
  /** tpm 上界 */
  readonly tpmLimitMax: number;
  /** App scope.models 条数上界 */
  readonly scopeModelsMax: number;
  /** 概览被邀名单长度 */
  readonly referralInviteeLimit: number;
  /** 列表缺省与上界 */
  readonly listPage: { readonly page: number; readonly limit: number; readonly maxLimit: number };
  /** 封禁缺省原因 */
  readonly banDefaultReason: string;
}

export interface UseCaseContext {
  readonly db: Db;
  readonly store: AccountStorePort;
  readonly walletCredit: WalletCreditPort;
  /** 会话失效 bridge(唯一所有者 = identity;email 变更同事务推进吊销线) */
  readonly sessionInvalidation: SessionInvalidationPort;
  readonly audit: AuditPort;
  readonly policy: AccountsPolicy;
  readonly txRetry: TxRetryPolicy;
  readonly now: () => Date;
}
