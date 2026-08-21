import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from '../index.js';

/**
 * A 族契约：PG 约束/值错误必须在 errorHandler 边界层翻译为 4xx，
 * 不得裸奔 500。drizzle 会把 pg 错误包在 cause 链，模拟同构错误对象。
 * 这一个翻译点覆盖：唯一名冲突(A4)、FK 不存在(A5)、CHECK 违反(A3)、
 * 超长(A6)、numeric 溢出(A1/A2/C2) 全族的「未预检漏网」。
 */

function pgErr(sqlstate: string, wrapped = true): Error {
  const pg = Object.assign(new Error(`db error ${sqlstate}`), { code: sqlstate });
  if (!wrapped) return pg;
  const drizzle = new Error('Failed query: insert into ...');
  (drizzle as { cause?: unknown }).cause = pg;
  return drizzle;
}

describe('errorHandler：PG SQLSTATE → 4xx 翻译', () => {
  const cases: Array<[string, number, string, string]> = [
    ['23505', 409, 'CONFLICT', '唯一冲突'],
    ['23503', 400, 'INVALID_REFERENCE', 'FK 不存在'],
    ['23514', 400, 'CONSTRAINT_VIOLATION', 'CHECK 违反'],
    ['22001', 400, 'VALUE_TOO_LONG', 'varchar 超长'],
    ['22P02', 400, 'INVALID_VALUE', '类型非法'],
    ['22003', 400, 'VALUE_OUT_OF_RANGE', 'numeric 溢出'],
  ];
  for (const [state, status, code, label] of cases) {
    it(`${label}（${state}）→ ${status} ${code}（cause 链包裹）`, async () => {
      const app = new Hono();
      app.onError(errorHandler());
      app.post('/t', () => {
        throw pgErr(state);
      });
      const res = await app.request('/t', { method: 'POST' });
      expect(res.status).toBe(status);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe(code);
    });
  }
  it('非 PG 错误仍 500（不误吞服务端故障）', async () => {
    const app = new Hono();
    app.onError(errorHandler());
    app.post('/u', () => {
      throw new Error('boom');
    });
    const res = await app.request('/u', { method: 'POST' });
    expect(res.status).toBe(500);
  });
  it('node 内部错误码（如 ERR_XXX）不进入翻译表', async () => {
    const app = new Hono();
    app.onError(errorHandler());
    app.post('/v', () => {
      throw Object.assign(new Error('fs error'), { code: 'ENOENT' });
    });
    const res = await app.request('/v', { method: 'POST' });
    expect(res.status).toBe(500);
  });
});
