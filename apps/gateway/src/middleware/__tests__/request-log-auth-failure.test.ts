import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, gte } from 'drizzle-orm';
import { requestLogs } from '@ai-gateway/db/schema';
import {
  loadEnvFileIntoProcess,
  ensureTestSecrets,
  createTestDb,
  createTestRedis,
  isBackendAvailable,
  buildTestApp,
  makeMockAi,
} from '../../testing/helpers.js';

/**
 * request-log 前置修复：鉴权失败（401）也必须写入 request_logs。
 * 旧实现 requestLog 挂在鉴权之后 → 401/429 在 request_logs 里不可见，无法排查爆破。
 */

loadEnvFileIntoProcess();
ensureTestSecrets();

const db = createTestDb();
const redis = createTestRedis();

let connected = false;
beforeAll(async () => {
  await redis.connect().catch(() => {});
  connected = await isBackendAvailable(db, redis);
});
afterAll(async () => {
  await redis.quit().catch(() => {});
  await db.$client.end().catch(() => {});
});

describe('request_logs 记录鉴权失败', () => {
  it('无效凭证 → 401 且写入 request_logs（errorCode=http_401）', async () => {
    if (!connected) return it.skip('no DB');
    const startedAt = new Date(Date.now() - 2000); // 只查本次测试产生的行（测试文件并行共享 DB）
    const app = buildTestApp(db, redis, makeMockAi());
    // 随机不存在的 key（固定 key 会触发爆破锁定变成 429）
    const fakeKey = 'ag_' + randomUUID().replace(/-/g, '');
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${fakeKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(401);

    // fire-and-forget 写入：轮询等待落库
    let row: { statusCode: number; errorCode: string | null } | undefined;
    for (let i = 0; i < 40 && !row; i++) {
      await new Promise((r) => setTimeout(r, 50));
      row = await db.query.requestLogs.findFirst({
        where: and(
          eq(requestLogs.path, '/v1/chat/completions'),
          eq(requestLogs.statusCode, 401),
          gte(requestLogs.createdAt, startedAt),
        ),
        columns: { statusCode: true, errorCode: true },
      });
    }
    expect(row).toBeDefined();
    expect(row?.statusCode).toBe(401);
    expect(row?.errorCode).toBe('http_401');
  });
});
