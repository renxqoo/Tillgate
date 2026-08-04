import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createDb, type Db } from '@ai-gateway/db';
import { rateCards, rateCardCoefficients, users } from '@ai-gateway/db/schema';
import { rateCardAdminRoutes } from './rate-cards.js';
import { ValidationError } from '../lib/validation.js';

const cwd = dirname(fileURLToPath(import.meta.url));
function loadEnvFile(): void {
  let dir = cwd;
  for (let i = 0; i < 6; i++) {
    const f = resolve(dir, '.env');
    if (existsSync(f)) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
        if (m && m[1] && !(m[1] in process.env)) process.env[m[1]] = m[2];
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
loadEnvFile();

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway';
const db: Db = createDb(DATABASE_URL);

let connected = false;
beforeAll(async () => {
  try {
    await db.query.users.findFirst({ where: eq(users.id, 1), columns: { id: true } });
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => {
  await db.$client.end().catch(() => {});
});

/** 构造测试 app：跳过鉴权（注入一个 always-pass 中间件），专注测路由逻辑 */
function makeApp(): Hono {
  const app = new Hono();
  // 复刻 createApp 的统一错误处理（ValidationError → 400）
  app.onError((err, c) => {
    if (err instanceof ValidationError) {
      return c.json({ error: { message: '参数校验失败', code: 'VALIDATION_ERROR', details: err.details } }, 400);
    }
    return c.json({ error: { message: '内部错误', code: 'INTERNAL_ERROR' } }, 500);
  });
  // 测试用：直接放行（鉴权逻辑由 admin-auth.test.ts 覆盖）
  app.use('/api/admin/*', async (c, next) => {
    await next();
  });
  app.route('/', rateCardAdminRoutes(db));
  return app;
}

async function cleanupCard(name: string): Promise<void> {
  const cards = await db.select().from(rateCards).where(eq(rateCards.name, name));
  for (const c of cards) {
    await db.delete(rateCardCoefficients).where(eq(rateCardCoefficients.rateCardId, c.id));
    await db.delete(rateCards).where(eq(rateCards.id, c.id));
  }
}

describe('费率卡管理路由（集成）', () => {
  it('创建 → 列表 → 更新 → 删除 全流程', async () => {
    if (!connected) return it.skip('no DB');
    const name = 'test-card-' + Date.now();
    const app = makeApp();
    try {
      // 创建（必须带 coefficient）
      const createRes = await app.request('/api/admin/rate-cards', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, coefficient: 1.5, description: 'test' }),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as { id: number; name: string; coefficient: string };
      expect(created.name).toBe(name);
      expect(created.coefficient).toBe('1.500');
      const cardId = created.id;

      // 列表含新建卡
      const listRes = await app.request('/api/admin/rate-cards');
      const list = (await listRes.json()) as { list: Array<{ id: number; coefficient: string }> };
      const found = list.list.find((r) => r.id === cardId);
      expect(found).toBeDefined();
      expect(found!.coefficient).toBe('1.500');

      // health：全局系数存在
      const healthRes = await app.request(`/api/admin/rate-cards/${cardId}/health`);
      const health = (await healthRes.json()) as { hasGlobalCoefficient: boolean };
      expect(health.hasGlobalCoefficient).toBe(true);

      // 更新系数
      const updRes = await app.request(`/api/admin/rate-cards/${cardId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ coefficient: 0.8, description: 'updated' }),
      });
      expect(updRes.status).toBe(200);
      const list2 = (await (await app.request('/api/admin/rate-cards')).json()) as { list: Array<{ id: number; coefficient: string }> };
      const found2 = list2.list.find((r) => r.id === cardId);
      expect(found2!.coefficient).toBe('0.800');

      // 删除（无用户绑定）
      const delRes = await app.request(`/api/admin/rate-cards/${cardId}`, { method: 'DELETE' });
      expect(delRes.status).toBe(200);
      const list3 = (await (await app.request('/api/admin/rate-cards')).json()) as { list: Array<{ id: number }> };
      expect(list3.list.find((r) => r.id === cardId)).toBeUndefined();
    } finally {
      await cleanupCard(name);
    }
  });

  it('系数越界（>9.999）→ 400', async () => {
    if (!connected) return it.skip('no DB');
    const app = makeApp();
    const res = await app.request('/api/admin/rate-cards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'bad-coeff', coefficient: 99 }),
    });
    expect(res.status).toBe(400);
  });

  it('系数负数 → 400', async () => {
    if (!connected) return it.skip('no DB');
    const app = makeApp();
    const res = await app.request('/api/admin/rate-cards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'bad-coeff', coefficient: -1 }),
    });
    expect(res.status).toBe(400);
  });
});
