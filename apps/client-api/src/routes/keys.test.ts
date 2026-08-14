import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { users, apiKeys } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { keyRoutes } from './keys.js';
import { makeClientTestApp, makeServices } from '../test/helpers.js';

/**
 * PATCH /api/keys/:id 安全回显：不回显 keyHash（明文 Key 创建后不可再取回），
 * 只返回与列表一致的脱敏字段（keyPreview + 业务字段）。
 */

loadRootEnvFile();

const db: Db = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway');

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

describe('PATCH /api/keys/:id 回显脱敏（不回显 keyHash）', () => {
  it('只回显 keyPreview 与业务字段，绝不含 keyHash', async () => {
    if (!connected) return it.skip('no DB');
    const s = `${Date.now()}`;
    const [me] = await db
      .insert(users)
      .values({ issuer: 'local', subject: `__kpatch_me_${s}`, identityProvider: 'local' })
      .returning({ id: users.id });
    const [k] = await db
      .insert(apiKeys)
      .values({
        keyHash: randomUUID(),
        keyPreview: 'ag_****abcd',
        userId: me!.id,
        name: `测试Key_${s}`,
      })
      .returning({ id: apiKeys.id });
    try {
      const app = makeClientTestApp(me!.id, { '/keys': keyRoutes(makeServices(db)) });
      const res = await app.request(`/api/keys/${k!.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `改名Key_${s}` }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;

      // 绝不回显 hash / 明文
      expect(json.keyHash).toBeUndefined();
      expect(json.key).toBeUndefined();
      // 回显脱敏 preview + 业务字段
      expect(json.keyPreview).toBe('ag_****abcd');
      expect(json.name).toBe(`改名Key_${s}`);
      expect(json.id).toBe(k!.id);
      expect(json).toHaveProperty('dailySpendLimit');
      expect(json).toHaveProperty('status');
    } finally {
      await db.delete(apiKeys).where(eq(apiKeys.id, k!.id)).catch(() => {});
      await db.delete(users).where(eq(users.id, me!.id)).catch(() => {});
    }
  });
});
