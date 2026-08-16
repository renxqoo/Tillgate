import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  loadEnvFileIntoProcess,
  ensureTestSecrets,
  createTestDb,
  createTestRedis,
  isBackendAvailable,
  buildTestApp,
  makeMockAi,
} from '../../testing/helpers.js';
import { createAuthFailureGuard } from '../auth-failure-guard.js';

/**
 * 07 修复回归测试 —— 来源级鉴权失败限流。
 *
 * 修复前：无效 Key 在鉴权阶段 401，走不到 RPM/TPM 限流器；per-key brute-force 只按 keyHash
 * 计数（换随机 Key 即绕过）→ 同一来源可无限刷 401。
 * 修复后：按来源 IP 计数鉴权失败，短窗口内达阈值即 429。
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

describe('AuthFailureGuard（07）', () => {
  it('窗口内失败达阈值后锁定，之后 isLocked=true', async () => {
    if (!connected) return it.skip('no DB');
    const ip = '198.51.100.' + Math.floor(Math.random() * 250 + 1);
    const guard = createAuthFailureGuard(redis, { limit: 3, windowS: 60 });
    try {
      for (let i = 0; i < 3; i++) {
        const r = await guard.recordFailure(ip);
        if (i < 2) expect(r.limited).toBe(false);
        else expect(r.limited).toBe(true);
      }
      const locked = await guard.isLocked(ip);
      expect(locked.limited).toBe(true);
      expect(locked.retryAfterSec).toBeGreaterThan(0);
    } finally {
      await redis.del(`authfail:ip:${ip}`).catch(() => {});
      await redis.del(`authfail:ip:lock:${ip}`).catch(() => {});
    }
  });
});

describe('gateway 鉴权失败来源限流（07 集成）', () => {
  it('同一来源连续换随机无效 Key → 超过阈值后出现 429', async () => {
    if (!connected) return it.skip('no DB');
    const ip = '203.0.113.' + Math.floor(Math.random() * 250 + 1);
    const app = buildTestApp(db, redis, makeMockAi());
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 15; i++) {
        const fakeKey = 'ag_invalid_' + randomUUID().replace(/-/g, '') + '_' + i;
        const res = await app.request('/v1/chat/completions', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${fakeKey}`,
            'content-type': 'application/json',
            'x-forwarded-for': ip,
          },
          body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
        });
        statuses.push(res.status);
      }
      // 前 N 次 401，达阈值后 429（默认 limit=10，窗口 60s）
      expect(statuses.filter((s) => s === 401).length).toBeGreaterThan(0);
      expect(statuses.some((s) => s === 429)).toBe(true);
    } finally {
      await redis.del(`authfail:ip:${ip}`).catch(() => {});
      await redis.del(`authfail:ip:lock:${ip}`).catch(() => {});
    }
  });
});
