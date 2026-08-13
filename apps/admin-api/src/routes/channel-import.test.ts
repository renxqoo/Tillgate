import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { users, channels, providers } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { channelAdminRoutes } from './channels.js';
import { makeAdminTestApp, makeServices } from '../test/helpers.js';

/**
 * 渠道批量导入（集成）：POST /api/admin/channels/import。
 * best-effort：单条失败不中断整体导入；全部失败 → 400。
 */

loadRootEnvFile();

const db: Db = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway');

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

async function cleanupChannel(name: string): Promise<void> {
  const ch = await db.select().from(channels).where(eq(channels.name, name));
  for (const c of ch) await db.delete(channels).where(eq(channels.id, c.id));
}

describe('渠道批量导入（集成）', () => {
  it('供应商存在 → 成功导入', async () => {
    if (!connected) return it.skip('no DB');
    const dsProvider = await db.select().from(providers).where(eq(providers.name, 'deepseek')).limit(1);
    if (dsProvider.length === 0) return it.skip('no deepseek provider seeded');
    const name = 'import-test-' + Date.now();
    const app = makeAdminTestApp({ '/channels': channelAdminRoutes(makeServices(db)) });
    try {
      const res = await app.request('/api/admin/channels/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channels: [{ provider: 'deepseek', name, apiKey: 'sk-test123' }] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { total: number; success: number; details: Array<{ ok: boolean; name: string }> };
      expect(body.total).toBe(1);
      expect(body.success).toBe(1);
      expect(body.details[0]!.ok).toBe(true);
    } finally {
      await cleanupChannel(name);
    }
  });

  it('供应商不存在 → 该条失败，但不中断', async () => {
    if (!connected) return it.skip('no DB');
    const name = 'import-test-' + Date.now();
    const app = makeAdminTestApp({ '/channels': channelAdminRoutes(makeServices(db)) });
    try {
      const res = await app.request('/api/admin/channels/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channels: [
          { provider: 'nonexistent-provider', name, apiKey: 'sk-x' },
          { provider: 'deepseek', name: name + '-2', apiKey: 'sk-y' },
        ] }),
      });
      expect(res.status).toBe(200); // 部分成功
      const body = (await res.json()) as { success: number; failed: number; details: Array<{ ok: boolean; error?: string }> };
      expect(body.success).toBe(1);
      expect(body.failed).toBe(1);
      expect(body.details[0]!.ok).toBe(false);
      expect(body.details[0]!.error).toContain('不存在');
    } finally {
      await cleanupChannel(name);
      await cleanupChannel(name + '-2');
    }
  });

  it('空数组 → 400（校验错误）', async () => {
    if (!connected) return it.skip('no DB');
    const app = makeAdminTestApp({ '/channels': channelAdminRoutes(makeServices(db)) });
    const res = await app.request('/api/admin/channels/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channels: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('全部失败 → 400', async () => {
    if (!connected) return it.skip('no DB');
    const app = makeAdminTestApp({ '/channels': channelAdminRoutes(makeServices(db)) });
    const res = await app.request('/api/admin/channels/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channels: [{ provider: 'nope', name: 'x', apiKey: 'y' }] }),
    });
    expect(res.status).toBe(400);
  });
});
