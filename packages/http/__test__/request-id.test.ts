import { describe, expect, it } from 'vitest';
import { Keala } from 'keala';
import { asMiddleware, withRequest, type ContextOf } from '../src/framework/keala';
import { requestIdMiddleware } from '../src/request-context/request-id';

/**
 * 请求 ID 中间件行为锁：
 * requestId 永远服务端生成，不信任客户端头（限流 ZSET member / 计费幂等键安全性）。
 */

/** state 形状超集（requestId + 业务变量）——验证收窄类型在更宽 app 下可用 */
type TestContext = ContextOf<{ requestId: string; userId: number }>;

function app(): ReturnType<typeof withRequest> {
  const a = new Keala();
  a.use(asMiddleware(requestIdMiddleware()));
  a.get(
    '/id',
    asMiddleware((c: TestContext) => c.json({ requestId: c.state.requestId })),
  );
  return withRequest(a);
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

  it('state 形状超集可用（更宽的 app Context 下同一实现）', async () => {
    // 编译期验证 + 运行时同一实现：TestContext 比 { requestId } 多 userId
    const res = await app().request('/id');
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });
});
