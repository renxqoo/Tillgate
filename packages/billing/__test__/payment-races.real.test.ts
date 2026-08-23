/**
 * 支付回调真实 PG 竞态套件（U5 遗留补齐——MIGRATION-U5 §5「payment_orders 唯一约束
 * 竞态随收口真 PG 套件验证」兑现）：并发用例打真实 PostgreSQL 的订单状态机 CAS
 * （markPaid 0→1 / markCredited 1→2 / closeOrder 0→4 / revive 4→1 单语句条件 UPDATE）
 * 与入账幂等锚（wallet_transactions (ref_type,ref_id,kind) 唯一）。装置复用
 * real-pg.ts setupRealFullSchema（隔离 schema + 完整迁移链 + 42P01 容错）。
 *
 * 竞态矩阵（每例 Promise.allSettled 收两路）：
 *   1. 并发同 orderId 回调两次（同金额同签名面）→ 恰一入账：输家 markPaid 0 行后
 *      重读终态幂等返回；wallet 流水恰一笔；后续顺序重放仍幂等（不双记）。
 *   2. 并发回调 vs 手动 close（admin-api P4 closeOrder 原语直接复用）→
 *      状态机 CAS 单赢家：关单赢则已付款单经复活（4→1）收尾入账（关单不吞款）；
 *      回调赢则 close 0 行（order_state_conflict 语义面）。终态资金事实唯一。
 *
 * 断言口径：金额 Decimal 精确比较；账本不变量复用 real-pg.assertLedgerCoherent。
 * 默认门禁排除（铁律 14），经 test:real（DB_TEST_URL / DATABASE_URL）显式运行。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { type Db } from '@tokenlens/db';
import { Decimal } from '../src/domain/money.js';
import { createPostgresWalletStore } from '../src/adapters/postgres/wallet-store.js';
import { createPostgresBillingStore } from '../src/adapters/postgres/billing-store.js';
import { createPostgresPaymentOrderStore } from '../src/adapters/postgres/payment-stores.js';
import { createWalletApi } from '../src/application/wallet/wallet.js';
import type { WalletApi } from '../src/application/wallet/wallet.js';
import { createPaymentsApi } from '../src/application/payments/payments.js';
import type { PaymentsApi } from '../src/application/payments/payments.js';
import type { PaymentOrderStore } from '../src/ports/payment-ports.js';
import type { PaymentProviderPort } from '../src/ports/payment-ports.js';
import {
  REAL_URL,
  V1_RETRY,
  assertLedgerCoherent,
  setupRealFullSchema,
  type RealFullSchemaHarness,
} from './real-pg.js';

/** 受控假渠道：单号映射确定（cs_{orderId}），回调载荷按订单面额构造（同签名面） */
const stubProvider: PaymentProviderPort = {
  name: 'stripe',
  async createOrder(input) {
    const providerOrderId = `cs_${input.orderId}`;
    return { providerOrderId, payUrl: `https://pay/${providerOrderId}` };
  },
  parseNotify(raw) {
    const providerOrderId = raw.providerOrderId ?? '';
    const paidAmount = raw.paidAmount ?? '';
    if (!providerOrderId || !paidAmount) return null;
    return { providerOrderId, paidAmount };
  },
};

(REAL_URL ? describe : describe.skip)('支付回调真实 PG 竞态', () => {
  let db: Db;
  let wallet: WalletApi;
  let payments: PaymentsApi;
  let orders: PaymentOrderStore;
  /** closeOrder 走 billingStore 事务壳（与生产 admin-api P4 同一原语） */
  let withBillingTx: <T>(fn: (tx: Parameters<PaymentOrderStore['closeOrder']>[0]) => Promise<T>) => Promise<T>;
  let userSeq = 0;
  /** 回调失败留痕（handleNotify 吞错返回 fail——留痕面必须可观察） */
  const errorLogs: Array<{ message: string }> = [];

  const seedUser = async (): Promise<number> => {
    userSeq += 1;
    const row = await db.execute<{ id: number }>(sql`
      insert into users (issuer, subject, identity_provider, email)
      values ('local', ${`payrace-${Date.now()}-${userSeq}@test`}, 'local', ${`payrace-${Date.now()}-${userSeq}@test`})
      returning id`);
    return Number(row.rows[0]!.id);
  };

  const balanceOf = async (userId: number): Promise<string> =>
    (await wallet.accounts(userId))[0]?.balance ?? '0';

  const countInt = async (query: SQL): Promise<number> => {
    const row = await db.execute<{ n: number }>(query);
    return row.rows[0]?.n ?? -1;
  };

  /** 下单 + 构造同签名面回调载荷 */
  async function placedOrder(userId: number, amount: string) {
    const order = await payments.createTopupOrder(userId, { amount });
    return {
      orderId: order.orderId,
      raw: { providerOrderId: `cs_${order.orderId}`, paidAmount: amount },
    };
  }

  let harness: RealFullSchemaHarness | undefined;

  beforeAll(async () => {
    harness = await setupRealFullSchema('payrace');
    db = harness.db;
    const walletStore = createPostgresWalletStore(db, { retry: V1_RETRY });
    const billingStore = createPostgresBillingStore(db, { retry: V1_RETRY });
    wallet = createWalletApi({
      store: walletStore,
      guards: {
        refTypes: ['billing', 'topup', 'admin', 'subscription', 'pack'],
        currencies: ['CNY'],
        internalAccounts: ['outside', 'platform_revenue'],
      },
      currency: 'CNY',
    });
    orders = createPostgresPaymentOrderStore(db);
    withBillingTx = (fn) => billingStore.transaction(fn);
    payments = createPaymentsApi({
      store: billingStore,
      orders,
      wallet,
      providers: [stubProvider],
      currency: 'CNY',
      exchangeRate: '1',
      topupMin: '1',
      topupMax: '1000',
      perMinuteOrderLimit: 6,
      orderTtlMs: 600_000,
      clock: () => new Date(),
      logError: (message) => {
        errorLogs.push({ message });
      },
    });
  });

  afterAll(async () => {
    await harness?.teardown();
  });

  it('并发同单回调两次：恰一入账；重放幂等返回原结果（无双入账、流水恰一笔）', async () => {
    const userId = await seedUser();
    const { orderId, raw } = await placedOrder(userId, '10');

    const results = await Promise.allSettled([
      payments.handleNotify('stripe', raw),
      payments.handleNotify('stripe', raw),
    ]);
    // 两路都应成功应答（输家 markPaid 0 行 → 重读 credited 幂等返回；渠道停止重发）
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : `rejected:${String(r.reason)}`)))
      .toEqual(['success', 'success']);

    // 入账幂等锚（topup + orderId）：wallet 流水恰一笔
    expect(
      await countInt(
        sql`select count(*)::int as n from wallet_transactions
            where ref_type = 'topup' and ref_id = ${orderId}`,
      ),
    ).toBe(1);
    // 余额恰入账一次（Decimal 精确比较）
    expect(new Decimal(await balanceOf(userId)).eq(10)).toBe(true);
    // 订单终态 credited
    const row = await db.execute<{ status: number }>(sql`
      select status from payment_orders where id = ${orderId}::uuid`);
    expect(row.rows[0]!.status).toBe(2);

    // 顺序重放（竞态尘埃落定后）：幂等返回 success，不二次入账
    expect(await payments.handleNotify('stripe', raw)).toBe('success');
    expect(
      await countInt(
        sql`select count(*)::int as n from wallet_transactions
            where ref_type = 'topup' and ref_id = ${orderId}`,
      ),
    ).toBe(1);
    expect(new Decimal(await balanceOf(userId)).eq(10)).toBe(true);
    // 全程零入账失败留痕（静默吞错不可见 = 缺陷）
    expect(errorLogs).toEqual([]);
    await assertLedgerCoherent(db);
  });

  it('并发回调 vs 手动 close：状态机 CAS 单赢家；已付款单不因关单搁浅', async () => {
    const userId = await seedUser();
    const { orderId, raw } = await placedOrder(userId, '10');

    const results = await Promise.allSettled([
      payments.handleNotify('stripe', raw),
      withBillingTx((tx) => orders.closeOrder(tx, { orderId, reason: 'payrace-admin-close' })),
    ]);
    // 回调两分支都收尾入账：close 赢（先置 4）→ 复活 4→1 收尾；回调赢 → close 0 行
    const notify = results[0]!;
    expect(notify.status).toBe('fulfilled');
    expect((notify as PromiseFulfilledResult<'success' | 'fail'>).value).toBe('success');
    const close = results[1]!;
    expect(close.status).toBe('fulfilled');
    const closeWon = (close as PromiseFulfilledResult<boolean>).value;

    // CAS 单赢家的终态资金事实（与交错无关）：
    // 恰一笔入账、订单 credited、余额 10——关单不吞款、回调不双记
    expect(
      await countInt(
        sql`select count(*)::int as n from wallet_transactions
            where ref_type = 'topup' and ref_id = ${orderId}`,
      ),
    ).toBe(1);
    expect(new Decimal(await balanceOf(userId)).eq(10)).toBe(true);
    const row = await db.execute<{ status: number; failure_reason: string | null }>(sql`
      select status, failure_reason from payment_orders where id = ${orderId}::uuid`);
    expect(row.rows[0]!.status).toBe(2);
    // close 的 CAS 赢家留痕（复活收尾不清 failure_reason——关单动作可审计）
    expect(row.rows[0]!.failure_reason).toBe(closeWon ? 'payrace-admin-close' : null);
    expect(errorLogs).toEqual([]);
    await assertLedgerCoherent(db);
  });
});
