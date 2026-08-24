/**
 * server 读取面行为规格：
 *  - B2 回归：套餐目录查询形态必须是 ?page=1&limit=100（v1 的 page_size 被
 *    strict 契约忽略导致套餐截断）且不携带 sort_by（G4）；
 *  - 企业/个人过滤（allowSeats）；
 *  - highlight（shiki 双主题产出 CSS 变量 html）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { defined } from './defined';

let calls: Array<{ url: string; init: RequestInit }>;
let responses: Array<{ status: number; body: unknown }>;

vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status });
  }),
);

import { ApiError, type ClientApiClient } from '@tillgate/api-client';

import { fetchPlans } from '../src/server/plans';
import { highlight } from '../src/features/public/highlight';

beforeEach(() => {
  calls = [];
  responses = [];
});

describe('fetchPlans（B2 回归）', () => {
  it('查询形态恰为 page=1&limit=100（不传 page_size / sort_by）', async () => {
    const fake: ClientApiClient = {
      get: (async (path: string) => {
        calls.push({ url: `http://stub${path}`, init: {} });
        return { rows: [] };
      }) as never,
    } as never;
    await fetchPlans(fake, false, 'loadFailed');
    expect(defined(calls[0], 'calls[0]').url).toBe('http://stub/v1/plans?page=1&limit=100');
    expect(defined(calls[0], 'calls[0]').url).not.toContain('page_size');
    expect(defined(calls[0], 'calls[0]').url).not.toContain('sort_by');
  });

  it('allowSeats 过滤：企业看席位套餐、个人看非席位套餐', async () => {
    const rows = [
      { id: 1, allowSeats: false },
      { id: 2, allowSeats: true },
    ];
    const fake = {
      get: async () => ({ rows }),
    } as unknown as ClientApiClient;
    const personal = await fetchPlans(fake, false, 'e');
    expect(personal.plans.map((p) => p.id)).toEqual([1]);
    const enterprise = await fetchPlans(fake, true, 'e');
    expect(enterprise.plans.map((p) => p.id)).toEqual([2]);
  });

  it('后端错误：ApiError message 上浮，其余回落 fallback 文案', async () => {
    const err = new ApiError(503, 'client.plans_unavailable', '目录不可用');
    const failing = {
      get: async () => {
        throw err;
      },
    } as unknown as ClientApiClient;
    const res = await fetchPlans(failing, false, 'fallback');
    expect(res).toEqual({ plans: [], error: '目录不可用' });
    const plain = {
      get: async () => {
        throw new Error('network down');
      },
    } as unknown as ClientApiClient;
    expect((await fetchPlans(plain, false, 'fallback')).error).toBe('fallback');
  });
});

describe('highlight（shiki 双主题）', () => {
  it('产出含 CSS 变量的 <pre> html；标签归一 bash/python/javascript', async () => {
    const bash = await highlight('curl http://x/v1/models', 'curl');
    expect(bash).toContain('<pre');
    expect(bash).toContain('--shiki-light');
    expect(bash).toContain('--shiki-dark');
    const py = await highlight('print(1)', 'Python 3');
    expect(py).toContain('<pre');
    const js = await highlight('await x()', 'JavaScript (openai SDK)');
    expect(js).toContain('<pre');
  }, 30_000);
});
