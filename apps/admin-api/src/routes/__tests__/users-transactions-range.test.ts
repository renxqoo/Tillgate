import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { users, transactions } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { userAdminRoutes } from '../users.js';
import { makeAdminTestApp, makeServices } from '../../test/helpers.js';

/**
 * A5 回归锁定（R7 功能）：GET /api/admin/users/:id/transactions 的 from/to 过滤。
 * 造三条不同日期、满足余额链恒等式（transactions_balance_chain_ck）的流水验证筛选。
 */

loadRootEnvFile();

const db: Db = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway', { poolMax: 5 });
let connected = false;
beforeAll(async () => {
  try {
    await db.select({ id: users.id }).from(users).limit(1);
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => db.$client.end().catch(() => {}));

/** 天偏移日期与 ISO 串（不捕获闭包变量，外提避免每用例重建） */
const day = (offsetDays: number): Date => new Date(Date.now() + offsetDays * 86_400_000);
const iso = (d: Date): string => d.toISOString();

describe('admin 用户交易 from/to 过滤（A5）', () => {
  it('按日期筛出对应流水；非法日期 400；from+to 组合', async (context) => {
    if (!connected) return context.skip();
    const s = `${Date.now()}`;
    const [u] = await db
      .insert(users)
      .values({ issuer: 'local', subject: `__a5_${s}`, identityProvider: 'local', balance: '80' })
      .returning({ id: users.id });
    // 链：100→90→85→80（恒等式成立）
    const rows = [
      { amount: '-10', balanceBefore: '100', balanceAfter: '90', at: day(-3) },
      { amount: '-5', balanceBefore: '90', balanceAfter: '85', at: day(-1) },
      { amount: '-5', balanceBefore: '85', balanceAfter: '80', at: day(0) },
    ];
    for (const r of rows) {
      await db.insert(transactions).values({
        userId: u!.id,
        type: 'manual',
        amount: r.amount,
        balanceBefore: r.balanceBefore,
        balanceAfter: r.balanceAfter,
        refType: 'admin_adjust',
        refId: `a5-${s}`,
        createdAt: r.at,
      });
    }
    const app = makeAdminTestApp({ '/users': userAdminRoutes(makeServices(db)) });
    const q = async (qs: string) => {
      const res = await app.request(`/api/admin/users/${u!.id}/transactions${qs}`);
      return { status: res.status, body: (await res.json()) as { list?: Array<{ id: number }>; total?: number } };
    };
    try {
      const all = await q('?page=1&page_size=50');
      expect(all.status).toBe(200);
      expect(all.body.total).toBe(3);

      const fromOnly = await q(`?from=${iso(day(-2))}`);
      expect(fromOnly.body.total).toBe(2); // 昨天 + 今天
      const toOnly = await q(`?to=${iso(day(-2))}`);
      expect(toOnly.body.total).toBe(1); // 前天
      const both = await q(`?from=${iso(day(-2))}&to=${iso(day(-1))}`);
      expect(both.body.total).toBe(1); // 昨天
      const bad = await q('?from=notadate');
      expect(bad.status).toBe(400);
    } finally {
      await db.delete(transactions).where(eq(transactions.userId, u!.id));
      await db.delete(users).where(eq(users.id, u!.id));
    }
  });
});
