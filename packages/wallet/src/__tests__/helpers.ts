/** 测试共享基建：db/wallet 单例、唯一用户与幂等键、账户读取、全账本对账器。
 *  表由 global-setup 统一 provision/deprovision（多文件并行共享一套表），
 *  因此：用户 ID 随机生成防跨文件碰撞；对账器用 REPEATABLE READ 快照防读到并行文件的中间态。 */
import { randomInt } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { createWallet } from '../wallet';
import { createWalletMaintenance } from '../maintenance';
import { walletAccounts, walletLegs } from '../schema';
import { Decimal } from '../money';

export const testPoolOptions = process.env.WALLET_TEST_SCHEMA
  ? `-c search_path=${process.env.WALLET_TEST_SCHEMA}`
  : undefined;

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  options: testPoolOptions,
  max: 3, // 并行测试文件各持一池：16 文件 × 3 连接 < PG max_connections
});
export const db = drizzle(pool);
// 测试宽白名单：覆盖全部测试文件用到的科目/业务域/币种（含各文件专属隔离币种 ZB*）
export const wallet = createWallet(db, {
  accounts: [
    'marketing_expense',
    'marketing_budget',
    'merchant_income',
    'channel_cost',
    'any_new_account',
    'platform_treasury',
  ],
  refTypes: [
    'topup',
    'order',
    'gift',
    'payout',
    'p2p',
    'credit_line',
    'risk_control',
    'topup_refund',
    'gift_refund',
    'exchange',
    'whatever_domain',
    'inference',
  ],
  currencies: [
    'CNY',
    'USD',
    'XAU',
    'XDG',
    'DIX',
    'TSF',
    'CUX',
    'ZBA',
    'ZBB',
    'ZBC',
    'ZBD',
    'ZBE',
    'ZBF',
  ],
});
export const walletMaintenance = createWalletMaintenance(db);

/** 跨文件并行的随机用户 ID（1e11 空间，碰撞概率可忽略） */
export const nextUser = (): number => 900_000_000_000 + randomInt(0, 99_999_999_999);

/** 该用户的唯一幂等键（跨测试/跨文件唯一） */
export const ref = (user: number, key: string): string => `${key}-${user}`;

export const d = (v: string): Decimal => new Decimal(v);
export const sameAmount = (a: string, b: string): boolean => d(a).eq(d(b));

export async function accountOf(userId: number, currency = 'CNY') {
  const [row] = await db
    .select()
    .from(walletAccounts)
    .where(
      and(
        eq(walletAccounts.kind, 'user'),
        eq(walletAccounts.userId, userId),
        eq(walletAccounts.currency, currency),
      ),
    );
  if (!row) throw new Error(`account ${userId}/${currency} missing`);
  return row;
}

export async function internalAccount(code: string, currency = 'CNY') {
  const rows = await db
    .select()
    .from(walletAccounts)
    .where(
      and(
        eq(walletAccounts.kind, 'internal'),
        eq(walletAccounts.code, code),
        eq(walletAccounts.currency, currency),
      ),
    );
  if (rows.length === 0) throw new Error(`internal account ${code}/${currency} missing`);
  return {
    ...rows[0]!,
    balance: rows.reduce((total, row) => total.plus(row.balance), new Decimal(0)).toString(),
  };
}

/** 用户账户的腿（按序） */
export async function legsOfAccount(accountId: string) {
  return db
    .select()
    .from(walletLegs)
    .where(eq(walletLegs.accountId, accountId))
    .orderBy(asc(walletLegs.id));
}

/**
 * 全账本对账：Σ 每笔交易腿 = 0 / 每账户链恒等且连续 / 账户余额 = 腿的代数和。
 * REPEATABLE READ：多文件并行下取一致快照，不读到他文件事务的中间态。
 */
export async function assertLedgerCoherent(): Promise<void> {
  await db.transaction(
    async (tx) => {
      const legs = await tx.select().from(walletLegs).orderBy(asc(walletLegs.id));
      const byTx = new Map<number, Decimal>();
      for (const leg of legs) {
        byTx.set(
          leg.transactionId,
          (byTx.get(leg.transactionId) ?? new Decimal(0)).plus(d(leg.amount)),
        );
      }
      for (const [txId, total] of byTx) {
        if (!total.isZero()) throw new Error(`transaction ${txId} legs must sum to zero`);
      }
      const accounts = await tx.select().from(walletAccounts);
      for (const account of accounts) {
        const own = legs.filter((leg) => leg.accountId === account.id);
        let expected = new Decimal(0);
        for (const leg of own) {
          if (!d(leg.balanceAfter).eq(d(leg.balanceBefore).plus(d(leg.amount)))) {
            throw new Error(`leg ${leg.id} chain broken`);
          }
          if (!d(leg.balanceBefore).eq(expected)) {
            throw new Error(`account ${account.id} leg ${leg.id} not continuous`);
          }
          expected = d(leg.balanceAfter);
        }
        if (!d(account.balance).eq(expected)) {
          throw new Error(`account ${account.id} balance != legs sum`);
        }
      }
    },
    { isolationLevel: 'repeatable read' },
  );
}
