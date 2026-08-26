/**
 * 订阅真实 PG 竞态套件（U4 遗留补齐——MIGRATION-U4 §5「真实 PG 竞态随收口真 PG 套件」
 * 兑现）：并发用例打真实 PostgreSQL 的并发原语——「单有效订阅」部分唯一索引
 * （user_subscriptions_one_active_uq）、订阅行 FOR UPDATE 行锁、CAS 状态迁移、
 * 凭证改绑 UPDATE——不是内存 stand-in 的顺序重放。装置复用 real-pg.ts
 * setupRealFullSchema（隔离 schema + 完整迁移链 + 42P01 容错，settlement 同款）。
 *
 * 竞态矩阵（每例 Promise.allSettled 收两路，断言恰一成恰一败）：
 *   1. 并发 purchase 同用户 → 预检无可锁行，唯一索引是唯一裁决者：单赢家；
 *      败者事务整体回滚（订阅行/钱包流水/操作档案零残留——无半订阅半扣款）。
 *   2. 并发 renew + change 同一订阅 → 行锁串行化，后到者重读到终态（status 已翻）
 *      判定 no_subscription；恰一笔收款、余额守恒（充值 − Σ实扣）。
 *   3. 凭证（API key）改绑并发 → 同一订阅两路并发续费恰一成功，key 恰落在
 *      赢家新订阅上（行锁先行裁决；唯一索引兜底语义同 1——见模块头注释）。
 *
 * 断言口径：金额 Decimal 精确比较；账本不变量复用 real-pg.assertLedgerCoherent
 * （Σ腿=0 / 腿链连续 / 余额=末腿 / in_flight 投影——settlement 套件同款守卫）。
 * 默认门禁排除（铁律 14），经 test:real（DB_TEST_URL / DATABASE_URL）显式运行。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { isBusinessError } from '@tillgate/errors';
import { type Db } from '@tillgate/db';
import { Decimal } from '../src/domain/money.js';
import { createPostgresWalletStore } from '../src/adapters/postgres/wallet-store.js';
import { createPostgresBillingStore } from '../src/adapters/postgres/billing-store.js';
import { createWalletApi } from '../src/application/wallet/wallet.js';
import type { WalletApi } from '../src/application/wallet/wallet.js';
import { createSubscriptionsApi } from '../src/application/subscriptions/subscriptions.js';
import {
  REAL_URL,
  V1_RETRY,
  assertLedgerCoherent,
  setupRealFullSchema,
  type RealFullSchemaHarness,
} from './real-pg.js';
import { defined } from './defined.js';

/** 业务拒绝信息（非业务错误原样抛出——测试不得吞缺陷） */
function businessOf(error: unknown): { code: string; reason: unknown } {
  if (!isBusinessError(error)) {
    const chain: string[] = [];
    let cur: unknown = error;
    for (let i = 0; cur != null && i < 5; i += 1) {
      const e = cur as Record<string, unknown>;
      chain.push(`${String(e.name)}: code=${String(e.code)} errno=${String(e.errno)} msg=${String(e.message).slice(0, 60)}`);
      cur = e.cause;
    }
    throw new Error(`expected business rejection, got:\n${chain.join('\n')}`);
  }
  return {
    code: error.code,
    reason: (error.context as Record<string, unknown> | undefined)?.reason,
  };
}

/** allSettled 结果二分：恰一成恰一败的公共断言材料 */
function partition<T>(results: PromiseSettledResult<T>[]): {
  winner: T;
  loserReason: unknown;
} {
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  return {
    winner: (fulfilled[0] as PromiseFulfilledResult<T>).value,
    loserReason: (rejected[0] as PromiseRejectedResult).reason,
  };
}

(REAL_URL ? describe : describe.skip)('订阅真实 PG 竞态', () => {
  let db: Db;
  let wallet: WalletApi;
  let subscriptions: ReturnType<typeof createSubscriptionsApi>;
  let userSeq = 0;

  const seedUser = async (): Promise<number> => {
    userSeq += 1;
    const row = await db.execute<{ id: number }>(sql`
      insert into users (issuer, subject, identity_provider, email)
      values ('local', ${`subrace-${Date.now()}-${userSeq}@test`}, 'local', ${`subrace-${Date.now()}-${userSeq}@test`})
      returning id`);
    return Number(defined(row[0]).id);
  };

  const seedPlan = async (input: {
    name: string;
    price: string;
    quota: string;
    sortOrder: number;
  }): Promise<number> => {
    const row = await db.execute<{ id: number }>(sql`
      insert into plans (name, kind, sort_order, price, period_days, quota_amount, allow_seats, status)
      values (${input.name}, 'subscription', ${input.sortOrder}, ${input.price}, 30, ${input.quota}, false, 0)
      returning id`);
    return Number(defined(row[0]).id);
  };

  const balanceOf = async (userId: number): Promise<string> =>
    (await wallet.accounts(userId))[0]?.balance ?? '0';

  const countInt = async (query: SQL): Promise<number> => {
    const row = await db.execute<{ n: number }>(query);
    return row[0]?.n ?? -1;
  };

  let harness: RealFullSchemaHarness | undefined;

  beforeAll(async () => {
    harness = await setupRealFullSchema('subrace');
    ({ db } = harness);
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
    subscriptions = createSubscriptionsApi({
      store: billingStore,
      accounts: billingStore.accountContext,
      wallet,
      clock: () => new Date(),
    });
  });

  afterAll(async () => {
    await harness?.teardown();
  });

  it('并发 purchase 同用户：部分唯一索引单赢家；败者事务整体回滚（无半订阅/半扣款）', async () => {
    const userId = await seedUser();
    await wallet.credit({ userId, amount: '100', refType: 'topup', refId: 'subrace1-topup' });
    const planId = await seedPlan({ name: 'race1档', price: '30', quota: '100', sortOrder: 1 });

    // 新用户无有效订阅——预检 lockActiveSubscriptionForUser 无行可锁，
    // 两路同时过检；user_subscriptions_one_active_uq 是唯一裁决者
    const { winner, loserReason } = await partition(
      await Promise.allSettled([
        subscriptions.purchase({ operationId: 'subrace1-a', userId, planId, quantity: 1 }),
        subscriptions.purchase({ operationId: 'subrace1-b', userId, planId, quantity: 1 }),
      ]),
    );
    expect(winner).toMatchObject({ userId, planId, replayed: false, price: '30' });
    expect(businessOf(loserReason)).toEqual({
      code: 'billing.subscription_state',
      reason: 'already_subscribed',
    });

    // 恰一行订阅（status=0）；败者插入随事务回滚
    expect(
      await countInt(
        sql`select count(*)::int as n from user_subscriptions where user_id = ${userId}`,
      ),
    ).toBe(1);
    expect(
      await countInt(
        sql`select count(*)::int as n from user_subscriptions where user_id = ${userId} and status = 0`,
      ),
    ).toBe(1);
    // 钱包恰一笔 subscription 收款（两 operationId 面上）——败者的扣款腿已回滚
    expect(
      await countInt(
        sql`select count(*)::int as n from wallet_transactions
            where ref_type = 'subscription' and ref_id in ('subrace1-a', 'subrace1-b')`,
      ),
    ).toBe(1);
    // 败者幂等占位同样回滚（operations 占位与业务写同事务）
    expect(
      await countInt(
        sql`select count(*)::int as n from ledger_operations
            where operation_id in ('subrace1-a', 'subrace1-b')`,
      ),
    ).toBe(1);
    // 余额守恒：充值 100 − 恰一次扣款 30（Decimal 精确比较）
    expect(new Decimal(await balanceOf(userId)).eq(70)).toBe(true);
    await assertLedgerCoherent(db);
  });

  it('并发 renew + change 同一订阅：行锁串行化，后到者基于终态拒绝；无重复扣款、余额守恒', async () => {
    const userId = await seedUser();
    await wallet.credit({ userId, amount: '100', refType: 'topup', refId: 'subrace2-topup' });
    const liteId = await seedPlan({ name: 'race2轻', price: '30', quota: '100', sortOrder: 1 });
    const proId = await seedPlan({ name: 'race2专业', price: '90', quota: '300', sortOrder: 2 });
    const purchased = await subscriptions.purchase({
      operationId: 'subrace2-buy',
      userId,
      planId: liteId,
      quantity: 1,
    });
    // 购买后余额 70；renew 收 30；change 补差 = 90 − 剩余价值 30 = 60
    const { winner, loserReason } = await partition(
      await Promise.allSettled([
        subscriptions.renew({
          operationId: 'subrace2-renew',
          userId,
          subscriptionId: purchased.subscriptionId,
        }),
        subscriptions.change({
          operationId: 'subrace2-change',
          userId,
          subscriptionId: purchased.subscriptionId,
          targetPlanId: proId,
          quantity: 1,
        }),
      ]),
    );
    // 后到者在行锁上等待，赢家提交后重读：status 已 0→1，谓词失配 → no_subscription
    expect(businessOf(loserReason)).toEqual({
      code: 'billing.subscription_state',
      reason: 'no_subscription',
    });

    // 恰两行订阅：旧单到期（1）+ 赢家新单（0）；败者新单不存在
    expect(
      await countInt(
        sql`select count(*)::int as n from user_subscriptions where user_id = ${userId}`,
      ),
    ).toBe(2);
    expect(
      await countInt(
        sql`select count(*)::int as n from user_subscriptions
            where user_id = ${userId} and status = 0`,
      ),
    ).toBe(1);
    // 恰一笔续费/变更收款（购买笔不在面上）
    expect(
      await countInt(
        sql`select count(*)::int as n from wallet_transactions
            where ref_type = 'subscription' and ref_id in ('subrace2-renew', 'subrace2-change')`,
      ),
    ).toBe(1);
    // 余额守恒：100 − 30（购买） − 恰一次（renew 30 / change 60），
    // 与赢家回执余额精确一致（两种合法交错 40 / 10）
    const balance = await balanceOf(userId);
    expect(winner.balanceAfter).not.toBeNull();
    expect(new Decimal(balance).eq(new Decimal(defined(winner.balanceAfter)))).toBe(true);
    expect(new Decimal(balance).eq(40) || new Decimal(balance).eq(10)).toBe(true);
    expect(
      await countInt(
        sql`select count(*)::int as n from ledger_operations
            where operation_id in ('subrace2-renew', 'subrace2-change')`,
      ),
    ).toBe(1);
    await assertLedgerCoherent(db);
  });

  it('凭证改绑并发：同一订阅两路并发续费恰一成功，API key 恰落在赢家新订阅', async () => {
    const userId = await seedUser();
    await wallet.credit({ userId, amount: '100', refType: 'topup', refId: 'subrace3-topup' });
    const planId = await seedPlan({ name: 'race3档', price: '30', quota: '100', sortOrder: 1 });
    const purchased = await subscriptions.purchase({
      operationId: 'subrace3-buy',
      userId,
      planId,
      quantity: 1,
    });
    // key 绑定旧订阅（续费语义：不打断现有 key，改绑到新单）
    const keyHash = 'ab'.repeat(32);
    await db.execute(sql`
      insert into api_keys (key_hash, key_preview, user_id, name, subscription_id)
      values (${keyHash}, 'sk_****race3', ${userId}, 'race3-key', ${purchased.subscriptionId})`);

    const { winner, loserReason } = await partition(
      await Promise.allSettled([
        subscriptions.renew({
          operationId: 'subrace3-a',
          userId,
          subscriptionId: purchased.subscriptionId,
        }),
        subscriptions.renew({
          operationId: 'subrace3-b',
          userId,
          subscriptionId: purchased.subscriptionId,
        }),
      ]),
    );
    expect(businessOf(loserReason)).toEqual({
      code: 'billing.subscription_state',
      reason: 'no_subscription',
    });

    // key 恰落在赢家新订阅；旧订阅零残留绑定（改绑 UPDATE 恰生效一次）
    // （bigint 经 pg 驱动返回字符串——Number 收敛）
    const key = await db.execute<{ subscription_id: string | number | null }>(sql`
      select subscription_id from api_keys where key_hash = ${keyHash}`);
    expect(defined(key[0]).subscription_id).not.toBeNull();
    expect(Number(defined(key[0]).subscription_id)).toBe(winner.subscriptionId);
    expect(
      await countInt(
        sql`select count(*)::int as n from api_keys where subscription_id = ${purchased.subscriptionId}`,
      ),
    ).toBe(0);
    // 恰两行订阅（旧 1 + 新 0）；恰一笔续费收款；余额守恒 100 − 30 − 30
    expect(
      await countInt(
        sql`select count(*)::int as n from user_subscriptions where user_id = ${userId}`,
      ),
    ).toBe(2);
    expect(
      await countInt(
        sql`select count(*)::int as n from wallet_transactions
            where ref_type = 'subscription' and ref_id in ('subrace3-a', 'subrace3-b')`,
      ),
    ).toBe(1);
    expect(new Decimal(await balanceOf(userId)).eq(40)).toBe(true);
    await assertLedgerCoherent(db);
  });
});
