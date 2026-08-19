/**
 * wallet 用例族装配出口：八个动词各居一文件，此处只做组合（进程级 env 一次注入）。
 *
 *   credit / authorize / settle / release / transfer / setCreditLimit / accounts / statement
 *
 * 不变量（domain 层定律 + 各用例内部顺序）：
 *   - 一切写动词在事务内；input.tx 可注入调用方共享事务（billing §4 依赖此口）
 *   - 幂等三段式：快速路径查既有 → 唯一冲突兜底重放 → 同键异命令拒绝（409）
 *   - 出账守卫唯一口径（@ai-gateway/domain 的 assertCanDebit）；结算 ≤ 冻结额（内核保证）
 *   - 释放审计在冻结单本身，不落交易（零额噪声行取消）
 *
 * billing 等上层域可按需只取个别动词工厂（createSettleUseCase 等），无须整体装配。
 */
import type { AccountSnapshot } from '@ai-gateway/domain';
import type { RunContext } from '../context.js';
import { createCreditUseCase, type CreditInput, type CreditResult } from './credit.js';
import {
  createAuthorizeUseCase,
  type AuthorizeInput,
  type AuthorizeResult,
} from './authorize.js';
import { createSettleUseCase, type SettleInput, type SettleResult } from './settle.js';
import { createReleaseUseCase, type ReleaseInput, type ReleaseResult } from './release.js';
import { createRefundUseCase, type RefundInput, type RefundResult } from './refund.js';
import {
  createTransferUseCase,
  type TransferInput,
  type TransferResult,
} from './transfer.js';
import {
  createSetCreditLimitUseCase,
  type SetCreditLimitInput,
  type SetCreditLimitResult,
} from './credit-line.js';
import { createAccountsUseCase } from './accounts.js';
import {
  createStatementUseCase,
  type StatementItemView,
  type StatementQuery,
} from './statement.js';
import { assertCurrency } from '@ai-gateway/domain';
import type { WalletEnv } from './env.js';

export type { WalletEnv } from './env.js';
export { OUTSIDE_ACCOUNT, REVENUE_ACCOUNT } from '@ai-gateway/domain';
export type {
  CreditInput,
  CreditResult,
  AuthorizeInput,
  AuthorizeResult,
  SettleInput,
  SettleResult,
  ReleaseInput,
  ReleaseResult,
  TransferInput,
  TransferResult,
  SetCreditLimitInput,
  SetCreditLimitResult,
  RefundInput,
  RefundResult,
  StatementQuery,
  StatementItemView,
};

export interface WalletApi {
  credit(ctx: RunContext, input: CreditInput): Promise<CreditResult>;
  authorize(ctx: RunContext, input: AuthorizeInput): Promise<AuthorizeResult>;
  settle(ctx: RunContext, input: SettleInput): Promise<SettleResult>;
  release(ctx: RunContext, input: ReleaseInput): Promise<ReleaseResult>;
  refund(ctx: RunContext, input: RefundInput): Promise<RefundResult>;
  transfer(ctx: RunContext, input: TransferInput): Promise<TransferResult>;
  setCreditLimit(ctx: RunContext, input: SetCreditLimitInput): Promise<SetCreditLimitResult>;
  /** 用户全部币种账户摘要（读侧） */
  accounts(ctx: RunContext, userId: number): Promise<AccountSnapshot[]>;
  /** 用户资金流水（腿级，id 倒序游标分页；读侧） */
  statement(ctx: RunContext, input: StatementQuery): Promise<StatementItemView[]>;
}

export function createWallet(env: WalletEnv): WalletApi {
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
