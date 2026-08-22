/**
 * 供应商用例（v1 providers.test.ts 等价迁移，HTTP 断言 → facade 断言）：
 * 协议词表校验不触库 / 重名 409 / 404 族 / 软退役 / 审计动作。
 */
import { describe, expect, it } from 'vitest';
import { createProvider } from '../src/application/providers/create-provider';
import { updateProvider } from '../src/application/providers/update-provider';
import { retireProvider } from '../src/application/providers/retire-provider';
import { listProviders } from '../src/application/providers/list-providers';
import {
  adminCtx,
  createMemoryDb,
  createMemoryProviderStore,
  createMemoryAudit,
  fakeCipher,
} from './memory';
import type { ProviderCapabilities } from '../src/domain/provider/provider';

const CAPABILITIES: ProviderCapabilities = {
  protocols: ['openai-compatible'],
  vendorProfiles: ['openai'],
};

function setup() {
  const db = createMemoryDb();
  const providers = createMemoryProviderStore();
  const audit = createMemoryAudit();
  const deps = {
    db,
    stores: { provider: providers.store },
    capabilities: CAPABILITIES,
    defaultProtocol: 'openai-compatible',
    audit: audit.sink,
  };
  return { deps, providers, audit, cipher: fakeCipher };
}

describe('供应商协议词表（单一真相 = 注入词表）', () => {
  it.each(['openai', 'openai_compatible', 'made-up'])(
    '非法协议 %s → invalid_protocol 且不触库',
    async (protocol) => {
      const { deps, providers } = setup();
      await expect(
        createProvider(deps, {
          ctx: adminCtx(),
          name: 'p',
          protocol,
          baseUrl: 'https://api.example.com/v1',
        }),
      ).rejects.toMatchObject({ code: 'control_plane.invalid_protocol' });
      expect(providers.rows.size).toBe(0);
    },
  );

  it('PATCH 非法协议 → invalid_protocol（校验在词表层先行——id 不存在也不 404）', async () => {
    const { deps } = setup();
    await expect(
      updateProvider(deps, {
        ctx: adminCtx(),
        providerId: 999999999,
        patch: { protocol: 'openai' },
      }),
    ).rejects.toMatchObject({ code: 'control_plane.invalid_protocol' });
  });

  it('合法协议 openai-compatible → 原样入库（无运行时翻译）+ 审计 provider.create', async () => {
    const { deps, providers, audit } = setup();
    const row = await createProvider(deps, {
      ctx: adminCtx(),
      name: 'p1',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
    });
    expect(row.protocol).toBe('openai-compatible');
    expect(providers.rows.get(row.id)!.protocol).toBe('openai-compatible');
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ action: 'provider.create', targetId: row.id });
  });
});

describe('供应商 CRUD 边界', () => {
  it('非法 baseUrl / 超长 name → invalid_provider_input 不触库', async () => {
    const { deps } = setup();
    await expect(
      createProvider(deps, { ctx: adminCtx(), name: 'p', baseUrl: 'not-a-url' }),
    ).rejects.toMatchObject({ code: 'control_plane.invalid_provider_input' });
    await expect(
      createProvider(deps, {
        ctx: adminCtx(),
        name: 'x'.repeat(33),
        baseUrl: 'https://a.example.com/v1',
      }),
    ).rejects.toMatchObject({ code: 'control_plane.invalid_provider_input' });
  });

  it('重名 → provider_exists（唯一索引翻译）', async () => {
    const { deps } = setup();
    await createProvider(deps, {
      ctx: adminCtx(),
      name: 'dup',
      baseUrl: 'https://a.example.com/v1',
    });
    await expect(
      createProvider(deps, { ctx: adminCtx(), name: 'dup', baseUrl: 'https://b.example.com/v1' }),
    ).rejects.toMatchObject({ code: 'control_plane.provider_exists' });
  });

  it('更新/退役不存在 → provider_not_found；退役 = status 1 软删', async () => {
    const { deps, providers } = setup();
    await expect(
      updateProvider(deps, { ctx: adminCtx(), providerId: 999999999, patch: { name: 'x' } }),
    ).rejects.toMatchObject({ code: 'control_plane.provider_not_found' });
    await expect(
      retireProvider(deps, { ctx: adminCtx(), providerId: 999999999 }),
    ).rejects.toMatchObject({
      code: 'control_plane.provider_not_found',
    });
    const created = await createProvider(deps, {
      ctx: adminCtx(),
      name: 'ret',
      baseUrl: 'https://c.example.com/v1',
    });
    await retireProvider(deps, { ctx: adminCtx(), providerId: created.id });
    expect(providers.rows.get(created.id)!.status).toBe(1);
  });

  it('列表：q 命中 name/baseUrl；分页与总数', async () => {
    const { deps } = setup();
    await createProvider(deps, {
      ctx: adminCtx(),
      name: 'alpha',
      baseUrl: 'https://a.example.com/v1',
    });
    await createProvider(deps, {
      ctx: adminCtx(),
      name: 'beta',
      baseUrl: 'https://b.example.com/v1',
    });
    const result = await listProviders(deps, {
      q: 'alpha',
      sortBy: 'createdAt',
      order: 'desc',
      limit: 10,
      offset: 0,
    });
    expect(result.total).toBe(1);
    expect(result.rows[0]!.name).toBe('alpha');
  });
});

describe('厂商档案 vendor（词表单一真相 = 注入词表）', () => {
  it('合法档案入库回显；未知档案 → invalid_vendor 不触库', async () => {
    const { deps, providers } = setup();
    await expect(
      createProvider(deps, {
        ctx: adminCtx(),
        name: 'p',
        vendor: 'nonexistent-vendor',
        baseUrl: 'https://api.example.com/v1',
      }),
    ).rejects.toMatchObject({ code: 'control_plane.invalid_vendor' });
    const row = await createProvider(deps, {
      ctx: adminCtx(),
      name: 'p2',
      vendor: 'openai',
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(row.vendor).toBe('openai');
    expect(providers.rows.get(row.id)!.vendor).toBe('openai');
  });

  it('PATCH vendor=null 清除档案（回退纯透传）', async () => {
    const { deps } = setup();
    const created = await createProvider(deps, {
      ctx: adminCtx(),
      name: 'p3',
      vendor: 'openai',
      baseUrl: 'https://api.openai.com/v1',
    });
    const updated = await updateProvider(deps, {
      ctx: adminCtx(),
      providerId: created.id,
      patch: { vendor: null },
    });
    expect(updated.vendor).toBeNull();
  });
});
