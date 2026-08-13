import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { requestLogs, users } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { logAdminRoutes } from './logs.js';
import { makeAdminTestApp, makeServices } from '../test/helpers.js';

/**
 * 验证 GET /api/admin/logs 返回用户名（userName）。
 * request_logs 只有 userId，需 LEFT JOIN users 取 displayName/email 供前端展示。
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
  return rl!.id;
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
    const logId = await insertLog(u!.id);
    try {
      const res = await makeAdminTestApp({ '/logs': logAdminRoutes(makeServices(db)) }).request('/api/admin/logs?page=1&page_size=10');
      const json = (await res.json()) as { list: Array<{ id: number; userName: string | null }> };
      const mine = json.list.find((r) => r.id === logId);
      expect(mine?.userName).toBe(`日志测试用户_${s}`);
    } finally {
      await db.delete(requestLogs).where(eq(requestLogs.id, logId)).catch(() => {});
      await db.delete(users).where(eq(users.id, u!.id)).catch(() => {});
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
    const logId = await insertLog(u!.id);
    try {
      const res = await makeAdminTestApp({ '/logs': logAdminRoutes(makeServices(db)) }).request('/api/admin/logs?page=1&page_size=10');
      const json = (await res.json()) as { list: Array<{ id: number; userName: string | null }> };
      const mine = json.list.find((r) => r.id === logId);
      expect(mine?.userName).toBe(`fallback_${s}@example.com`);
    } finally {
      await db.delete(requestLogs).where(eq(requestLogs.id, logId)).catch(() => {});
      await db.delete(users).where(eq(users.id, u!.id)).catch(() => {});
    }
  });
});
