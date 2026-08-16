import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { usageLogs, users } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { usageRoutes } from '../usage.js';
import { makeClientTestApp, makeServices } from '../../test/helpers.js';

/**
 * GET /api/usage/by-model：按模型聚合 + 用户隔离（只返回 session.userId 的用量）。
 * stub session 中间件绕过真实 JWT cookie 解析，直接注入 { userId }。
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
afterAll(async () => {
  await db.$client.end().catch(() => {});
});

async function insertUsage(
  userId: number,
  model: string,
  amount: string,
  tokens: { inn: number; out: number; cached: number } = { inn: 100, out: 50, cached: 0 },
): Promise<number> {
  const [r] = await db
    .insert(usageLogs)
    .values({
      requestId: randomUUID(),
      userId,
      credentialType: 'key',
      externalModel: model,
      realModel: model,
      coefficient: '1.000',
      billedBy: 'payg',
      amount,
      inputTokens: tokens.inn,
      cachedInputTokens: tokens.cached,
      outputTokens: tokens.out,
    })
    .returning({ id: usageLogs.id });
  return r!.id;
}

describe('GET /api/usage/by-model', () => {
  it('按模型聚合，且只返回当前用户的用量（用户隔离）', async () => {
    if (!connected) return it.skip('no DB');
    const s = `${Date.now()}`;
    const [me] = await db
      .insert(users)
      .values({ issuer: 'local', subject: `__bymodel_me_${s}`, identityProvider: 'local' })
      .returning({ id: users.id });
    const [other] = await db
      .insert(users)
      .values({ issuer: 'local', subject: `__bymodel_ot_${s}`, identityProvider: 'local' })
      .returning({ id: users.id });
    const ids: number[] = [];
    try {
      ids.push(await insertUsage(me!.id, 'model-A', '10.00', { inn: 100, out: 50, cached: 60 }));
      ids.push(await insertUsage(me!.id, 'model-B', '5.00', { inn: 100, out: 50, cached: 0 }));
      ids.push(await insertUsage(other!.id, 'model-X', '999.00')); // 别人的，不应返回

      const app = makeClientTestApp(me!.id, { '/usage': usageRoutes(makeServices(db)) });
      const res = await app.request('/api/usage/by-model');
      const json = (await res.json()) as {
        list: Array<{ model: string; requests: number; inputTokens: number; outputTokens: number; cost: number }>;
      };

      const models = json.list.map((r) => r.model);
      expect(models).toContain('model-A');
      expect(models).toContain('model-B');
      expect(models).not.toContain('model-X'); // 用户隔离

      // cost desc 排序：model-A(10) 排在 model-B(5) 前
      expect(json.list[0]!.model).toBe('model-A');

      const a = json.list.find((r) => r.model === 'model-A');
      expect(a!.cost).toBeCloseTo(10, 5);
      expect(a!.inputTokens).toBe(100);
      expect(a!.outputTokens).toBe(50);
      expect(a!.requests).toBe(1);
    } finally {
      for (const id of ids) await db.delete(usageLogs).where(eq(usageLogs.id, id)).catch(() => {});
      await db.delete(users).where(eq(users.id, me!.id)).catch(() => {});
      await db.delete(users).where(eq(users.id, other!.id)).catch(() => {});
    }
  });
});
