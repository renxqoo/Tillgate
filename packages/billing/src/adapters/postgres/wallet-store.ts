/**
 * 钱包复式账本的 PostgreSQL adapter（ports/wallet-store 的唯一实现）。
 *
 * 语义基准：旧仓 repository/wallet.repo.ts（活路径）逐方法平移；差异点在
 * MIGRATION-U1 §4 登记（B11 定序锁显式化 / joinTransaction SAVEPOINT 隔离）。
 * 写路径约定：写方法入参必须是事务句柄（动词层保证）；账户行锁（FOR UPDATE，
 * id 定序）是复式账本的串行化点——锁外读到的余额不可用于过账。
 */
import { and, asc, desc, eq, inArray, like, lt, sql } from 'drizzle-orm';
import {
  isUniqueViolation,
  runTx,
  walletAccounts,
  walletAuthorizations,
  walletLegs,
  walletTransactions,
  type Db,
  type DbTx,
  type TxRetryPolicy,
} from '@tokenlens/db';
import type { AccountSnapshot } from '../../domain/wallet/accounts.js';
import type { AuthorizationSnapshot } from '../../domain/wallet/authorization.js';
import type {
  ReferralPayoutRow,
  StatementItemRow,
  TransactionHeader,
  WalletConn,
  WalletStore,
  WalletTx,
} from '../../ports/wallet-store.js';

/** adapter 装配入参（重试策略必填注入，铁律 3——缺省值归 app config） */
export interface PostgresWalletStoreOptions {
  retry: TxRetryPolicy;
}

/** 句柄透传：port 句柄在本 adapter 内即 db 句柄（品牌字段由工厂统一加盖） */
function asDb(conn: WalletConn): DbTx {
  return conn as unknown as DbTx;
}

function withBrand(tx: DbTx): WalletTx {
  return tx as unknown as WalletTx;
}

export function createPostgresWalletStore(
  db: Db,
  options: PostgresWalletStoreOptions,
): WalletStore {
  const { retry } = options;

  const AUTH_COLUMNS = {
    id: walletAuthorizations.id,
    accountId: walletAuthorizations.accountId,
    refType: walletAuthorizations.refType,
    refId: walletAuthorizations.refId,
    amount: walletAuthorizations.amount,
    status: walletAuthorizations.status,
    settledAmount: walletAuthorizations.settledAmount,
    authorizeFingerprint: walletAuthorizations.authorizeFingerprint,
    expiresAt: walletAuthorizations.expiresAt,
  };

  return {
    read: (fn) => fn(db as unknown as WalletConn),
    transaction: (fn) => runTx(db, (tx) => fn(withBrand(tx)), retry),
    joinTransaction: (tx, fn) => runTx(asDb(tx), (inner) => fn(withBrand(inner)), retry),

    // ---------- 账户 ----------
    async ensureUserAccount(conn, userId, currency) {
      const c = asDb(conn);
      await c
        .insert(walletAccounts)
        .values({ kind: 'user', userId, currency })
        .onConflictDoNothing();
      const [row] = await c
        .select({ id: walletAccounts.id })
        .from(walletAccounts)
        .where(
          and(
            eq(walletAccounts.kind, 'user'),
            eq(walletAccounts.userId, userId),
            eq(walletAccounts.currency, currency),
          ),
        );
      if (!row) throw new Error('wallet.ensure_user_account');
      return row.id;
    },

    async ensureInternalAccount(conn, code, currency) {
      // shard 恒 0（B9）：唯一键保留分片位，活路径语义唯一
      const c = asDb(conn);
      await c
        .insert(walletAccounts)
        .values({ kind: 'internal', code, currency, shard: 0 })
        .onConflictDoNothing();
      const [row] = await c
        .select({ id: walletAccounts.id })
        .from(walletAccounts)
        .where(
          and(
            eq(walletAccounts.kind, 'internal'),
            eq(walletAccounts.code, code),
            eq(walletAccounts.currency, currency),
            eq(walletAccounts.shard, 0),
          ),
        );
      if (!row) throw new Error('wallet.ensure_internal_account');
      return row.id;
    },

    async findUserAccountId(conn, userId, currency) {
      const [row] = await asDb(conn)
        .select({ id: walletAccounts.id })
        .from(walletAccounts)
        .where(
          and(
            eq(walletAccounts.kind, 'user'),
            eq(walletAccounts.userId, userId),
            eq(walletAccounts.currency, currency),
          ),
        );
      return row?.id ?? null;
    },

    async findInternalAccountId(conn, code, currency) {
      const [row] = await asDb(conn)
        .select({ id: walletAccounts.id })
        .from(walletAccounts)
        .where(
          and(
            eq(walletAccounts.kind, 'internal'),
            eq(walletAccounts.code, code),
            eq(walletAccounts.currency, currency),
            eq(walletAccounts.shard, 0),
          ),
        );
      return row?.id ?? null;
    },

    async lockAccounts(conn, accountIds) {
      const ordered = [...new Set(accountIds)].toSorted();
      if (ordered.length === 0) return [];
      const rows = await asDb(conn)
        .select({
          id: walletAccounts.id,
          kind: walletAccounts.kind,
          code: walletAccounts.code,
          currency: walletAccounts.currency,
          balance: walletAccounts.balance,
          inFlight: walletAccounts.inFlight,
          creditLimit: walletAccounts.creditLimit,
          status: walletAccounts.status,
        })
        .from(walletAccounts)
        .where(inArray(walletAccounts.id, ordered))
        // B11：定序锁显式化——旧实现依赖索引扫描顺序的实现细节，ORDER BY 使全局加锁顺序成为保证
        .orderBy(asc(walletAccounts.id))
        .for('update');
      if (rows.length !== ordered.length) throw new Error('wallet.lock_accounts_missing');
      return rows as AccountSnapshot[];
    },

    async userAccountSummaries(conn, userId) {
      const rows = await asDb(conn)
        .select({
          id: walletAccounts.id,
          kind: walletAccounts.kind,
          code: walletAccounts.code,
          currency: walletAccounts.currency,
          balance: walletAccounts.balance,
          inFlight: walletAccounts.inFlight,
          creditLimit: walletAccounts.creditLimit,
          status: walletAccounts.status,
        })
        .from(walletAccounts)
        .where(and(eq(walletAccounts.kind, 'user'), eq(walletAccounts.userId, userId)));
      return rows as AccountSnapshot[];
    },

    // ---------- 冻结单 ----------
    async findAuthorization(conn, refType, refId) {
      const [row] = await asDb(conn)
        .select(AUTH_COLUMNS)
        .from(walletAuthorizations)
        .where(
          and(eq(walletAuthorizations.refType, refType), eq(walletAuthorizations.refId, refId)),
        );
      return (row as AuthorizationSnapshot | undefined) ?? null;
    },

    async lockAuthorization(conn, refType, refId) {
      const [row] = await asDb(conn)
        .select(AUTH_COLUMNS)
        .from(walletAuthorizations)
        .where(
          and(eq(walletAuthorizations.refType, refType), eq(walletAuthorizations.refId, refId)),
        )
        .for('update');
      return (row as AuthorizationSnapshot | undefined) ?? null;
    },

    async insertAuthorization(conn, input) {
      const [row] = await asDb(conn)
        .insert(walletAuthorizations)
        .values({ ...input, status: 'active' })
        .returning({ id: walletAuthorizations.id });
      if (!row) throw new Error('wallet.insert_authorization');
      return row.id;
    },

    async casSettleAuthorization(conn, id, settledAmount) {
      const rows = await asDb(conn)
        .update(walletAuthorizations)
        .set({ status: 'settled', settledAmount, updatedAt: new Date() })
        .where(and(eq(walletAuthorizations.id, id), eq(walletAuthorizations.status, 'active')))
        .returning({
          accountId: walletAuthorizations.accountId,
          amount: walletAuthorizations.amount,
        });
      const row = rows[0];
      return row ? { accountId: row.accountId, heldAmount: row.amount } : null;
    },

    async casReleaseAuthorization(conn, id, releaseReason, releaseFingerprint) {
      const rows = await asDb(conn)
        .update(walletAuthorizations)
        .set({ status: 'released', releaseReason, releaseFingerprint, updatedAt: new Date() })
        .where(and(eq(walletAuthorizations.id, id), eq(walletAuthorizations.status, 'active')))
        .returning({
          accountId: walletAuthorizations.accountId,
          amount: walletAuthorizations.amount,
        });
      const row = rows[0];
      return row ? { accountId: row.accountId, amount: row.amount } : null;
    },

    // ---------- 过账 ----------
    async findTransaction(conn, refType, refId, kind) {
      const [row] = await asDb(conn)
        .select({
          id: walletTransactions.id,
          kind: walletTransactions.kind,
          commandFingerprint: walletTransactions.commandFingerprint,
          creditLimitAfter: walletTransactions.creditLimitAfter,
        })
        .from(walletTransactions)
        .where(
          and(
            eq(walletTransactions.refType, refType),
            eq(walletTransactions.refId, refId),
            eq(walletTransactions.kind, kind),
          ),
        );
      return (row as TransactionHeader | undefined) ?? null;
    },

    async findLeg(conn, transactionId, accountId) {
      const [row] = await asDb(conn)
        .select({ amount: walletLegs.amount, balanceAfter: walletLegs.balanceAfter })
        .from(walletLegs)
        .where(
          and(eq(walletLegs.transactionId, transactionId), eq(walletLegs.accountId, accountId)),
        );
      return row ?? null;
    },

    async accountOwner(conn, accountId) {
      const [row] = await asDb(conn)
        .select({ userId: walletAccounts.userId, currency: walletAccounts.currency })
        .from(walletAccounts)
        .where(eq(walletAccounts.id, accountId));
      return row ?? null;
    },

    async insertTransaction(conn, input) {
      const [row] = await asDb(conn)
        .insert(walletTransactions)
        .values(input)
        .returning({ id: walletTransactions.id });
      if (!row) throw new Error('wallet.insert_transaction');
      return row.id;
    },

    async applyLeg(conn, input) {
      const c = asDb(conn);
      await c.insert(walletLegs).values(input);
      await c
        .update(walletAccounts)
        .set({ balance: input.balanceAfter, updatedAt: new Date() })
        .where(eq(walletAccounts.id, input.accountId));
    },

    async setInFlight(conn, accountId, value) {
      await asDb(conn)
        .update(walletAccounts)
        .set({ inFlight: value, updatedAt: new Date() })
        .where(eq(walletAccounts.id, accountId));
    },

    async setCreditLimit(conn, accountId, value) {
      await asDb(conn)
        .update(walletAccounts)
        .set({ creditLimit: value, updatedAt: new Date() })
        .where(eq(walletAccounts.id, accountId));
    },

    async databaseNow(conn) {
      const result = await asDb(conn).execute<{ now: string }>(sql`select now() as now`);
      return new Date(String(result.rows[0]?.now));
    },

    // ---------- 流水（读侧） ----------
    async statementPage(conn, input) {
      const conditions = [eq(walletAccounts.kind, 'user'), eq(walletAccounts.userId, input.userId)];
      if (input.kinds && input.kinds.length > 0) {
        conditions.push(inArray(walletTransactions.kind, [...input.kinds]));
      }
      if (input.beforeLegId !== undefined) {
        conditions.push(lt(walletLegs.id, input.beforeLegId));
      }
      const rows = await asDb(conn)
        .select({
          legId: walletLegs.id,
          transactionKind: walletTransactions.kind,
          refType: walletTransactions.refType,
          refId: walletTransactions.refId,
          amount: walletLegs.amount,
          balanceAfter: walletLegs.balanceAfter,
          memo: walletTransactions.memo,
          createdAt: walletTransactions.createdAt,
        })
        .from(walletLegs)
        .innerJoin(walletAccounts, eq(walletLegs.accountId, walletAccounts.id))
        .innerJoin(walletTransactions, eq(walletLegs.transactionId, walletTransactions.id))
        .where(and(...conditions))
        .orderBy(desc(walletLegs.id))
        .limit(input.limit);
      return rows as StatementItemRow[];
    },

    /**
     * 返利流水（v1 marketing.repo listPayouts 逐语义平移）：三类同视图——佣金与注册
     * 奖励同 refType='referral' 以 refId 前缀区分,注册赠送走 refType='gift'+'signup:' 前缀
     * （前缀约定单一真相 = accounts domain/referral.ts + billing referral-commission）。
     */
    async listReferralPayouts(conn, input) {
      const referral = input.kind !== 'gift';
      let prefix = 'signup:';
      if (input.kind === 'commission') prefix = 'referral-commission:';
      else if (input.kind === 'referral_signup') prefix = 'referral-signup:';
      const conditions = [
        eq(walletTransactions.refType, referral ? 'referral' : 'gift'),
        like(walletTransactions.refId, `${prefix}%`),
      ];
      const [rows, countRows] = await Promise.all([
        asDb(conn)
          .select({
            id: walletTransactions.id,
            kind: walletTransactions.kind,
            refType: walletTransactions.refType,
            refId: walletTransactions.refId,
            memo: walletTransactions.memo,
            createdAt: walletTransactions.createdAt,
          })
          .from(walletTransactions)
          .where(and(...conditions))
          .orderBy(desc(walletTransactions.id))
          .limit(input.limit)
          .offset(input.offset),
        asDb(conn)
          .select({ count: sql<number>`count(*)::int` })
          .from(walletTransactions)
          .where(and(...conditions)),
      ]);
      return {
        rows: rows as ReferralPayoutRow[],
        total: countRows[0]?.count ?? 0,
      };
    },

    isUniqueViolation: (error) => isUniqueViolation(error),

    async verifyInvariants(limit) {
      const result = await db.execute<{
        kind: 'transaction_balance' | 'account_balance' | 'in_flight';
        key: string;
        detail: string;
      }>(sql`
        select * from (
          select 'transaction_balance'::text as kind,
                 t.id::text as key,
                 'legs sum ' || coalesce(sum(l.amount), 0) || ' kind ' || t.kind as detail
          from wallet_transactions t
          left join wallet_legs l on l.transaction_id = t.id
          group by t.id, t.kind
          having sum(l.amount) <> 0
             or (t.kind in ('credit_line', 'freeze') and count(l.id) <> 1)
             or (t.kind not in ('credit_line', 'freeze') and count(l.id) < 2)
          union all
          select 'account_balance'::text as kind,
                 ac.id::text as key,
                 'balance ' || ac.balance || ' last leg ' || coalesce((
                   select l2.balance_after from wallet_legs l2
                   where l2.account_id = ac.id order by l2.id desc limit 1), 0) as detail
          from wallet_accounts ac
          where ac.balance <> coalesce((
            select l2.balance_after from wallet_legs l2
            where l2.account_id = ac.id order by l2.id desc limit 1), 0)
          union all
          select 'in_flight'::text as kind,
                 ac.id::text as key,
                 'in_flight ' || ac.in_flight || ' active sum ' || coalesce((
                   select sum(a.amount) from wallet_authorizations a
                   where a.account_id = ac.id and a.status = 'active'), 0) as detail
          from wallet_accounts ac
          where ac.in_flight <> coalesce((
            select sum(a.amount) from wallet_authorizations a
            where a.account_id = ac.id and a.status = 'active'), 0)
        ) drifts limit ${limit}`);
      return result.rows;
    },
  };
}
