import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Bug3 复现：绑定渠道接口前后端字段不匹配。
 *   - 前端 apps/admin/.../models/actions.ts 发 { channelIds: number[] }
 *   - 后端 channels.ts:309 读 body.channels（期望 [{channelId,weight,priority}]）
 *   → body.channels 为 undefined → 解析出 0 条 → 删旧插空 → 绑定不落库
 *   → getChannels(realModel) 返回空 → 网关 503 no_available_channel「当前无可用渠道」
 *
 * 屏蔽 ../index.js：它模块顶层 serve() 起服务，且与 channels.ts 循环依赖（createApp→
 * channelAdminRoutes 触发 providerCreateSchema 的 TDZ）。绑定 handler 不读 env，给 stub 即可。
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

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway';
const db: Db = createDb(DATABASE_URL);

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

function makeApp(): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();
  app.use('/api/admin/*', async (_c, next) => {
    await next();
  });
  app.route('/', channelAdminRoutes(db));
  return app;
}

async function makeMapping(ext: string): Promise<number> {
  const [m] = await db
    .insert(modelMappings)
    .values({ externalName: ext, realModel: ext, status: 0 })
    .returning({ id: modelMappings.id });
  return m.id;
}

async function countBindings(mappingId: number): Promise<number> {
  const rows = await db.select().from(modelChannels).where(eq(modelChannels.mappingId, mappingId));
  return rows.length;
}

async function cleanup(mappingId: number): Promise<void> {
  await db.delete(modelChannels).where(eq(modelChannels.mappingId, mappingId)).catch(() => {});
  await db.delete(modelMappings).where(eq(modelMappings.id, mappingId)).catch(() => {});
}

describe('绑定渠道接口字段兼容（{channelIds} 与 {channels} 均应落库）', () => {
  it('前端格式 {channelIds:[id]} → 修复后绑定落库（回归保护）', async () => {
    if (!connected || channelId === null) return it.skip('no DB / no channel');
    const ext = `__repro_v4pro_${Date.now()}`;
    const mappingId = await makeMapping(ext);
    try {
      const app = makeApp();
      const res = await app.request(`/api/admin/models/${mappingId}/channels`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channelIds: [channelId] }),
      });
      const n = await countBindings(mappingId);
      // eslint-disable-next-line no-console
      console.log('[前端格式 {channelIds}] res.status =', res.status, '| 落库绑定数 =', n);
      // 修复后：前端简格式也应正确落库（不再静默丢失）
      expect(n).toBe(1);
    } finally {
      await cleanup(mappingId);
    }
  });

  it('后端期望格式 {channels:[{channelId}]} → 绑定落库成功（对照）', async () => {
    if (!connected || channelId === null) return it.skip('no DB / no channel');
    const ext = `__repro_v4pro_ok_${Date.now()}`;
    const mappingId = await makeMapping(ext);
    try {
      const app = makeApp();
      const res = await app.request(`/api/admin/models/${mappingId}/channels`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channels: [{ channelId }] }),
      });
      const n = await countBindings(mappingId);
      // eslint-disable-next-line no-console
      console.log('[后端格式 {channels}] res.status =', res.status, '| 落库绑定数 =', n);
      expect(n).toBe(1);
    } finally {
      await cleanup(mappingId);
    }
  });
});
