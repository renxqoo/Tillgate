/** 复式过账内核：完整 posting 的唯一写入口。 */
import type { Tx } from './internal';
import type { LockedAccount } from './account';
import { walletTransactions } from './schema';
import { applyLeg } from './legs';
import { Decimal } from './money';
import { WalletInternalError } from './errors';

type TransactionKind = 'credit' | 'settle' | 'refund' | 'transfer' | 'credit_line' | 'freeze';

export interface PostingLeg {
  accountId: string;
  currency: string;
  amount: Decimal;
}

export interface PostingInput {
  kind: TransactionKind;
  refType: string;
  refId: string;
  memo?: string;
  creditLimitAfter?: string;
  frozenAfter?: boolean;
  commandFingerprint: string;
  legs: readonly PostingLeg[];
}

export interface PostingReceipt {
  transactionId: number;
  balanceAfter: ReadonlyMap<string, string>;
}

/** 调用方必须先一次性锁好 accounts；内核拥有平账、回执字段和腿链写入。 */
export async function postTransaction(
  tx: Tx,
  input: PostingInput,
  accounts: ReadonlyMap<string, LockedAccount>,
): Promise<PostingReceipt> {
  const audit = input.kind === 'credit_line' || input.kind === 'freeze';
  if ((audit && input.legs.length !== 1) || (!audit && input.legs.length < 2)) {
    throw new WalletInternalError('posting.leg_count', input.kind);
  }
  const accountIds = new Set<string>();
  let total = new Decimal(0);
  let currency: string | undefined;
  for (const leg of input.legs) {
    if (!accounts.has(leg.accountId))
      throw new WalletInternalError('posting.account_not_locked', leg.accountId);
    if (accountIds.has(leg.accountId))
      throw new WalletInternalError('posting.duplicate_account', leg.accountId);
    accountIds.add(leg.accountId);
    if (currency !== undefined && currency !== leg.currency) {
      throw new WalletInternalError('posting.currency_mismatch', `${currency}/${leg.currency}`);
    }
    currency = leg.currency;
    total = total.plus(leg.amount);
  }
  if (!total.isZero()) throw new WalletInternalError('posting.unbalanced', total.toString());
  if (audit && !input.legs[0]!.amount.isZero()) {
    throw new WalletInternalError('posting.audit_non_zero', input.kind);
  }
  if (input.kind === 'freeze' && input.frozenAfter === undefined) {
    throw new WalletInternalError('posting.freeze_receipt_missing');
  }
  if (input.kind === 'credit_line' && input.creditLimitAfter === undefined) {
    throw new WalletInternalError('posting.credit_limit_receipt_missing');
  }

  const [header] = await tx
    .insert(walletTransactions)
    .values({
      kind: input.kind,
      refType: input.refType,
      refId: input.refId,
      memo: input.memo,
      creditLimitAfter: input.creditLimitAfter,
      frozenAfter: input.frozenAfter,
      commandFingerprint: input.commandFingerprint,
    })
    .returning({ id: walletTransactions.id });
  if (!header) throw new WalletInternalError('posting.header_insert', input.kind);

  const balanceAfter = new Map<string, string>();
  for (const leg of input.legs) {
    const account = accounts.get(leg.accountId)!;
    balanceAfter.set(
      leg.accountId,
      await applyLeg(tx, header.id, leg.accountId, leg.currency, leg.amount, account.balance),
    );
  }
  return { transactionId: header.id, balanceAfter };
}
