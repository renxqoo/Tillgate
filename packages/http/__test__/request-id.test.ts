import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { requestIdMiddleware } from '../src/request-context/request-id';

/**
 * 请求 ID 中间件（v1 三拷贝无包级测试——D1 合一后新写行为锁）：
 * requestId 永远服务端生成，不信任客户端头（限流 ZSET member / 计费幂等键安全性）。
 */

interface TestEnv {
  Variables: { requestId: string; userId: number };
}

function app(): Hono<TestEnv> {
  const a = new Hono<TestEnv>();
  a.use(requestIdMiddleware());
  a.get('/id', (c) => c.json({ requestId: c.get('requestId') }));
  return a;
}

describe('requestIdMiddleware', () => {
  it('服务端生成 UUID（v4 形态）且响应头回显一致', async () => {
    const res = await app().request('/id');
    expect(res.status).toBe(200);
    const header = res.headers.get('x-request-id');
    const body = (await res.json()) as { requestId: string };
    expect(header).toBe(body.requestId);
    expect(body.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('客户端 X-Request-Id 不被信任（防限流去重/幂等键投毒）', async () => {
    const res = await app().request('/id', { headers: { 'x-request-id': 'evil-fixed-id' } });
    const body = (await res.json()) as { requestId: string };
    expect(body.requestId).not.toBe('evil-fixed-id');
  });

  it('每次请求生成新 ID', async () => {
    const a = app();
    const first = ((await (await a.request('/id')).json()) as { requestId: string }).requestId;
    const second = ((await (await a.request('/id')).json()) as { requestId: string }).requestId;
    expect(first).not.toBe(second);
  });

  it('泛型兼容更宽的 app Env（Variables 超集可用）', async () => {
    // 编译期验证 + 运行时同一实现：TestEnv 比 { Variables: { requestId } } 多 userId
    const res = await app().request('/id');
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });
});
