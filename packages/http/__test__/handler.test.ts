import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { InfrastructureError, defineErrorCatalog } from '@tokenlens/errors';
import { errorHandler } from '../src/errors/handler';
import { HttpErrors } from '../src/errors/catalog';

/**
 * errorHandler 边界翻译（v1 errors.test + bad-json.test + pg-error-translation.test
 * 的迁移形态；PG 探测改为注入——ADR-0002）。
 * 原则：可预期的客户端错误必须在边界层翻译成 4xx，不得伪装 500。
 */

function app(deps: Parameters<typeof errorHandler>[0] = {}): Hono {
  const a = new Hono();
  a.onError(errorHandler(deps));
  a.get('/boom', () => {
    throw HttpErrors.business('not_found', { resource: 'org' });
  });
  a.post('/echo', async (c) => c.json(await c.req.json()));
  return a;
}

describe('errorHandler：TokenlensError → 对应状态码 + 统一信封', () => {
  it('business → category 默认 status + context 出站', async () => {
    const res = await app().request('/boom');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: 'http.not_found', message: 'Path not found', context: { resource: 'org' } },
    });
  });

  it('face 目录 + override：出站按 face 投影', async () => {
    const Face = defineErrorCatalog('handler_test', {
      session_invalid: { category: 'forbidden', message: 'Session invalid', zh: '会话无效' },
    });
    const a = new Hono();
    a.onError(
      errorHandler({
        catalog: Face,
        overrides: { 'handler_test.session_invalid': { status: 401 } },
      }),
    );
    a.get('/x', () => {
      throw Face.business('session_invalid');
    });
    const res = await a.request('/x');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'handler_test.session_invalid',
    );
  });

  it('Accept-Language: zh → 目录中文文案；无头 → 英文', async () => {
    const zh = await app().request('/boom', { headers: { 'accept-language': 'zh-CN' } });
    expect(((await zh.json()) as { error: { message: string } }).error.message).toBe('路径不存在');
    const en = await app().request('/boom');
    expect(((await en.json()) as { error: { message: string } }).error.message).toBe(
      'Path not found',
    );
  });

  it('retryAfterMs → Retry-After 响应头（秒，向上取整）', async () => {
    const a = new Hono();
    a.onError(errorHandler());
    a.get('/limited', () => {
      throw HttpErrors.business('not_found', undefined, { retryAfterMs: 1_500 });
    });
    const res = await a.request('/limited');
    expect(res.headers.get('retry-after')).toBe('2');
  });
});

describe('errorHandler：坏 JSON → 400 http.invalid_json（W2 契约）', () => {
  it('非法 JSON 体（手写 c.req.json() 路径的 SyntaxError）→ 400', async () => {
    const res = await app().request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad json',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'http.invalid_json',
    );
  });
});

describe('errorHandler：Hono HTTPException 4xx 保留状态码（不兜 500）', () => {
  it('通用 4xx → 保留状态 + http.invalid_request 信封', async () => {
    const a = new Hono();
    a.onError(errorHandler());
    a.get('/x', () => {
      throw new HTTPException(422, { message: 'unprocessable' });
    });
    const res = await a.request('/x');
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'http.invalid_request',
    );
  });

  it('413 → http.payload_too_large（出站 status 修正链）', async () => {
    const a = new Hono();
    a.onError(errorHandler());
    a.get('/x', () => {
      throw new HTTPException(413);
    });
    const res = await a.request('/x');
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'http.payload_too_large',
    );
  });

  it('HTTPException(400, Malformed JSON) → 走 invalid_json 分支', async () => {
    const a = new Hono();
    a.onError(errorHandler());
    a.get('/x', () => {
      throw new HTTPException(400, { message: 'Malformed JSON in request body' });
    });
    const res = await a.request('/x');
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'http.invalid_json',
    );
  });
});

/**
 * cause 链 SQLSTATE 探测（模拟 @tokenlens/db 的 pgSqlState 契约：(err) => 5 位码 | null；
 * 与真实实现一致沿全 cause 链探测——深链包裹的 PG 错误同样命中，不做层数截断）
 */
function fakeSqlState(err: unknown): string | null {
  let cur: unknown = err;
  while (cur != null && typeof cur === 'object') {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

function pgErr(sqlstate: string): Error {
  const pg = Object.assign(new Error(`db error ${sqlstate}`), { code: sqlstate });
  const drizzle = new Error('Failed query: insert into ...');
  (drizzle as { cause?: unknown }).cause = pg;
  return drizzle;
}

describe('errorHandler：PG SQLSTATE → 4xx 翻译（探测注入）', () => {
  const cases: Array<[string, number, string, string]> = [
    ['23505', 409, 'http.pg_unique_violation', '唯一冲突'],
    ['23503', 400, 'http.pg_fk_violation', 'FK 不存在'],
    ['23514', 400, 'http.pg_check_violation', 'CHECK 违反'],
    ['22001', 400, 'http.pg_value_too_long', 'varchar 超长'],
    ['22P02', 400, 'http.pg_invalid_text', '类型非法'],
    ['22003', 400, 'http.pg_numeric_out_of_range', 'numeric 溢出'],
  ];
  for (const [state, status, code, label] of cases) {
    it(`${label}（${state}）→ ${status} ${code}（cause 链包裹 + context 携带原 state）`, async () => {
      const a = new Hono();
      a.onError(errorHandler({ sqlState: fakeSqlState }));
      a.post('/t', () => {
        throw pgErr(state);
      });
      const res = await a.request('/t', { method: 'POST' });
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({
        error: { code, message: HttpErrors.get(code)?.message, context: { sqlstate: state } },
      });
    });
  }

  it('B1 回归：探测改为装配注入——未注入时无 PG 翻译（v1 越界依赖 core 的结构修复）', async () => {
    const a = new Hono();
    a.onError(errorHandler());
    a.post('/t', () => {
      throw pgErr('23505');
    });
    expect((await a.request('/t', { method: 'POST' })).status).toBe(500);
  });

  it('非翻译族错误码（ENOENT）与未知 SQLSTATE → 仍 500（不误吞服务端故障）', async () => {
    const a = new Hono();
    a.onError(errorHandler({ sqlState: fakeSqlState }));
    a.post('/v', () => {
      throw Object.assign(new Error('fs error'), { code: 'ENOENT' });
    });
    a.post('/w', () => {
      throw pgErr('42P01');
    });
    expect((await a.request('/v', { method: 'POST' })).status).toBe(500);
    expect((await a.request('/w', { method: 'POST' })).status).toBe(500);
  });

  it('深链 cause（>5 层包裹）的 PG 错误同样命中——模拟与 pgSqlState 全链契约对齐', async () => {
    // 六层包装：PG 错误垫底，模拟 db 深链场景（真实注入物不做层数截断）
    let cur: Error = Object.assign(new Error('db error 23505'), { code: '23505' });
    for (let i = 0; i < 6; i++) {
      const wrap = new Error(`layer ${i}`);
      (wrap as { cause?: unknown }).cause = cur;
      cur = wrap;
    }
    const a = new Hono();
    a.onError(errorHandler({ sqlState: fakeSqlState }));
    a.post('/deep', () => {
      throw cur;
    });
    const res = await a.request('/deep', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'http.pg_unique_violation',
    );
  });
});

describe('errorHandler：分派顺序——已分类错误优先，PG 翻译只兜未分类', () => {
  it('P1 回归①：BusinessError 带 23505 PG cause → 业务码保留（不被 http.pg_unique_violation 覆盖）', async () => {
    const a = new Hono();
    a.onError(errorHandler({ sqlState: fakeSqlState }));
    a.post('/biz', () => {
      // 业务层已把唯一冲突翻译成业务语义（cause 保留 PG 事实链）
      throw HttpErrors.business('not_found', { resource: 'org' }, { cause: pgErr('23505') });
    });
    const res = await a.request('/biz', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: 'http.not_found', message: 'Path not found', context: { resource: 'org' } },
    });
  });

  it('P1 回归②：未分类 Error 带 PG cause → http.pg_unique_violation（兜底路径仍生效）', async () => {
    const a = new Hono();
    a.onError(errorHandler({ sqlState: fakeSqlState }));
    a.post('/raw', () => {
      throw pgErr('23505');
    });
    const res = await a.request('/raw', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'http.pg_unique_violation',
    );
  });

  it('P1 回归③：InfrastructureError 带 PG cause → 503 身份码保留（环境故障不伪装 4xx）', async () => {
    const a = new Hono();
    a.onError(errorHandler({ sqlState: fakeSqlState }));
    a.post('/infra', () => {
      throw new InfrastructureError('connection terminated', 'db.unavailable', undefined, {
        cause: pgErr('23505'),
      });
    });
    const res = await a.request('/infra', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: { code: 'db.unavailable', message: 'Service temporarily unavailable' },
    });
  });
});

describe('errorHandler：未知错误 → 500 errors.unhandled + 记日志', () => {
  it('细节不外泄；logger.error 恰好一次', async () => {
    const logged: Array<Record<string, unknown>> = [];
    const a = new Hono();
    a.onError(errorHandler({ logger: { error: (obj) => logged.push(obj) } }));
    a.get('/kaboom', () => {
      throw new Error('secret internals');
    });
    const res = await a.request('/kaboom');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: 'errors.unhandled', message: 'Internal server error' },
    });
    expect(logged.length).toBe(1);
    expect(logged[0]?.err).toBe('secret internals');
  });

  it('4xx business 不记日志（业务拒绝不是故障）', async () => {
    const logged: Array<Record<string, unknown>> = [];
    const res = await app({ logger: { error: (obj) => logged.push(obj) } }).request('/boom');
    expect(res.status).toBe(404);
    expect(logged.length).toBe(0);
  });
});
