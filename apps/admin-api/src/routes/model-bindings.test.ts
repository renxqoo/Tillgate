import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { modelMappings, modelChannels, channels } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { modelAdminRoutes } from './models.js';
import { makeAdminTestApp, makeServices } from '../test/helpers.js';

/**
 * 模型-渠道绑定契约（POST /api/admin/models/:id/channels）。
 * body 格式唯一标准：{ channels: [{channelId, weight?, priority?}] }，全量替换语义：
 *   - 提交绑定列表 → 落库（先删旧再插新，事务保证）
 *   - 空数组 → 解绑全部
 */

loadRootEnvFile();

const db: Db = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway');

let connected = false;
let channelId: number | null = null;

beforeAll(async () => {
  try {
    await db.select({ id: channels.id }).from(channels).limit(1);
    connected = true;
  } catch {
    connected = false;
  }
  if (!connected) return;
  let ch = await db.select({ id: channels.id }).from(channels).where(eq(channels.name, 'deepseek-default')).limit(1);
  if (ch.length === 0) {
    ch = await db.select({ id: channels.id }).from(channels).where(eq(channels.status, 0)).limit(1);
  }
  channelId = ch[0]?.id ?? null;
});
afterAll(async () => {
  await db.$client.end().catch(() => {});
});

async function makeMapping(ext: string): Promise<number> {
  const [m] = await db
    .insert(modelMappings)
    .values({ externalName: ext, realModel: ext, status: 0 })
    .returning({ id: modelMappings.id });
  return m!.id;
}

async function countBindings(mappingId: number): Promise<number> {
  const rows = await db.select().from(modelChannels).where(eq(modelChannels.mappingId, mappingId));
  return rows.length;
}

async function cleanup(mappingId: number): Promise<void> {
  await db.delete(modelChannels).where(eq(modelChannels.mappingId, mappingId)).catch(() => {});
  await db.delete(modelMappings).where(eq(modelMappings.id, mappingId)).catch(() => {});
}

describe('模型-渠道绑定（全量替换语义）', () => {
  it('标准格式 {channels:[{channelId}]} → 绑定落库', async () => {
    if (!connected || channelId === null) return it.skip('no DB / no channel');
    const ext = `__bind_${Date.now()}`;
    const mappingId = await makeMapping(ext);
    try {
      const app = makeAdminTestApp({ '/models': modelAdminRoutes(makeServices(db)) });
      const res = await app.request(`/api/admin/models/${mappingId}/channels`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channels: [{ channelId }] }),
      });
      expect(res.status).toBe(200);
      expect(await countBindings(mappingId)).toBe(1);
    } finally {
      await cleanup(mappingId);
    }
  });

  it('重复提交不同渠道 → 全量替换（旧绑定被清）', async () => {
    if (!connected || channelId === null) return it.skip('no DB / no channel');
    const ext = `__replace_${Date.now()}`;
    const mappingId = await makeMapping(ext);
    // 备用渠道：任取一个 status=0 的渠道（可能是同一渠道，替换语义不受影响）
    const extra = await db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.status, 0))
      .orderBy(channels.id)
      .limit(2);
    const otherId = extra.length > 1 ? extra[1]!.id : channelId;
    try {
      const app = makeAdminTestApp({ '/models': modelAdminRoutes(makeServices(db)) });
      await app.request(`/api/admin/models/${mappingId}/channels`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channels: [{ channelId }] }),
      });
      await app.request(`/api/admin/models/${mappingId}/channels`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channels: [{ channelId: otherId }] }),
      });
      const rows = await db.select().from(modelChannels).where(eq(modelChannels.mappingId, mappingId));
      expect(rows.length).toBe(1);
      expect(rows[0]!.channelId).toBe(otherId);
    } finally {
      await cleanup(mappingId);
    }
  });

  it('空数组 → 解绑全部', async () => {
    if (!connected || channelId === null) return it.skip('no DB / no channel');
    const ext = `__unbind_${Date.now()}`;
    const mappingId = await makeMapping(ext);
    try {
      const app = makeAdminTestApp({ '/models': modelAdminRoutes(makeServices(db)) });
      await app.request(`/api/admin/models/${mappingId}/channels`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channels: [{ channelId }] }),
      });
      const res = await app.request(`/api/admin/models/${mappingId}/channels`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channels: [] }),
      });
      expect(res.status).toBe(200);
      expect(await countBindings(mappingId)).toBe(0);
    } finally {
      await cleanup(mappingId);
    }
  });
});
