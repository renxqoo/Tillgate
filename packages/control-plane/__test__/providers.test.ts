/**
 * 供应商用例（v1 providers.test.ts 等价迁移 + 逻辑删除回收站，HTTP 断言 → facade 断言）：
 * 协议词表校验不触库 / 重名 409 / 404 族 / 软删-回收站-恢复-名称复用 / 审计动作。
 */
import { describe, expect, it } from 'vitest';
import { defined } from './defined';
import { createProvider } from '../src/application/providers/create-provider';
import { updateProvider } from '../src/application/providers/update-provider';
import { deleteProvider } from '../src/application/providers/delete-provider';
import { undeleteProvider } from '../src/application/providers/undelete-provider';
import { listProviders } from '../src/application/providers/list-providers';
import {
  adminCtx,
  createMemoryDb,
  createMemoryProviderStore,
  createMemoryChannelStore,
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
  const channels = createMemoryChannelStore((id) => (id === 1 ? 'p' : 'unknown'));
  const audit = createMemoryAudit();
  const deps = {
    db,
    stores: { provider: providers.store, channel: channels.store },
    capabilities: CAPABILITIES,
    defaultProtocol: 'openai-compatible',
    audit: audit.sink,
  };
  return { deps, providers, channels, audit, cipher: fakeCipher };
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
    expect(defined(providers.rows.get(row.id)).protocol).toBe('openai-compatible');
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

  it('更新/删除不存在 → provider_not_found', async () => {
    const { deps } = setup();
    await expect(
      updateProvider(deps, { ctx: adminCtx(), providerId: 999999999, patch: { name: 'x' } }),
    ).rejects.toMatchObject({ code: 'control_plane.provider_not_found' });
    await expect(
      deleteProvider(deps, { ctx: adminCtx(), providerId: 999999999 }),
    ).rejects.toMatchObject({
      code: 'control_plane.provider_not_found',
    });
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
    expect(defined(result.rows[0]).name).toBe('alpha');
  });
});

/** 回收站用例共享：建供应商返回 id（缺省名 recycle-p） */
async function createOk(
  deps: ReturnType<typeof setup>['deps'],
  name = 'recycle-p',
): Promise<number> {
  const row = await createProvider(deps, {
    ctx: adminCtx(),
    name,
    baseUrl: 'https://recycle.example.com/v1',
  });
  return row.id;
}

describe('逻辑删除（回收站）', () => {
  it('删除守卫：名下有在册渠道 → provider_has_channels；渠道删除后可删', async () => {
    const { deps, channels } = setup();
    const id = await createOk(deps);
    const channel = await channels.store.insertChannel(deps.db, {
      providerId: id,
      name: 'downstream-ch',
      apiKeyEnc: 'enc',
    });
    await expect(deleteProvider(deps, { ctx: adminCtx(), providerId: id })).rejects.toMatchObject({
      code: 'control_plane.provider_has_channels',
    });
    // 渠道进回收站后不算下游占用 → 供应商可删
    await channels.store.softDeleteChannel(deps.db, { channelId: channel.id });
    await expect(deleteProvider(deps, { ctx: adminCtx(), providerId: id })).resolves.toEqual({
      ok: true,
    });
  });
  it('删除：status 压 1 + deleted_at 落刻；列表默认不可见，view=deleted 可见；审计 provider.delete', async () => {
    const { deps, providers, audit } = setup();
    const id = await createOk(deps);
    await deleteProvider(deps, { ctx: adminCtx(), providerId: id });
    const stored = defined(providers.rows.get(id));
    expect(stored.status).toBe(1);
    expect(stored.deletedAt).toBeInstanceOf(Date);
    expect(await deps.stores.provider.findById(deps.db, id)).toBeNull();
    expect(await deps.stores.provider.findByName(deps.db, 'recycle-p')).toBeNull();
    const active = await listProviders(deps, {
      sortBy: 'id',
      order: 'asc',
      limit: 10,
      offset: 0,
    });
    expect(active.total).toBe(0);
    const recycled = await listProviders(deps, {
      sortBy: 'id',
      order: 'asc',
      limit: 10,
      offset: 0,
      view: 'deleted',
    });
    expect(recycled.rows.map((r) => r.id)).toEqual([id]);
    expect(audit.entries.map((e) => e.action)).toContain('provider.delete');
  });

  it('已删除记录对名称「不存在」：可重建同名供应商（唯一约束只锁在册行）', async () => {
    const { deps, providers } = setup();
    const id = await createOk(deps);
    await deleteProvider(deps, { ctx: adminCtx(), providerId: id });
    const recreated = await createOk(deps); // 同名重建
    expect(recreated).not.toBe(id);
    expect(providers.rows.size).toBe(2); // 旧记录保留（逻辑删除），新行在册
  });

  it('已删除记录对读/改/禁用不可见：update/retire 语义 404，不误改回收站行', async () => {
    const { deps, providers } = setup();
    const id = await createOk(deps);
    await deleteProvider(deps, { ctx: adminCtx(), providerId: id });
    await expect(
      updateProvider(deps, { ctx: adminCtx(), providerId: id, patch: { name: 'hacked' } }),
    ).rejects.toMatchObject({ code: 'control_plane.provider_not_found' });
    expect(defined(providers.rows.get(id)).name).toBe('recycle-p');
    expect(await deps.stores.provider.retire(deps.db, { providerId: id })).toBe(false);
  });

  it('恢复：deleted_at 清空 + status 回 1（禁用态不启用）；仅已删除行可恢复；审计 provider.undelete', async () => {
    const { deps, providers, audit } = setup();
    const id = await createOk(deps);
    await deleteProvider(deps, { ctx: adminCtx(), providerId: id });
    // 在册行 restore → 404（防误用恢复做禁用）
    const fresh = await createOk(deps, 'fresh-p');
    await expect(
      undeleteProvider(deps, { ctx: adminCtx(), providerId: fresh }),
    ).rejects.toMatchObject({ code: 'control_plane.provider_not_found' });

    await undeleteProvider(deps, { ctx: adminCtx(), providerId: id });
    const restored = defined(providers.rows.get(id));
    expect(restored.deletedAt).toBeNull();
    expect(restored.status).toBe(1); // 回禁用态：复核后显式启用
    const active = await listProviders(deps, {
      sortBy: 'id',
      order: 'asc',
      limit: 10,
      offset: 0,
    });
    expect(active.rows.map((r) => r.id)).toContain(id);
    expect(audit.entries.map((e) => e.action)).toContain('provider.undelete');
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
    expect(defined(providers.rows.get(row.id)).vendor).toBe('openai');
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
