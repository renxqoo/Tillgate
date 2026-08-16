import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import {
  billingRequests,
  channels,
  providers,
  transactions,
  usageLogs,
  users,
  userSubscriptions,
} from '@ai-gateway/db/schema';
import { Decimal } from '@ai-gateway/money';
import { createBilling } from '../billing/index.js';
import type { BillingQuote } from '../billing/types.js';
/**
 * 【红测 · R4】reserveChannel 渠道预算校验是 check-then-act，并发下可超扣进货预算
 *
 * 根因：packages/ledger/src/billing-flow.ts:695-734 —— 先 findFirst 读
 *   upstream_budget/upstream_reserved 算 remaining（无 FOR UPDATE），通过后
 *   UPDATE channels SET upstream_reserved = upstream_reserved + amount WHERE id=?
 *   的 WHERE 里【没有】`upstream_budget - upstream_reserved >= amount` 守卫。
 *   对比同文件的用户预占（:619-638）与套餐预占（:601-613）都是条件原子 CAS，
 *   渠道路径是唯一漏网。DB 也没有 upstream_reserved <= upstream_budget 的 CHECK。
 *
 * 后果：并发突发下渠道在途敞口可超过进货预算上限 → 平台对上游的真实采购
 *   敞口超出配置值（进货额度硬闸失守）。
 *
 * 复现方式（确定性交错）：外部事务先锁住渠道行 → 两笔 reserveChannel 并行，
 *   它们的读检查都完成后阻塞在 UPDATE 上 → 释放锁 → 两笔先后写入。
 *
 * 预期（正确行为）：第二笔应被拒（allowed:false），upstream_reserved <= budget。
 */
const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
let connected = false;

beforeAll(async () => {
  try {
    await db.query.users.findFirst({ columns: { id: true } });
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => db.$client.end().catch(() => {}));

function quote(): BillingQuote {
  return {
    maxOutputTokens: 500,
    candidates: [
      {
        mappingId: 1,
        externalModel: 'test-model',
        realModel: 'test-real',
        inputPrice: '1000',
        outputPrice: '2000',
        cacheInputPrice: '100',
        coefficient: '1',
        inputTokenUpperBound: 1_000,
        billingPolicyFingerprint: null,
      },
    ],
  };
}

describe('RED R4: 渠道进货预算必须在并发下不可超扣（DB 层守卫）', () => {
  it('两笔并发 reserve 各等于全部预算：合计不得超过预算', async (context) => {
    if (!connected) return context.skip();
    const suffix = randomUUID().slice(0, 8);
    const [user] = await db
      .insert(users)
      .values({
        issuer: 'test',
        subject: `redch-${suffix}`,
        identityProvider: 'local',
        balance: '100',
      })
      .returning({ id: users.id });
    const userId = user!.id;
    const [provider] = await db
      .insert(providers)
      .values({ name: `redp-${suffix}`, baseUrl: 'https://upstream.test' })
      .returning({ id: providers.id });
    const [channel] = await db
      .insert(channels)
      .values({
        providerId: provider!.id,
        name: `redch-${suffix}`,
        apiKeyEnc: 'test-enc',
        upstreamBudget: '10',
      })
      .returning({ id: channels.id });
    const channelId = channel!.id;
    const billing = createBilling({ db });
    // 从连接池取一个专属连接做「行锁阻塞器」
    const pool = db.$client as unknown as {
      connect(): Promise<{
        query(sql: string, params?: unknown[]): Promise<unknown>;
        release(): void;
      }>;
    };

    try {
      // 两笔授权先就绪（预算 10，每笔渠道敞口 10）
      const reqA = randomUUID();
      const reqB = randomUUID();
      for (const r of [reqA, reqB]) {
        await billing.authorize({
          requestId: r,
          userId,
          stream: false,
          quote: quote(),
          reservationLimit: '50',
          authorizationTtlMs: 60_000,
        });
      }

      // 外部事务锁住渠道行（未提交）→ 两笔 reserve 的 UPDATE 都会阻塞在这把锁上
      const blocker = await pool.connect();
      await blocker.query('BEGIN');
      await blocker.query('UPDATE channels SET updated_at = now() WHERE id = $1', [channelId]);

      const reserveA = billing.reserveChannel({ requestId: reqA, channelId, amount: '10' });
      const reserveB = billing.reserveChannel({ requestId: reqB, channelId, amount: '10' });
      // 等待两笔都已通过读检查并阻塞在 UPDATE 上（读不受行锁阻塞）
      await new Promise((r) => setTimeout(r, 400));
      await blocker.query('COMMIT');
      blocker.release();
      const [resultA, resultB] = await Promise.all([reserveA, reserveB]);
      console.log(`[R4] reserveA=${JSON.stringify(resultA)} reserveB=${JSON.stringify(resultB)}`);

      const ch = await db.query.channels.findFirst({
        where: eq(channels.id, channelId),
        columns: { upstreamBudget: true, upstreamReserved: true },
      });
      const reserved = new Decimal(ch?.upstreamReserved ?? 0);
      const budget = new Decimal(ch?.upstreamBudget ?? 0);
      console.log(`[R4] upstream_reserved=${reserved.toString()} / budget=${budget.toString()}`);
      // 【红】当前实现 reserved=20 > budget=10；正确行为 <= 10 且第二笔 allowed:false
      expect(reserved.lte(budget)).toBe(true);

      // 释放两笔敞口，恢复现场（走真实信号路径）
      for (const r of [reqA, reqB]) {
        await billing
          .signal({
            type: 'request.failed',
            requestId: r,
            reason: 'rate_limited',
            delivery: 'none',
            upstreamCharge: 'none',
          })
          .catch(() => undefined);
      }
    } finally {
      await db.delete(billingRequests).where(eq(billingRequests.userId, userId));
      await db.delete(usageLogs).where(eq(usageLogs.userId, userId));
      await db.delete(transactions).where(eq(transactions.userId, userId));
      await db.delete(userSubscriptions).where(eq(userSubscriptions.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
      await db.delete(channels).where(eq(channels.id, channelId));
      await db.delete(providers).where(eq(providers.id, provider!.id));
    }
  });
});
