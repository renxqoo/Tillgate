import type { LockedAccount } from './account';
import { resolveAccount, resolveInternalAccounts } from './account';
import { InsufficientBalanceError, InsufficientCashError, SameAccountTransferError } from './errors';
import type { Tx } from './internal';
import { Decimal, toStorage } from './money';
import type { PostingLeg } from './posting';
import type { AccountRef } from './types';

export interface TransferSide {
  accountIds: readonly string[];
  currency: string;
  internal: boolean;
}

export interface TransferPosting {
  legs: PostingLeg[];
  fromBalanceAfter: string;
  toBalanceAfter: string;
}

export function assertDistinctTransferSides(
  from: AccountRef,
  fromCurrency: string,
  to: AccountRef,
  toCurrency: string,
): void {
  const same =
    fromCurrency === toCurrency &&
    (typeof from.userId === 'number'
      ? from.userId === to.userId
      : from.code !== undefined && from.code === to.code);
  if (same) {
    throw new SameAccountTransferError(
      typeof from.userId === 'number' ? `user:${from.userId}` : `internal:${from.code}`,
    );
  }
}

export async function resolveTransferSide(
  tx: Tx,
  ref: AccountRef,
  currency: string,
  shardCount: number,
): Promise<TransferSide> {
  if (typeof ref.userId === 'number') {
    return {
      accountIds: [await resolveAccount(tx, ref, currency)],
      currency,
      internal: false,
    };
  }
  return {
    accountIds: await resolveInternalAccounts(tx, ref.code!, currency, shardCount),
    currency,
    internal: true,
  };
}

function totalBalance(side: TransferSide, accounts: ReadonlyMap<string, LockedAccount>): Decimal {
  return side.accountIds.reduce(
    (total, accountId) => total.plus(accounts.get(accountId)!.balance),
    new Decimal(0),
  );
}

function orderedFromIds(accountIds: readonly string[], preferredShard: number): string[] {
  return [...accountIds.slice(preferredShard), ...accountIds.slice(0, preferredShard)];
}

/** Build a balanced posting while snapshotting every internal shard for stable replay receipts. */
export function buildTransferPosting(
  from: TransferSide,
  to: TransferSide,
  accounts: ReadonlyMap<string, LockedAccount>,
  amount: Decimal,
  preferredShard: number,
  fromUserId: number,
  allowCredit = true,
): TransferPosting {
  const fromTotal = totalBalance(from, accounts);
  const fromPrimary = accounts.get(from.accountIds[0]!)!;
  const available = from.internal
    ? fromTotal
    : fromTotal
        .plus(allowCredit ? new Decimal(fromPrimary.creditLimit) : new Decimal(0))
        .minus(fromPrimary.inFlight);
  if (available.lt(amount)) {
    if (!from.internal && !allowCredit) {
      throw new InsufficientCashError(
        fromUserId,
        toStorage(available),
        toStorage(amount),
        from.currency,
      );
    }
    throw new InsufficientBalanceError(fromUserId, toStorage(available), toStorage(amount), from.currency);
  }

  const amounts = new Map<string, Decimal>();
  for (const accountId of [...from.accountIds, ...to.accountIds]) {
    amounts.set(accountId, new Decimal(0));
  }

  let remaining = amount;
  for (const accountId of orderedFromIds(from.accountIds, from.internal ? preferredShard : 0)) {
    if (remaining.isZero()) break;
    const balance = new Decimal(accounts.get(accountId)!.balance);
    const debit = from.internal ? Decimal.min(Decimal.max(balance, 0), remaining) : remaining;
    if (debit.isZero()) continue;
    amounts.set(accountId, debit.neg());
    remaining = remaining.minus(debit);
  }
  if (!remaining.isZero()) {
    throw new InsufficientBalanceError(fromUserId, toStorage(available), toStorage(amount), from.currency);
  }

  const destinationId = to.accountIds[to.internal ? preferredShard : 0]!;
  amounts.set(destinationId, (amounts.get(destinationId) ?? new Decimal(0)).plus(amount));
  const legs = [...amounts.entries()].map(([accountId, legAmount]) => ({
    accountId,
    currency: accounts.get(accountId)!.currency,
    amount: legAmount,
  }));
  return {
    legs,
    fromBalanceAfter: toStorage(fromTotal.minus(amount)),
    toBalanceAfter: toStorage(totalBalance(to, accounts).plus(amount)),
  };
}
