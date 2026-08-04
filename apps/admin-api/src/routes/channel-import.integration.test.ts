import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createDb, type Db } from '@ai-gateway/db';
import { users, channels, providers } from '@ai-gateway/db/schema';
import { channelImportRoutes } from './channel-import.js';
import { ValidationError } from '../lib/validation.js';
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

function makeApp(): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();
  app.onError((err, c) => {
    if (err instanceof ValidationError) {
      return c.json({ error: { message: '参数校验失败', code: 'VALIDATION_ERROR', details: err.details } }, 400);
    }
    return c.json({ error: { message: '内部错误', code: 'INTERNAL_ERROR' } }, 500);
  });
  app.use('/api/admin/*', async (c, next) => { await next(); });
  app.route('/', channelImportRoutes(db, process.env.ENCRYPTION_KEY ?? 'a'.repeat(32)));
  return app;
}

async function cleanupChannel(name: string): Promise<void> {
  const ch = await db.select().from(channels).where(eq(channels.name, name));
  for (const c of ch) await db.delete(channels).where(eq(channels.id, c.id));
}

describe('渠道批量导入（集成）', () => {
  it('供应商存在 → 成功导入', async () => {
    if (!connected) return it.skip('no DB');
    // 复用种子数据的 deepseek 供应商
    const dsProvider = await db.select().from(providers).where(eq(providers.name, 'deepseek')).limit(1);
    if (dsProvider.length === 0) return it.skip('no deepseek provider seeded');
    const name = 'import-test-' + Date.now();
    const app = makeApp();
    try {
      const res = await app.request('/api/admin/channels/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channels: [{ provider: 'deepseek', name, apiKey: 'sk-test123' }] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { total: number; success: number; details: Array<{ ok: boolean; name: string }> };
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
    const app = makeApp();
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
      const body = await res.json() as { success: number; failed: number; details: Array<{ ok: boolean; error?: string }> };
      expect(body.success).toBe(1);
      expect(body.failed).toBe(1);
      expect(body.details[0]!.ok).toBe(false);
      expect(body.details[0]!.error).toContain('不存在');
    } finally {
      await cleanupChannel(name);
      await cleanupChannel(name + '-2');
    }
  });

  it('空数组 → 400', async () => {
    if (!connected) return it.skip('no DB');
    const app = makeApp();
    const res = await app.request('/api/admin/channels/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channels: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('全部失败 → 400', async () => {
    if (!connected) return it.skip('no DB');
    const app = makeApp();
    const res = await app.request('/api/admin/channels/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channels: [{ provider: 'nope', name: 'x', apiKey: 'y' }] }),
    });
    expect(res.status).toBe(400);
  });
});
