/**
 * 统一列表契约（v1 list-unification 的 v2 对位，四资源面）：
 *   - envelope {rows,total,page,pageSize}
 *   - q ilike 搜索（%/_ 按字面匹配——q 含 % 不是通配）
 *   - sort_by 白名单 + order；未知 sort_by → 400
 *   - 分页参数永不 400（page_size 钳制 1..100）
 *   - join 表计数正确（渠道 q 搜供应商名也能 200——v1 list-join-count red 的面）
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { providers as providersTable } from '@ai-gateway/db';
import { buildTestApp, db, newAdmin, newProviderRow, uid } from './helpers.js';

describe('R10: 统一列表契约', () => {
  it('providers：envelope + q 命中 name + 排序白名单（非法 400）+ 字面 % 匹配', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const stamp = uid('l10');
    await request('/v1/providers', { token, body: { name: `${stamp}-alpha`, baseUrl: 'https://a.example.com/v1' } });
    await request('/v1/providers', { token, body: { name: `${stamp}-beta`, baseUrl: 'https://b.example.com/v1' } });

    const all = (await (
      await request(`/v1/providers?q=${stamp}`, { token })
    ).json()) as { rows: Array<{ name: string }>; total: number; page: number; pageSize: number };
    expect(all.total).toBe(2);
    expect(all.page).toBe(1);
    expect(all.pageSize).toBe(20);
    expect(all.rows).toHaveLength(2);

    // q 缩窄
    const narrow = (await (
      await request(`/v1/providers?q=${stamp}-alpha`, { token })
    ).json()) as { total: number };
    expect(narrow.total).toBe(1);

    // 排序白名单 + order
    const asc = (await (
      await request(`/v1/providers?q=${stamp}&sort_by=name&order=asc`, { token })
    ).json()) as { rows: Array<{ name: string }> };
    expect(asc.rows[0]!.name).toBe(`${stamp}-alpha`);
    const desc = (await (
      await request(`/v1/providers?q=${stamp}&sort_by=name&order=desc`, { token })
    ).json()) as { rows: Array<{ name: string }> };
    expect(desc.rows[0]!.name).toBe(`${stamp}-beta`);

    // 未知 sort_by → 400（不静默回退）
    const badSort = await request(`/v1/providers?q=${stamp}&sort_by=hacker`, { token });
    expect(badSort.status).toBe(400);

    // q 里的 % 是字面字符（不是通配）——stamp-alpha 不被 stamp%alpha 命中
    const literal = (await (
      await request(`/v1/providers?q=${stamp}%25alpha`, { token })
    ).json()) as { total: number };
    expect(literal.total).toBe(0);
  });

  it('channels：q 搜供应商名（join 列）也 200 且计数正确——不再 42P01 500', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    // 具名供应商 + 其下渠道（q 命中 join 表 providers.name）
    const providerId = await newProviderRow();
    const providerName = uid('l10-prov');
    await db.update(providersTable).set({ name: providerName }).where(eq(providersTable.id, providerId));
    const chanName = uid('l10-ch');
    await request('/v1/channels', { token, body: { providerId, name: chanName, apiKey: 'sk-l10' } });

    const byProvider = (await (
      await request(`/v1/channels?q=${providerName}`, { token })
    ).json()) as { total: number };
    expect(byProvider.total).toBe(1);
    const byChannel = (await (
      await request(`/v1/channels?q=${chanName}`, { token })
    ).json()) as { total: number };
    expect(byChannel.total).toBe(1);
  });

  it('models：envelope + channelIds 回显共存；未知 sort_by → 400', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const externalName = uid('l10-model');
    await request('/v1/models', {
      token,
      body: { externalName, realModel: uid('real'), inputPrice: '1', outputPrice: '1', cacheInputPrice: '1' },
    });
    const list = (await (
      await request(`/v1/models?q=${externalName}`, { token })
    ).json()) as { rows: Array<{ channelIds: number[] }>; total: number };
    expect(list.total).toBe(1);
    expect(list.rows[0]!.channelIds).toEqual([]);
    const badSort = await request(`/v1/models?q=${externalName}&sort_by=hacker`, { token });
    expect(badSort.status).toBe(400);
  });

  it('rate-cards：envelope + 3 位小数系数回显；分页参数永不 400（钳制）', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const name = uid('l10-card');
    await request('/v1/rate-cards', { token, body: { name, coefficient: '1.5' } });

    const list = (await (
      await request(`/v1/rate-cards?q=${name}&page_size=99999&page=0`, { token })
    ).json()) as { rows: Array<{ coefficient: string }>; total: number; page: number; pageSize: number };
    expect(list.total).toBe(1);
    expect(list.rows[0]!.coefficient).toBe('1.500');
    expect(list.pageSize).toBe(100); // 钳制而非 400
    expect(list.page).toBe(1);
  });
});
