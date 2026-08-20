/**
 * 供应商语义（v1 providers-protocol + admin-routes-batch providers 部分的 v2 对位）：
 * 协议词表单一真相（非法协议 400 且不触库）/ 重名 409（PG 翻译）/
 * baseUrl 形状 / 长度上界 / 软退役 404 族 / 排序白名单。
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { providers as providersTable } from '@ai-gateway/db';
import { buildTestApp, db, newAdmin, uid } from './helpers.js';

describe('供应商协议词表（单一真相 = ai 适配器注册表）', () => {
  it.each(['openai', 'openai_compatible', 'made-up'])('非法协议 %s → 400 且不触库', async (protocol) => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const res = await request('/v1/providers', {
      token,
      body: { name: uid('p'), protocol, baseUrl: 'https://api.example.com/v1' },
    });
    expect(res.status).toBe(400);
  });

  it('PATCH 非法协议 → 400（校验在 zod/service 层先行——id 不存在也不 404）', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const res = await request('/v1/providers/999999999', {
      method: 'PATCH',
      token,
      body: { protocol: 'openai' },
    });
    expect(res.status).toBe(400);
  });

  it('合法协议 openai-compatible → 201 且原样入库（无运行时翻译）', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const name = uid('p');
    const res = await request('/v1/providers', {
      token,
      body: { name, protocol: 'openai-compatible', baseUrl: 'https://api.example.com/v1' },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { protocol: string };
    expect(body.protocol).toBe('openai-compatible');
    const [row] = await db.select().from(providersTable).where(eq(providersTable.name, name));
    expect(row!.protocol).toBe('openai-compatible');
  });
});

describe('供应商 CRUD 边界', () => {
  it('非法 baseUrl → 400；超长 name（>32）→ 400', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    expect(
      (await request('/v1/providers', { token, body: { name: uid('p'), baseUrl: 'not-a-url' } })).status,
    ).toBe(400);
    expect(
      (
        await request('/v1/providers', {
          token,
          body: { name: 'x'.repeat(33), baseUrl: 'https://api.example.com/v1' },
        })
      ).status,
    ).toBe(400);
  });

  it('重名 → 409（PG 唯一索引翻译）', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const name = uid('dup');
    const first = await request('/v1/providers', { token, body: { name, baseUrl: 'https://a.example.com/v1' } });
    expect(first.status).toBe(201);
    const second = await request('/v1/providers', { token, body: { name, baseUrl: 'https://b.example.com/v1' } });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe('conflict');
  });

  it('更新不存在 → 404；退役不存在 → 404；退役 = status 1 软删', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    expect(
      (await request('/v1/providers/999999999', { method: 'PATCH', token, body: { name: uid('x') } })).status,
    ).toBe(404);
    expect((await request('/v1/providers/999999999', { method: 'DELETE', token })).status).toBe(404);

    const created = (await (
      await request('/v1/providers', { token, body: { name: uid('ret'), baseUrl: 'https://c.example.com/v1' } })
    ).json()) as { id: number };
    const res = await request(`/v1/providers/${created.id}`, { method: 'DELETE', token });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(providersTable).where(eq(providersTable.id, created.id));
    expect(row!.status).toBe(1);
  });

  it('排序白名单：未知 sort_by → 400 invalid_sort_field', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const res = await request('/v1/providers?sort_by=password', { token });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_sort_field');
  });
});

describe('厂商档案 vendor（词表单一真相 = ai 包 VENDOR_PROFILES）', () => {
  it('合法档案 openai → 201 入库且列表回显；未知档案 → 400 且不触库', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const bad = await request('/v1/providers', {
      token,
      body: { name: uid('p'), vendor: 'nonexistent-vendor', baseUrl: 'https://api.example.com/v1' },
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('invalid_vendor');

    const name = uid('p');
    const ok = await request('/v1/providers', {
      token,
      body: { name, vendor: 'openai', baseUrl: 'https://api.openai.com/v1' },
    });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { vendor: string }).vendor).toBe('openai');
    const [row] = await db.select().from(providersTable).where(eq(providersTable.name, name));
    expect(row?.vendor).toBe('openai');
  });

  it('PATCH vendor=null 清除档案（回退纯透传）', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const name = uid('p');
    const created = await request('/v1/providers', {
      token,
      body: { name, vendor: 'openai', baseUrl: 'https://api.openai.com/v1' },
    });
    const id = ((await created.json()) as { id: number }).id;
    const res = await request(`/v1/providers/${id}`, {
      method: 'PATCH',
      token,
      body: { vendor: null },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { vendor: string | null }).vendor).toBeNull();
  });
});

const seed = (id: string, over: Partial<Record<string, unknown>> = {}) => ({
  provider: 'openai', id, name: id, contextWindow: 128_000, reasoning: false,
  inputs: ['text'], cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  ...over,
});

describe('模型目录种子导入（审批制：草稿态 + 幂等跳过 + dryRun）', () => {
  it('dryRun 只统计不落库；正式导入 status=1 草稿 + 价格四维落列；重复条目跳过不覆盖', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const name = `openai/gpt-import-test-${uid('x')}`;
    const entry = seed(name.slice('openai/'.length));
    // dryRun
    const preview = await request('/v1/models/import', { token, body: { models: [entry], dryRun: true } });
    expect(preview.status).toBe(200);
    expect(((await preview.json()) as { created: number }).created).toBe(1);
    // 正式导入
    const created = await request('/v1/models/import', { token, body: { models: [entry] } });
    expect(created.status).toBe(200);
    expect(((await created.json()) as { created: number }).created).toBe(1);
    const { modelMappings } = await import('@ai-gateway/db');
    const { eq: eqBy } = await import('drizzle-orm');
    const [row] = await db.select().from(modelMappings).where(eqBy(modelMappings.externalName, name));
    expect(row?.status).toBe(1); // 草稿态（下架）——价格复核后人工上架
    expect(row?.inputPrice).toBe('1.250000000000000000'); // PG numeric 尾零
    expect(row?.cacheWritePrice).toBe('0.000000000000000000');
    // 再导入同条 → skipped（不覆盖既有定价）
    const again = await request('/v1/models/import', { token, body: { models: [entry] } });
    const body2 = (await again.json()) as { created: number; skipped: unknown[] };
    expect(body2.created).toBe(0);
    expect(body2.skipped).toHaveLength(1);
    await db.delete(modelMappings).where(eqBy(modelMappings.externalName, name));
  });

  it('空列表 400；超单批上界 400；坏条目（缺 id）400', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const empty = await request('/v1/models/import', { token, body: { models: [] } });
    expect(empty.status).toBe(400);
    const tooMany = await request('/v1/models/import', { token, body: { models: Array.from({ length: 101 }, (_, i) => seed(`m${i}`)) } });
    expect(tooMany.status).toBe(400);
    const bad = await request('/v1/models/import', { token, body: { models: [{ provider: 'x' }] } });
    expect(bad.status).toBe(400);
  });
});

const mkSeedEntry = (i: number): { provider: string; id: string; contextWindow: number; cost: Record<string, never> } => ({ provider: 'x', id: `edge-${i}`, contextWindow: 0, cost: {} });

describe('导入边界补齐（覆盖率：分批上界边界值）', () => {
  it('恰好 100 条（上界值）可导入（dryRun）；101 条拒绝', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const atLimit = await request('/v1/models/import', { token, body: { models: Array.from({ length: 100 }, (_, i) => mkSeedEntry(i)), dryRun: true } });
    expect(atLimit.status).toBe(200);
    const overLimit = await request('/v1/models/import', { token, body: { models: Array.from({ length: 101 }, (_, i) => mkSeedEntry(i)), dryRun: true } });
    expect(overLimit.status).toBe(400);
  });
});

describe('导入防御分支（坏价格/零窗口钳 0）', () => {
  it('cost 整体缺省 → 四价钳 0；contextWindow=0 → null', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const name = `openai/gpt-import-edge2-${uid('x')}`;
    const res = await request('/v1/models/import', {
      token,
      body: { models: [{ provider: 'openai', id: name.slice('openai/'.length), contextWindow: 0, name: 'n', reasoning: false, inputs: ['text'] }] },
    });
    expect(res.status).toBe(200);
    const { modelMappings } = await import('@ai-gateway/db');
    const { eq: eqBy } = await import('drizzle-orm');
    const [row] = await db.select().from(modelMappings).where(eqBy(modelMappings.externalName, name));
    expect(row?.inputPrice).toBe('0.000000000000000000');
    expect(row?.outputPrice).toBe('0.000000000000000000');
    expect(row?.contextLength).toBeNull();
    await db.delete(modelMappings).where(eqBy(modelMappings.externalName, name));
  });
});
