import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createDb, type Db } from '@ai-gateway/db';
import { requestLogs, users } from '@ai-gateway/db/schema';
import { statsAdminRoutes } from './stats.js';
import type { AdminEnv } from '../middleware/session.js';

/**
 * 验证 GET /api/admin/logs 返回用户名（userName）。
 * request_logs 只有 userId，需 LEFT JOIN users 取 displayName/email 供前端展示。
 */

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

function makeApp(): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();
  app.use('/api/admin/*', async (_c, next) => {
    await next();
  });
  app.route('/', statsAdminRoutes(db));
  return app;
}

async function insertLog(userId: number | null): Promise<number> {
  const [rl] = await db
    .insert(requestLogs)
    .values({
      requestId: randomUUID(),
      userId: userId ?? undefined,
      method: 'POST',
      path: '/v1/chat/completions',
      statusCode: 200,
      durationMs: 123,
    })
    .returning({ id: requestLogs.id });
  return rl.id;
}

describe('GET /api/admin/logs 返回用户名（userName）', () => {
  it('有 displayName → userName = displayName', async () => {
    if (!connected) return it.skip('no DB');
    const s = `${Date.now()}`;
    const [u] = await db
      .insert(users)
      .values({
        issuer: 'local',
        subject: `__logtest_${s}`,
        identityProvider: 'local',
        email: `logtest_${s}@example.com`,
        displayName: `日志测试用户_${s}`,
      })
      .returning({ id: users.id });
    const logId = await insertLog(u.id);
    try {
      const res = await makeApp().request('/api/admin/logs?page=1&page_size=10');
      const json = (await res.json()) as { list: Array<{ id: number; userName: string | null }> };
      const mine = json.list.find((r) => r.id === logId);
      // eslint-disable-next-line no-console
      console.log('[logs] displayName 场景 userName =', mine?.userName);
      expect(mine?.userName).toBe(`日志测试用户_${s}`);
    } finally {
      await db.delete(requestLogs).where(eq(requestLogs.id, logId)).catch(() => {});
      await db.delete(users).where(eq(users.id, u.id)).catch(() => {});
    }
  });

  it('无 displayName → userName 回退 email', async () => {
    if (!connected) return it.skip('no DB');
    const s = `${Date.now()}_2`;
    const [u] = await db
      .insert(users)
      .values({
        issuer: 'local',
        subject: `__logtest_${s}`,
        identityProvider: 'local',
        email: `fallback_${s}@example.com`,
        displayName: null,
      })
      .returning({ id: users.id });
    const logId = await insertLog(u.id);
    try {
      const res = await makeApp().request('/api/admin/logs?page=1&page_size=10');
      const json = (await res.json()) as { list: Array<{ id: number; userName: string | null }> };
      const mine = json.list.find((r) => r.id === logId);
      // eslint-disable-next-line no-console
      console.log('[logs] email 回退场景 userName =', mine?.userName);
      expect(mine?.userName).toBe(`fallback_${s}@example.com`);
    } finally {
      await db.delete(requestLogs).where(eq(requestLogs.id, logId)).catch(() => {});
      await db.delete(users).where(eq(users.id, u.id)).catch(() => {});
    }
  });
});
