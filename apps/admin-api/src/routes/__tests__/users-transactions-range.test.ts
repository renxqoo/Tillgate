import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { users } from '@ai-gateway/db/schema';
import { createWallet, type Wallet } from '@ai-gateway/wallet';
import { loadRootEnvFile } from '@ai-gateway/http';
import { userAdminRoutes } from '../users.js';
import { makeAdminTestApp, makeServices } from '../../test/helpers.js';

/**
 * A5 回归锁定（S7 重写）：GET /api/admin/users/:id/transactions。
 * 资金流水 = wallet statement（游标 newest-first，余额链恒等式由内核保证）。
 * 日期/类型过滤随旧 transactions 模型退役——流水以游标分页全量拉取。
 */

loadRootEnvFile();

const db: Db = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway', { poolMax: 5 });
const wallet: Wallet = createWallet(db, {
  accounts: [],
  refTypes: ['admin'],
  currencies: ['CNY'],
});
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

describe('admin 用户资金流水（wallet statement）', () => {
  it('三条入金按 newest-first 游标返回，非法日期仍 400', async (context) => {
    if (!connected) return context.skip();
    const s = `${Date.now()}`;
    const [u] = await db
      .insert(users)
      .values({ issuer: 'local', subject: `__a5_${s}`, identityProvider: 'local' })
      .returning({ id: users.id });
    for (let i = 0; i < 3; i += 1) {
      await wallet.credit({
        userId: u!.id,
        amount: '10',
        refType: 'admin',
        refId: `a5-${s}-${i}`,
      });
    }
    const app = makeAdminTestApp({ '/users': userAdminRoutes(makeServices(db)) });
    const q = async (qs: string) => {
      const res = await app.request(`/api/admin/users/${u!.id}/transactions${qs}`);
      return {
        status: res.status,
        body: (await res.json()) as {
          items?: Array<{ amount: string; balanceAfter: string }>;
          nextCursor?: number | null;
        },
      };
    };
    try {
      const all = await q('?page=1&page_size=50');
      expect(all.status).toBe(200);
      expect(all.body.items?.length).toBe(3);
      // newest-first + 逐条余额链（balanceAfter 递减 10）
      expect(all.body.items?.[0]?.balanceAfter).toBe('30');
      expect(all.body.items?.[2]?.balanceAfter).toBe('10');
      // 非法日期参数仍在 schema 层 400
      const bad = await q('?from=notadate');
      expect(bad.status).toBe(400);
    } finally {
      await db.delete(users).where(eq(users.id, u!.id));
    }
  });
});
