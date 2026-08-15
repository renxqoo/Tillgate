import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { operationId } from '../idempotency.js';
import { errorHandler } from '../errors.js';

/**
 * T1 回归：客户端幂等键与系统自然键的命名空间隔离。
 * fund_operations.operationId 是全局主键，系统键（signup-gift:{id} 等）一律含 ':'；
 * 客户键必须被限制在不含 ':' 的安全字符集内——否则任何登录用户可用
 * `idempotency-key: signup-gift:<受害者id>` 完成一次购买，永久占用该键，
 * 使受害者首次登录的礼金发放撞主键 → 登录 500（实弹复现见脚本 22）。
 */
function app(): Hono {
  const a = new Hono();
  a.onError(errorHandler());
  a.post('/op', (c) => c.json({ operationId: operationId(c) }));
  return a;
}

describe('operationId 客户键边界（T1）', () => {
  it('合法键原样透传', async () => {
    const res = await app().request('/op', {
      method: 'POST',
      headers: { 'idempotency-key': 'order-20260815_abc-123' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ operationId: 'order-20260815_abc-123' });
  });

  it('含冒号的键（系统命名空间）→ 400，不得落库', async () => {
    const res = await app().request('/op', {
      method: 'POST',
      headers: { 'idempotency-key': 'signup-gift:42' },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_IDEMPOTENCY_KEY',
    );
  });

  it('超长键（>64）→ 400 而非 DB 22001 → 500', async () => {
    const res = await app().request('/op', {
      method: 'POST',
      headers: { 'idempotency-key': 'K'.repeat(200) },
    });
    expect(res.status).toBe(400);
  });

  it('非法字符（空格/引号/中文）→ 400；缺失 → 服务端生成 UUID', async () => {
    const bad = await app().request('/op', {
      method: 'POST',
      headers: { 'idempotency-key': 'abc def' },
    });
    expect(bad.status).toBe(400);
    const none = await app().request('/op', { method: 'POST' });
    expect(none.status).toBe(200);
    const generated = (await none.json()) as { operationId: string };
    expect(generated.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
