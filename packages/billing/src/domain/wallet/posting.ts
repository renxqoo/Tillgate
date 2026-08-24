/**
 * 过账规则（纯函数）：复式账本写入前的全部结构性校验——
 * 调用方（用例）先锁好账户，本模块决定「这组腿能不能落账」。
 *
 *   业务交易（credit/settle/refund/transfer）：≥ 2 腿、Σ 腿 = 0、账户不重复、币种单一
 *   审计交易（credit_line/freeze）：恰好 1 条零额腿（Σ=0 平凡成立），回执字段必填
 * 不变量破坏 = 红灯缺陷（DefectError）：确定性失败，不应被重试掩盖。
 */
import { DefectError } from '@tillgate/errors';
import { Decimal } from '../money.js';

export type TransactionKind =
  | 'credit'
  | 'settle'
  | 'refund'
  | 'transfer'
  | 'credit_line'
  | 'freeze';

export interface PostingLegSpec {
  accountId: string;
  currency: string;
  /** 有符号：正 = 入（贷），负 = 出（借） */
  amount: Decimal;
}

export interface PostingSpec {
  kind: TransactionKind;
  refType: string;
  refId: string;
  memo?: string;
  /** credit_line 行的新授信额（审计回执，其余 kind 禁用） */
  creditLimitAfter?: string;
  /** freeze 行首次提交后的目标状态（审计回执，其余 kind 禁用） */
  frozenAfter?: boolean;
  commandFingerprint: string;
  legs: readonly PostingLegSpec[];
}

export function isAuditKind(kind: TransactionKind): boolean {
  return kind === 'credit_line' || kind === 'freeze';
}

function invariant(detail: string): DefectError {
  return new DefectError(`wallet invariant violated: ${detail}`, 'billing.wallet_invariant', {
    detail,
  });
}

/**
 * 结构性校验（全部通过才可写库；DB 侧 check/触发器兜底同一组定律）。
 * 调用方须保证 legs 覆盖的账户全部已被 FOR UPDATE 锁定（传 lockedIds 证明）。
 */
export function validatePosting(spec: PostingSpec, lockedIds: ReadonlySet<string>): void {
  const audit = isAuditKind(spec.kind);
  if ((audit && spec.legs.length !== 1) || (!audit && spec.legs.length < 2)) {
    throw invariant(`posting ${spec.kind}: leg count ${spec.legs.length}`);
  }
  const seen = new Set<string>();
  let total = new Decimal(0);
  let currency: string | undefined;
  for (const leg of spec.legs) {
    if (!lockedIds.has(leg.accountId)) {
      throw invariant(`posting: account ${leg.accountId} not locked`);
    }
    if (seen.has(leg.accountId)) {
      throw invariant(`posting: duplicate account ${leg.accountId}`);
    }
    seen.add(leg.accountId);
    if (currency !== undefined && currency !== leg.currency) {
      throw invariant(`posting: currency mismatch ${currency}/${leg.currency}`);
    }
    currency = leg.currency;
    total = total.plus(leg.amount);
  }
  if (!total.isZero()) {
    throw invariant(`posting ${spec.refType}/${spec.refId}: unbalanced ${total.toString()}`);
  }
  if (audit && !spec.legs[0]!.amount.isZero()) {
    throw invariant(`posting ${spec.kind}: audit leg must be zero`);
  }
  if (spec.kind === 'freeze' && spec.frozenAfter === undefined) {
    throw invariant('posting freeze: frozenAfter receipt missing');
  }
  if (spec.kind === 'credit_line' && spec.creditLimitAfter === undefined) {
    throw invariant('posting credit_line: creditLimitAfter receipt missing');
  }
}

/** 腿链恒等：after = before + amount（写库前在领域层算好，DB check 同律兜底） */
export function legBalanceAfter(balanceBefore: string, amount: Decimal): string {
  return new Decimal(balanceBefore).plus(amount).toString();
}
