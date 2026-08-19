/**
 * wallet 仓储：复式账本的全部 SQL（意图化原子操作）。
 * 表族 = 聚合：accounts/transactions/legs/authorizations 四表是复式记账的不可分单元
 * （腿链跨表恒等 + Σ=0 由提交期触发器在四表间联查），拆开即破坏聚合边界。
 *
 * 写路径约定：RepoContext.db 必须是事务句柄（用例层持有）；账户行锁（FOR UPDATE，
 * id 定序）是复式账本的串行化点——锁外读到的余额不可用于过账。
 * 返回行形状（string 金额）；语义判定与错误翻译在 app 的 domain/services。
 */
import { and, desc, eq, gt, inArray, like, lt, sql } from 'drizzle-orm';
import type { DbTx } from '@ai-gateway/db';
import {
  walletAccounts,
  walletAuthorizations,
  walletLegs,
  walletTransactions,
} from '@ai-gateway/db';
import type { RepoContext } from './context.js';

function tx(c: RepoContext): DbTx {
  return c.db as DbTx; // 写方法契约：调用方（用例层）保证传入事务句柄
}

export interface AccountRow {
  id: string;
  kind: string;
  code: string | null;
  currency: string;
  balance: string;
  inFlight: string;
  creditLimit: string;
  status: string;
}

export interface AuthorizationRow {
  id: string;
  accountId: string;
  refType: string;
  refId: string;
  amount: string;
  status: string;
  settledAmount: string | null;
  authorizeFingerprint: string | null;
  expiresAt: Date | null;
}

export interface TransactionHeader {
  id: number;
  kind: string;
  commandFingerprint: string | null;
}

export interface StatementItem {
  legId: number;
  transactionKind: string;
  refType: string;
  refId: string;
  amount: string;
  balanceAfter: string;
  memo: string | null;
  createdAt: Date;
}

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

/** wallet 复式账本聚合仓储（无状态；方法统一接收 RepoContext——事务由用例层注入） */
export class WalletRepository {
  // ---------- 账户 ----------

  /** 解析用户账户（无则建）；返回账户 id */
  async ensureUserAccount(c: RepoContext, userId: number, currency: string): Promise<string> {
    await tx(c).insert(walletAccounts).values({ kind: 'user', userId, currency }).onConflictDoNothing();
    const [row] = await tx(c)
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
  }

  /** 解析内部科目账户（无则建；v2 固定 shard 0） */
  async ensureInternalAccount(c: RepoContext, code: string, currency: string): Promise<string> {
    await tx(c)
      .insert(walletAccounts)
      .values({ kind: 'internal', code, currency, shard: 0 })
      .onConflictDoNothing();
    const [row] = await tx(c)
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
  }

  /** 只读定位用户账户（幂等重放路径禁止建空账户） */
  async findUserAccountId(c: RepoContext, userId: number, currency: string): Promise<string | null> {
    const [row] = await c.db
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
  }

  /** 只读定位内部科目账户（幂等重放路径；shard 0） */
  async findInternalAccountId(c: RepoContext, code: string, currency: string): Promise<string | null> {
    const [row] = await c.db
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
  }

  /**
   * 按 id 定序锁定多账户（死锁安全：全局一致的加锁顺序）。
   * 冻结账户原样返回——「拒绝冻结账户的一切资金变动」是领域判定，不在此抛错。
   */
  async lockAccounts(c: RepoContext, accountIds: readonly string[]): Promise<AccountRow[]> {
    const ordered = [...new Set(accountIds)].toSorted();
    if (ordered.length === 0) return [];
    const rows = await tx(c)
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
      .for('update');
    if (rows.length !== ordered.length) throw new Error('wallet.lock_accounts_missing');
    return rows as AccountRow[];
  }

  /** 用户全部币种账户摘要（读侧，可用池会话） */
  async userAccountSummaries(c: RepoContext, userId: number): Promise<AccountRow[]> {
    const rows = await c.db
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
    return rows as AccountRow[];
  }

  // ---------- 冻结单 ----------

  async findAuthorization(c: RepoContext, refType: string, refId: string): Promise<AuthorizationRow | null> {
    const [row] = await c.db
      .select(AUTH_COLUMNS)
      .from(walletAuthorizations)
      .where(and(eq(walletAuthorizations.refType, refType), eq(walletAuthorizations.refId, refId)));
    return (row as AuthorizationRow) ?? null;
  }

  /** 行级锁（结算/释放前先锁再做领域校验） */
  async lockAuthorization(c: RepoContext, refType: string, refId: string): Promise<AuthorizationRow | null> {
    const [row] = await tx(c)
      .select(AUTH_COLUMNS)
      .from(walletAuthorizations)
      .where(and(eq(walletAuthorizations.refType, refType), eq(walletAuthorizations.refId, refId)))
      .for('update');
    return (row as AuthorizationRow) ?? null;
  }

  async insertAuthorization(
    c: RepoContext,
    input: {
      accountId: string;
      refType: string;
      refId: string;
      amount: string;
      expiresAt: Date | null;
      memo: string | null;
      authorizeFingerprint: string;
    },
  ): Promise<string> {
    const [row] = await tx(c)
      .insert(walletAuthorizations)
      .values({ ...input, status: 'active' })
      .returning({ id: walletAuthorizations.id });
    if (!row) throw new Error('wallet.insert_authorization');
    return row.id;
  }

  /** CAS active→settled；0 行命中 = 并发对手已了结（调用方走重放/拒绝分岔） */
  async casSettleAuthorization(
    c: RepoContext,
    id: string,
    settledAmount: string,
  ): Promise<{ accountId: string; heldAmount: string } | null> {
    const rows = await tx(c)
      .update(walletAuthorizations)
      .set({ status: 'settled', settledAmount, updatedAt: new Date() })
      .where(and(eq(walletAuthorizations.id, id), eq(walletAuthorizations.status, 'active')))
      .returning({ accountId: walletAuthorizations.accountId, amount: walletAuthorizations.amount });
    const row = rows[0];
    return row ? { accountId: row.accountId, heldAmount: row.amount } : null;
  }

  /** CAS active→released（审计在单据本身：reason + 释放指纹；不落交易，零额噪声行取消） */
  async casReleaseAuthorization(
    c: RepoContext,
    id: string,
    releaseReason: string,
    releaseFingerprint: string | null,
  ): Promise<{ accountId: string; amount: string } | null> {
    const rows = await tx(c)
      .update(walletAuthorizations)
      .set({ status: 'released', releaseReason, releaseFingerprint, updatedAt: new Date() })
      .where(and(eq(walletAuthorizations.id, id), eq(walletAuthorizations.status, 'active')))
      .returning({ accountId: walletAuthorizations.accountId, amount: walletAuthorizations.amount });
    const row = rows[0];
    return row ? { accountId: row.accountId, amount: row.amount } : null;
  }

  // ---------- 过账 ----------

  /** 幂等重放定位（refType, refId, kind 唯一） */
  async findTransaction(
    c: RepoContext,
    refType: string,
    refId: string,
    kind: string,
  ): Promise<TransactionHeader | null> {
    const [row] = await c.db
      .select({
        id: walletTransactions.id,
        kind: walletTransactions.kind,
        commandFingerprint: walletTransactions.commandFingerprint,
      })
      .from(walletTransactions)
      .where(
        and(
          eq(walletTransactions.refType, refType),
          eq(walletTransactions.refId, refId),
          eq(walletTransactions.kind, kind),
        ),
      );
    return (row as TransactionHeader) ?? null;
  }

  /** 重放回执：某交易在某账户上的腿（金额 + 余额快照） */
  async findLeg(
    c: RepoContext,
    transactionId: number,
    accountId: string,
  ): Promise<{ amount: string; balanceAfter: string } | null> {
    const [row] = await c.db
      .select({ amount: walletLegs.amount, balanceAfter: walletLegs.balanceAfter })
      .from(walletLegs)
      .where(and(eq(walletLegs.transactionId, transactionId), eq(walletLegs.accountId, accountId)));
    return row ?? null;
  }

  /** 冻结单归属者（幂等键跨主体顶撞判定） */
  async accountOwner(
    c: RepoContext,
    accountId: string,
  ): Promise<{ userId: number | null; currency: string } | null> {
    const [row] = await c.db
      .select({ userId: walletAccounts.userId, currency: walletAccounts.currency })
      .from(walletAccounts)
      .where(eq(walletAccounts.id, accountId));
    return row ?? null;
  }

  async insertTransaction(
    c: RepoContext,
    input: {
      kind: string;
      refType: string;
      refId: string;
      memo: string | null;
      creditLimitAfter: string | null;
      frozenAfter: boolean | null;
      commandFingerprint: string;
    },
  ): Promise<number> {
    const [row] = await tx(c)
      .insert(walletTransactions)
      .values(input)
      .returning({ id: walletTransactions.id });
    if (!row) throw new Error('wallet.insert_transaction');
    return row.id;
  }

  /** 落一条腿并推进账户余额（腿链恒等由领域算 before/after，DB check 同律兜底） */
  async applyLeg(
    c: RepoContext,
    input: {
      transactionId: number;
      accountId: string;
      currency: string;
      amount: string;
      balanceBefore: string;
      balanceAfter: string;
    },
  ): Promise<void> {
    await tx(c).insert(walletLegs).values(input);
    await tx(c)
      .update(walletAccounts)
      .set({ balance: input.balanceAfter, updatedAt: new Date() })
      .where(eq(walletAccounts.id, input.accountId));
  }

  /** 账户在途敞口绝对值设置（authorize/settle/release 专用；账户行必须已锁） */
  async setInFlight(c: RepoContext, accountId: string, value: string): Promise<void> {
    await tx(c)
      .update(walletAccounts)
      .set({ inFlight: value, updatedAt: new Date() })
      .where(eq(walletAccounts.id, accountId));
  }

  /** 账户授信地板绝对值设置（credit_line 专用；账户行必须已锁） */
  async setCreditLimit(c: RepoContext, accountId: string, value: string): Promise<void> {
    await tx(c)
      .update(walletAccounts)
      .set({ creditLimit: value, updatedAt: new Date() })
      .where(eq(walletAccounts.id, accountId));
  }

  /** 数据库时钟（过期判定必须用 DB now，不得用应用钟——多副本时钟漂移防线） */
  async databaseNow(c: RepoContext): Promise<Date> {
    const result = await c.db.execute<{ now: string }>(sql`select now() as now`);
    return new Date(String(result.rows[0]?.now));
  }

  // ---------- 流水（读侧） ----------

  /** 用户资金流水页（腿级；id 倒序 + before 游标） */
  async statementPage(
    c: RepoContext,
    input: { userId: number; kinds?: readonly string[]; limit: number; beforeLegId?: number },
  ): Promise<StatementItem[]> {
    const conditions = [eq(walletAccounts.kind, 'user'), eq(walletAccounts.userId, input.userId)];
    if (input.kinds && input.kinds.length > 0) {
      conditions.push(inArray(walletTransactions.kind, [...input.kinds]));
    }
    if (input.beforeLegId !== undefined) {
      conditions.push(lt(walletLegs.id, input.beforeLegId));
    }
    const rows = await c.db
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
    return rows as StatementItem[];
  }

  /**
   * 按业务域+refId 前缀聚合入账额（读侧聚合：邀请佣金合计等）。
   * 只算正向腿（入账）；前缀字面匹配（不解释 %/_）。
   */
  async sumCreditedByRefPrefix(
    c: RepoContext,
    input: { userId: number; refType: string; refIdPrefix: string },
  ): Promise<string> {
    const [row] = await c.db
      .select({ total: sql<string>`coalesce(sum(${walletLegs.amount}), 0)::numeric` })
      .from(walletLegs)
      .innerJoin(walletAccounts, eq(walletLegs.accountId, walletAccounts.id))
      .innerJoin(walletTransactions, eq(walletLegs.transactionId, walletTransactions.id))
      .where(
        and(
          eq(walletAccounts.kind, 'user'),
          eq(walletAccounts.userId, input.userId),
          eq(walletTransactions.refType, input.refType),
          like(walletTransactions.refId, `${input.refIdPrefix.replaceAll(/[%_\\]/g, (ch) => `\\${ch}`)}%`),
          gt(walletLegs.amount, '0'),
        ),
      );
    return row?.total ?? '0';
  }

  // ---------- 错误分类辅助 ----------

  /** PG 唯一冲突（SQLSTATE 23505）：幂等竞态的兜底信号——并发同键第二个 INSERT 落此处 */
  isUniqueViolation(error: unknown): boolean {
    let current: unknown = error;
    for (let depth = 0; current != null && depth < 5; depth++) {
      if ((current as { code?: string }).code === '23505') return true;
      current = (current as { cause?: unknown }).cause;
    }
    return false;
  }
}
