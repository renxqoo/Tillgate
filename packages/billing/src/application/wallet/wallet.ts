/**
 * wallet 动词族装配出口：动词各居一文件，此处只做组合（装配参数一次注入）。
 *
 *   credit / authorize / settle / release / refund / transfer / setCreditLimit
 *   / accounts / statement
 *
 * 不变量（domain 定律 + 各动词内部顺序）：
 *   - 一切写动词在事务内；包内上层用例经 TxChannel 共享事务（SAVEPOINT 隔离）
 *   - 幂等三段式：快速路径查既有 → 唯一冲突兜底重放 → 同键异命令拒绝（409）
 *   - 出账守卫唯一口径（domain exposure）；结算 ≤ 冻结额（内核保证）
 *   - 释放审计在冻结单本身，不落交易（零额噪声行取消）
 *
 * U2 计费授权链可按需只取个别动词工厂（createAuthorizeUseCase 等），无须整体装配。
 * freeze 动词不在活路径（旧仓无生产调用方，状态由管理面置位）——归属 admin 迁移单元裁决。
 */
import type { AccountSnapshot } from '../../domain/wallet/accounts.js';
import { assertCurrency, type WalletGuards } from '../../domain/wallet/guards.js';
import type { WalletStore } from '../../ports/wallet-store.js';
import { createAccountsUseCase } from './accounts.js';
import { createAuthorizeUseCase } from './authorize.js';
import type { AuthorizeInput, AuthorizeResult } from './authorize.js';
import { createCreditUseCase } from './credit.js';
import type { CreditInput, CreditResult } from './credit.js';
import {
  createSetCreditLimitUseCase,
  type SetCreditLimitInput,
  type SetCreditLimitResult,
} from './credit-line.js';
import { createRefundUseCase } from './refund.js';
import type { RefundInput, RefundResult } from './refund.js';
import { createReleaseUseCase } from './release.js';
import type { ReleaseInput, ReleaseResult } from './release.js';
import { createSettleUseCase } from './settle.js';
import type { SettleInput, SettleResult } from './settle.js';
import { createStatementUseCase } from './statement.js';
import type { StatementItemView, StatementQuery } from './statement.js';
import { createTransferUseCase, type TransferInput, type TransferResult } from './transfer.js';

/** 装配契约（storage port + 词表白名单 + 缺省币种——全部必填注入，不藏全局默认） */

export type {
  CreditInput,
  CreditResult,
  AuthorizeInput,
  AuthorizeResult,
  SettleInput,
  SettleResult,
  ReleaseInput,
  ReleaseResult,
  RefundInput,
  RefundResult,
  TransferInput,
  TransferResult,
  StatementQuery,
  StatementItemView,
  SetCreditLimitInput,
  SetCreditLimitResult,
} from './verb-types.js';

export interface WalletEnv {
  store: WalletStore;
  guards: WalletGuards;
  /** 本装配的记账币种（ISO-4217）：调用方未显式传币种时的缺省口径 */
  currency: string;
}

export interface WalletApi {
  credit(input: CreditInput): Promise<CreditResult>;
  authorize(input: AuthorizeInput): Promise<AuthorizeResult>;
  settle(input: SettleInput): Promise<SettleResult>;
  release(input: ReleaseInput): Promise<ReleaseResult>;
  refund(input: RefundInput): Promise<RefundResult>;
  transfer(input: TransferInput): Promise<TransferResult>;
  setCreditLimit(input: SetCreditLimitInput): Promise<SetCreditLimitResult>;
  /** 用户全部币种账户摘要（读侧） */
  accounts(userId: number): Promise<AccountSnapshot[]>;
  /** 用户资金流水（腿级，id 倒序游标分页；读侧） */
  statement(input: StatementQuery): Promise<StatementItemView[]>;
}

export function createWalletApi(env: WalletEnv): WalletApi {
  assertCurrency(env.guards, env.currency);
  return {
    credit: createCreditUseCase(env),
    authorize: createAuthorizeUseCase(env),
    settle: createSettleUseCase(env),
    release: createReleaseUseCase(env),
    refund: createRefundUseCase(env),
    transfer: createTransferUseCase(env),
    setCreditLimit: createSetCreditLimitUseCase(env),
    accounts: createAccountsUseCase(env),
    statement: createStatementUseCase(env),
  };
}
