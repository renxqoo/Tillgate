import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { modelMappings, modelChannels, channels } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { modelAdminRoutes } from './models.js';
import { makeAdminTestApp, makeServices } from '../test/helpers.js';

/**
 * 回显数据源验证：GET /api/admin/models 必须返回每个模型已绑定的渠道 channelIds，
 * 否则前端「绑定渠道」弹窗无法回显已选。
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
  if (ch.length === 0) ch = await db.select({ id: channels.id }).from(channels).where(eq(channels.status, 0)).limit(1);
  channelId = ch[0]?.id ?? null;
});
afterAll(async () => {
  await db.$client.end().catch(() => {});
});

async function cleanup(mappingId: number): Promise<void> {
  await db.delete(modelChannels).where(eq(modelChannels.mappingId, mappingId)).catch(() => {});
  await db.delete(modelMappings).where(eq(modelMappings.id, mappingId)).catch(() => {});
}

describe('GET /api/admin/models 回显已绑定渠道（channelIds）', () => {
  it('绑定渠道后，模型 list 中对应项含 channelIds', async () => {
    if (!connected || channelId === null) return it.skip('no DB / no channel');
    const ext = `__echo_${Date.now()}`;
    const [m] = await db
      .insert(modelMappings)
      .values({ externalName: ext, realModel: ext, status: 0 })
      .returning({ id: modelMappings.id });
    const mappingId = m!.id;
    try {
      const app = makeAdminTestApp({ '/models': modelAdminRoutes(makeServices(db)) });
      await app.request(`/api/admin/models/${mappingId}/channels`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channels: [{ channelId }] }),
      });
      const res = await app.request('/api/admin/models');
      const json = (await res.json()) as { list: Array<{ id: number; channelIds: number[] }> };
      const mine = json.list.find((row) => row.id === mappingId);
      expect(Array.isArray(mine?.channelIds)).toBe(true);
      expect(mine!.channelIds).toContain(channelId);
    } finally {
      await cleanup(mappingId);
    }
  });

  it('未绑定渠道的模型，channelIds 为空数组（而非 undefined）', async () => {
    if (!connected || channelId === null) return it.skip('no DB / no channel');
    const ext = `__echo_empty_${Date.now()}`;
    const [m] = await db
      .insert(modelMappings)
      .values({ externalName: ext, realModel: ext, status: 0 })
      .returning({ id: modelMappings.id });
    const mappingId = m!.id;
    try {
      const app = makeAdminTestApp({ '/models': modelAdminRoutes(makeServices(db)) });
      const res = await app.request('/api/admin/models');
      const json = (await res.json()) as { list: Array<{ id: number; channelIds: number[] }> };
      const mine = json.list.find((row) => row.id === mappingId);
      expect(mine?.channelIds).toEqual([]);
    } finally {
      await cleanup(mappingId);
    }
  });
});
