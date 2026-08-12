import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * 回显数据源验证：GET /api/admin/models 必须返回每个模型已绑定的渠道 channelIds，
 * 否则前端「绑定渠道」弹窗无法回显已选。
 */
vi.mock('../index.js', () => ({
  env: { ENCRYPTION_KEY: 'a'.repeat(32) },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}));

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createDb, type Db } from '@ai-gateway/db';
import { modelMappings, modelChannels, channels } from '@ai-gateway/db/schema';
import { channelAdminRoutes } from './channels.js';
import type { AdminEnv } from '../middleware/session.js';

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

function makeApp(): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();
  app.use('/api/admin/*', async (_c, next) => {
    await next();
  });
  app.route('/', channelAdminRoutes(db));
  return app;
}

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
    const mappingId = m.id;
    try {
      const app = makeApp();
      // 绑定一个渠道
      await app.request(`/api/admin/models/${mappingId}/channels`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channels: [{ channelId }] }),
      });
      // 查列表
      const res = await app.request('/api/admin/models');
      const json = (await res.json()) as { list: Array<{ id: number; channelIds: number[] }> };
      const mine = json.list.find((row) => row.id === mappingId);
      // eslint-disable-next-line no-console
      console.log('[echo] mine.channelIds =', mine?.channelIds);
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
    const mappingId = m.id;
    try {
      const app = makeApp();
      const res = await app.request('/api/admin/models');
      const json = (await res.json()) as { list: Array<{ id: number; channelIds: number[] }> };
      const mine = json.list.find((row) => row.id === mappingId);
      expect(mine?.channelIds).toEqual([]);
    } finally {
      await cleanup(mappingId);
    }
  });
});
