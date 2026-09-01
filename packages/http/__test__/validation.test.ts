import { describe, expect, it } from 'vitest';
import { Keala, createBodyParser } from 'keala';
import * as z from 'zod';
import { withRequest } from '../src/framework/keala';
import { intParam } from '../src/validation/int-param';
import { jsonBody, query, jsonBodyOf, queryOf } from '../src/validation/zod-validator';
import { errorHandling } from '../src/errors/handler';

/**
 * 校验组件：
 * 失败统一 400 http.validation_failed，context 平铺 `body.name` / `query.n` 形态。
 */

function app(): ReturnType<typeof withRequest> {
  const a = new Keala();
  a.use(errorHandling(), createBodyParser());
  a.post('/body', jsonBody(z.object({ name: z.string().min(3) })), (c) =>
    c.json(jsonBodyOf<{ name: string }>(c)),
  );
  a.get('/query', query(z.object({ n: z.coerce.number().int() })), (c) =>
    c.json(queryOf<{ n: number }>(c)),
  );
  a.get('/query-tag', query(z.object({ tag: z.string() })), (c) =>
    c.json(queryOf<{ tag: string }>(c)),
  );
  a.get('/item/:id', (c) => c.json({ id: intParam(c, 'id') }));
  return withRequest(a);
}

describe('jsonBody', () => {
  it('合法输入 → 200 且 jsonBodyOf 得解析值', async () => {
    const res = await app().request('/body', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'abc' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'abc' });
  });

  it('字段不符 → 400 http.validation_failed + context 平铺 body.name', async () => {
    const res = await app().request('/body', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'a' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; context: Record<string, string> } };
    expect(body.error.code).toBe('http.validation_failed');
    expect(Object.keys(body.error.context)[0]).toBe('body.name');
    expect(body.error.context['body.name']).toBeTruthy();
  });

  it('根级不符（body 非 object）→ context 键落 source（body）', async () => {
    const res = await app().request('/body', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([1, 2]),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; context: Record<string, string> } };
    expect(body.error.code).toBe('http.validation_failed');
    expect(Object.keys(body.error.context)[0]).toBe('body');
  });
});

describe('query', () => {
  it('非法值 → 400 + context 平铺 query.n', async () => {
    const res = await app().request('/query?n=abc');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; context: Record<string, string> } };
    expect(body.error.code).toBe('http.validation_failed');
    expect(Object.keys(body.error.context)[0]).toBe('query.n');
  });

  it('string[] 折叠取首项（重复 query 参数）', async () => {
    const res = await app().request('/query-tag?tag=a&tag=b');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tag: 'a' });
  });
});

describe('intParam', () => {
  it('正整数透传', async () => {
    const res = await app().request('/item/42');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 42 });
  });

  it.each(['abc', '-1', '0', '1.5'])('%s → 400 http.invalid_path_param', async (raw) => {
    const res = await app().request(`/item/${raw}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; context: { name: string } } };
    expect(body.error.code).toBe('http.invalid_path_param');
    expect(body.error.context).toEqual({ name: 'id' });
  });
});
