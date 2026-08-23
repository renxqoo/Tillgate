/**
 * B18 导出增强行为规格（node 环境，BFF 层）：
 *  - exportKeysAction 全量翻页拉取：循环 page 取满 total，而非仅当前页 20 条；
 *  - 上限保护（1000 条防失控）、空页防御（total 异常不死循环）、ApiError 降级 error；
 *  - buildKeysTsv：UTF-8 BOM 首字符（Excel 中文兼容，v1 无 BOM 缺陷修复）与列口径。
 * next/headers、next-intl/server、next/cache 以测试替身注入；fetch 打桩逐页回放。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: vi.fn(),
    delete: vi.fn(),
    has: () => false,
  })),
  headers: vi.fn(async () => new Headers({ 'accept-language': 'zh-CN' })),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import { exportKeysAction } from '../src/server/actions/keys';
import { buildKeysTsv } from '../src/features/keys/export-tsv';
import type { KeyRow } from '@tokenlens/api-client';

/** 最小 KeyRow 工厂（列口径只消费 name/keyPreview/status/createdAt，其余给中性值） */
function keyRow(id: number, over: Partial<KeyRow> = {}): KeyRow {
  return {
    id,
    keyPreview: `sk-prev-${id}`,
    name: `key-${id}`,
    remark: null,
    subscriptionId: null,
    status: 0,
    rpmLimit: null,
    tpmLimit: null,
    dailySpendLimit: null,
    expiresAt: null,
    lastUsedAt: null,
    createdAt: '2026-08-01T00:00:00Z',
    ...over,
  };
}

let calls: Array<{ url: string }>;

/** 按 pageSize=100 切页回放列表信封（后端真实分页语义：每页 rows、全局 total） */
function stubPagedFetch(pages: Array<{ rows: KeyRow[]; total: number }>) {
  const queue = [...pages];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      calls.push({ url: String(url) });
      const next = queue.shift() ?? { rows: [], total: 0 };
      return new Response(JSON.stringify({ rows: next.rows, total: next.total, page: 1, limit: 100 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

beforeEach(() => {
  calls = [];
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.TRUSTED_PROXY_HOPS;
});

describe('exportKeysAction（B18：全量翻页导出）', () => {
  it('total 跨页时循环翻页取满：250 条 → 3 次请求 page=1/2/3，rows 顺序拼接', async () => {
    const p1 = Array.from({ length: 100 }, (_, i) => keyRow(i + 1));
    const p2 = Array.from({ length: 100 }, (_, i) => keyRow(i + 101));
    const p3 = Array.from({ length: 50 }, (_, i) => keyRow(i + 201));
    stubPagedFetch([
      { rows: p1, total: 250 },
      { rows: p2, total: 250 },
      { rows: p3, total: 250 },
    ]);

    const res = await exportKeysAction();

    expect(res.error).toBeUndefined();
    expect(res.rows).toHaveLength(250);
    expect(res.rows!.at(-1)!.name).toBe('key-250');
    // 出站查询逐页递增（经既有 list 动词，limit=100 每页）
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toContain('/v1/keys?page=1&limit=100');
    expect(calls[1]!.url).toContain('page=2');
    expect(calls[2]!.url).toContain('page=3');
  });

  it('上限保护：total=5000 只拉 10 页（1000 条）即停，不发第 11 次请求', async () => {
    const full = Array.from({ length: 100 }, (_, i) => keyRow(i + 1));
    stubPagedFetch(Array.from({ length: 20 }, () => ({ rows: full, total: 5000 })));

    const res = await exportKeysAction();

    expect(res.rows).toHaveLength(1000);
    expect(calls).toHaveLength(10);
  });

  it('空页防御：首页 rows 空且 total 异常时立即终止，不死循环', async () => {
    stubPagedFetch([{ rows: [], total: 999_999 }]);

    const res = await exportKeysAction();

    expect(res.rows).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('单页收口：total ≤ pageSize 只发一次请求（v1 单页场景不再退化）', async () => {
    stubPagedFetch([{ rows: [keyRow(1)], total: 1 }]);

    const res = await exportKeysAction();

    expect(res.rows).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('ApiError 降级：后端 500 返回 error 文案，不向组件抛异常', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: 'internal', message: 'upstream down' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const res = await exportKeysAction();

    expect(res.rows).toBeUndefined();
    expect(res.error).toBe('upstream down');
  });
});

describe('buildKeysTsv（B18：TSV 构造）', () => {
  it('BOM 首字符 + 表头 + 状态映射（0=active，非 0=revoked）', () => {
    const tsv = buildKeysTsv([
      keyRow(1, { name: '生产', status: 0, createdAt: '2026-08-01T00:00:00Z' }),
      keyRow(2, { name: '旧-key', status: 1, createdAt: '2026-08-02T00:00:00Z' }),
    ]);

    expect(tsv.startsWith('\uFEFF')).toBe(true);
    expect(tsv).toBe(
      '\uFEFFname\tkeyPreview\tstatus\tcreatedAt\n' +
        '生产\tsk-prev-1\tactive\t2026-08-01T00:00:00Z\n' +
        '旧-key\tsk-prev-2\trevoked\t2026-08-02T00:00:00Z',
    );
  });

  it('BOM 落到字节层：UTF-8 编码前 3 字节 EF BB BF（Excel 实际消费形态）', () => {
    const bytes = new TextEncoder().encode(buildKeysTsv([keyRow(1)]));
    expect(Array.from(bytes.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('空列表仍导出 BOM + 表头（Excel 打开不空文件报错）', () => {
    expect(buildKeysTsv([])).toBe('\uFEFFname\tkeyPreview\tstatus\tcreatedAt');
  });
});
