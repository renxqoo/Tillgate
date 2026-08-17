/**
 * 账户解析与行锁：复式账本的串行化点。
 * 多腿交易按 account_id 定序加锁（防死锁）；冻结账户拒绝资金变动。
 */
import { and, eq, inArray } from 'drizzle-orm';
import { FrozenAccountError } from './errors';
import { walletAccounts } from './schema';
import type { DbLike, Tx } from './internal';

export interface LockedAccount {
  id: string;
  kind: string;
  currency: string;
  balance: string;
  inFlight: string;
  creditLimit: string;
  status: string;
}

/** 解析用户账户（无则建）；返回账户 id */
export async function resolveUserAccount(
  db: DbLike,
  userId: number,
  currency: string,
): Promise<string> {
  await db
    .insert(walletAccounts)
    .values({ kind: 'user', userId, currency })
    .onConflictDoNothing();
  const [row] = await db
    .select({ id: walletAccounts.id })
    .from(walletAccounts)
    .where(
      and(eq(walletAccounts.kind, 'user'), eq(walletAccounts.userId, userId), eq(walletAccounts.currency, currency)),
    );
  if (!row) throw new Error('wallet user account resolve failed');
  return row.id;
}

/** 解析内部科目账户（无则建） */
export async function resolveInternalAccount(
  db: DbLike,
  code: string,
  currency: string,
): Promise<string> {
  await db
    .insert(walletAccounts)
    .values({ kind: 'internal', code, currency })
    .onConflictDoNothing();
  const [row] = await db
    .select({ id: walletAccounts.id })
    .from(walletAccounts)
    .where(
      and(eq(walletAccounts.kind, 'internal'), eq(walletAccounts.code, code), eq(walletAccounts.currency, currency)),
    );
  if (!row) throw new Error('wallet internal account resolve failed');
  return row.id;
}

/** 按 AccountRef 解析（userId 或 code 二选一） */
export async function resolveAccount(db: DbLike, ref: { userId?: number; code?: string }, currency: string): Promise<string> {
  if (typeof ref.userId === 'number') return resolveUserAccount(db, ref.userId, currency);
  return resolveInternalAccount(db, ref.code ?? 'outside', currency);
}

/**
 * 按 id 定序锁定多账户（死锁安全：全局一致的加锁顺序）。
 * 任一冻结即抛 FrozenAccountError（整个事务回滚）。
 */
export async function lockAccounts(tx: Tx, accountIds: readonly string[]): Promise<Map<string, LockedAccount>> {
  const ordered = [...new Set(accountIds)].toSorted();
  if (ordered.length === 0) return new Map();
  const rows = await tx
    .select({
      id: walletAccounts.id,
      kind: walletAccounts.kind,
      currency: walletAccounts.currency,
      balance: walletAccounts.balance,
      inFlight: walletAccounts.inFlight,
      creditLimit: walletAccounts.creditLimit,
      status: walletAccounts.status,
    })
    .from(walletAccounts)
    .where(inArray(walletAccounts.id, ordered))
    .for('update');
  const map = new Map<string, LockedAccount>();
  for (const row of rows) {
    if (row.status === 'frozen') throw new FrozenAccountError(row.id);
    map.set(row.id, row);
  }
  for (const id of ordered) {
    if (!map.has(id)) throw new Error(`wallet account lock failed: ${id}`);
  }
  return map;
}
