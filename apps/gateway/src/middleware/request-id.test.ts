import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { requestIdMiddleware } from './request-id.js';
import type { AuthEnv } from './auth.js';

/**
 * requestId 安全防线（S1）：
 *   - 限流 ZSET 用 requestId 作 member（rate-limit.ts:30）
 *   - 若信任客户端 X-Request-Id → 攻击者固定发同一 ID → 计数去重为 1 → 绕过 RPM
 *   - 修复：requestId 永远服务端生成（UUID），客户端头仅用于日志关联不进限流
 */

/** 测试用 Hono app，挂载 requestIdMiddleware，回显 requestId */
function makeApp() {
  const app = new Hono<AuthEnv>();
  app.use('*', requestIdMiddleware());
  app.get('/', (c) => c.json({ requestId: c.var.requestId }));
  app.post('/', (c) => c.json({ requestId: c.var.requestId }));
  return app;
}

describe('requestId 中间件（安全：防限流绕过）', () => {
  it('无 X-Request-Id 头 → 服务端生成 UUID', async () => {
    const app = makeApp();
    const res = await app.request('/');
    const body = (await res.json()) as { requestId: string };
    expect(body.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(res.headers.get('x-request-id')).toBe(body.requestId);
  });

  it('有 X-Request-Id 头 → 服务端仍生成新 UUID（不信任客户端）', async () => {
    const app = makeApp();
    const res = await app.request('/', {
      headers: { 'x-request-id': 'attacker-fixed-id' },
    });
    const body = (await res.json()) as { requestId: string };
    // requestId 是服务端生成的 UUID，不是客户端传的
    expect(body.requestId).not.toBe('attacker-fixed-id');
    expect(body.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it('两次请求带相同 X-Request-Id → 内部 requestId 不同（限流 member 不被去重）', async () => {
    const app = makeApp();
    const res1 = await app.request('/', {
      headers: { 'x-request-id': 'same-id' },
    });
    const res2 = await app.request('/', {
      headers: { 'x-request-id': 'same-id' },
    });
    const id1 = ((await res1.json()) as { requestId: string }).requestId;
    const id2 = ((await res2.json()) as { requestId: string }).requestId;
    // 两次请求的 requestId 不同 → 限流 ZADD 各算一次 → 无法绕过 RPM
    expect(id1).not.toBe(id2);
  });

  it('客户端 X-Request-Id 可选保留到响应头（日志关联用）', async () => {
    const app = makeApp();
    const res = await app.request('/', {
      headers: { 'x-request-id': 'client-trace-123' },
    });
    const body = (await res.json()) as { requestId: string };
    // 响应头回写服务端 requestId（不回写客户端的）
    expect(res.headers.get('x-request-id')).toBe(body.requestId);
  });
});
