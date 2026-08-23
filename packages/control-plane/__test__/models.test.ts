/**
 * 模型映射用例（v1 models.test.ts 等价迁移 + 逻辑删除回收站）：
 * 免费一致性（直判+合并判）/ 数值域不触库 / 重名精确回执 / 绑定全量替换 /
 * channelIds 回显 / 探针请求形状与密钥解密 / 软删-回收站-恢复-外部名复用。
 */
import { describe, expect, it } from 'vitest';
import { createModel } from '../src/application/models/create-model';
import { updateModel } from '../src/application/models/update-model';
import { deleteModel } from '../src/application/models/delete-model';
import { undeleteModel } from '../src/application/models/undelete-model';
import { listModels } from '../src/application/models/list-models';
import { bindModelChannels } from '../src/application/models/bind-model-channels';
import { probeModel } from '../src/application/models/probe-model';
import {
  adminCtx,
  createMemoryChannelStore,
  createMemoryModelStore,
  createMemoryAudit,
  createMemoryDb,
  createStubProbe,
  fakeCipher,
} from './memory';

function setup() {
  const db = createMemoryDb();
  const models = createMemoryModelStore();
  const channels = createMemoryChannelStore(() => 'prov');
  const audit = createMemoryAudit();
  const probe = createStubProbe();
  const deps = { db, stores: { model: models.store }, audit: audit.sink };
  return { deps, models, channels, audit, probe };
}

const baseInput = {
  externalName: 'alias',
  realModel: 'real-model',
  prices: { inputPrice: '1', outputPrice: '2', cacheInputPrice: '0.5' },
};

async function createOk(
  deps: ReturnType<typeof setup>['deps'],
  overrides: Record<string, unknown> = {},
) {
  return createModel(deps, { ctx: adminCtx(), ...baseInput, ...overrides } as never);
}

describe('模型 CRUD 与 R6 免费价格一致性', () => {
  it('创建 isFree=true + 非零价 → free_price_conflict', async () => {
    const { deps, models } = setup();
    await expect(createOk(deps, { isFree: true })).rejects.toMatchObject({
      code: 'control_plane.free_price_conflict',
    });
    expect(models.rows.size).toBe(0);
  });

  it('创建全零价 + isFree=true → 成功', async () => {
    const { deps } = setup();
    const row = await createOk(deps, {
      isFree: true,
      prices: { inputPrice: '0', outputPrice: '0', cacheInputPrice: '0' },
    });
    expect(row.isFree).toBe(true);
  });

  it('部分补丁不能造矛盾态：isFree=true + 只改 outputPrice>0 → free_price_conflict（合并判）且库中价格未动', async () => {
    const { deps, models } = setup();
    const row = await createOk(deps, {
      isFree: true,
      prices: { inputPrice: '0', outputPrice: '0', cacheInputPrice: '0' },
    });
    await expect(
      updateModel(deps, {
        ctx: adminCtx(),
        mappingId: row.id,
        patch: { prices: { outputPrice: '3' } },
      }),
    ).rejects.toMatchObject({ code: 'control_plane.free_price_conflict' });
    expect(models.rows.get(row.id)!.outputPrice).toBe('0');
  });

  it('更新/删除不存在 → model_not_found', async () => {
    const { deps } = setup();
    await expect(
      updateModel(deps, { ctx: adminCtx(), mappingId: 999999999, patch: { realModel: 'x' } }),
    ).rejects.toMatchObject({ code: 'control_plane.model_not_found' });
    await expect(
      deleteModel(deps, { ctx: adminCtx(), mappingId: 999999999 }),
    ).rejects.toMatchObject({
      code: 'control_plane.model_not_found',
    });
  });
});

describe('逻辑删除（回收站）', () => {
  it('删除：status 压 1 + deleted_at 落刻；列表默认不可见，view=deleted 可见；审计 model.delete', async () => {
    const { deps, models, audit } = setup();
    const row = await createOk(deps);
    await deleteModel(deps, { ctx: adminCtx(), mappingId: row.id });
    const stored = models.rows.get(row.id)!;
    expect(stored.status).toBe(1);
    expect(stored.deletedAt).toBeInstanceOf(Date);
    expect(await deps.stores.model.findById(deps.db, row.id)).toBeNull();
    expect(await deps.stores.model.findByExternalName(deps.db, row.externalName)).toBeNull();
    const active = await listModels(deps, { sortBy: 'id', order: 'asc', limit: 10, offset: 0 });
    expect(active.rows).toHaveLength(0);
    const recycled = await listModels(deps, {
      sortBy: 'id',
      order: 'asc',
      limit: 10,
      offset: 0,
      view: 'deleted',
    });
    expect(recycled.rows.map((r) => r.id)).toEqual([row.id]);
    expect(recycled.rows[0]!.channelIds).toEqual([]); // 绑定回显不炸（绑定本身保留）
    expect(audit.entries.map((e) => e.action)).toContain('model.delete');
  });

  it('已删除记录对外部名「不存在」：可重建同名映射（唯一约束只锁在册行）', async () => {
    const { deps, models } = setup();
    const row = await createOk(deps);
    await deleteModel(deps, { ctx: adminCtx(), mappingId: row.id });
    const recreated = await createOk(deps); // 同 externalName 'alias'
    expect(recreated.id).not.toBe(row.id);
    expect(models.rows.size).toBe(2); // 旧记录保留（逻辑删除），新行在册
  });

  it('已删除记录对读/改/下架不可见：update/retire 语义 404，不误改回收站行', async () => {
    const { deps, models } = setup();
    const row = await createOk(deps, {
      prices: { inputPrice: '5', outputPrice: '5', cacheInputPrice: '0' },
    });
    await deleteModel(deps, { ctx: adminCtx(), mappingId: row.id });
    await expect(
      updateModel(deps, { ctx: adminCtx(), mappingId: row.id, patch: { realModel: 'hacked' } }),
    ).rejects.toMatchObject({ code: 'control_plane.model_not_found' });
    expect(models.rows.get(row.id)!.realModel).toBe('real-model');
    expect(await deps.stores.model.retireMapping(deps.db, { mappingId: row.id })).toBe(false);
  });

  it('恢复：deleted_at 清空 + status 回 1（下架态不复活）；仅已删除行可恢复；审计 model.undelete', async () => {
    const { deps, models, audit } = setup();
    const row = await createOk(deps);
    await deleteModel(deps, { ctx: adminCtx(), mappingId: row.id });
    // 在册行 restore → 404（防误用恢复做下架）
    const fresh = await createOk(deps, { externalName: 'other' });
    await expect(
      undeleteModel(deps, { ctx: adminCtx(), mappingId: fresh.id }),
    ).rejects.toMatchObject({ code: 'control_plane.model_not_found' });

    await undeleteModel(deps, { ctx: adminCtx(), mappingId: row.id });
    const restored = models.rows.get(row.id)!;
    expect(restored.deletedAt).toBeNull();
    expect(restored.status).toBe(1); // 回下架态：复核后显式上架
    const active = await listModels(deps, { sortBy: 'id', order: 'asc', limit: 10, offset: 0 });
    expect(active.rows.map((r) => r.id)).toContain(row.id);
    expect(audit.entries.map((e) => e.action)).toContain('model.undelete');
  });
});

describe('单位计价与变体价格', () => {
  it('图片模型：pricingUnit=image + unitPrice + token 三价 0 → 落库回显', async () => {
    const { deps } = setup();
    const row = await createOk(deps, {
      externalName: 'img',
      realModel: 'qwen-image-3.0',
      prices: { inputPrice: '0', outputPrice: '0', cacheInputPrice: '0', unitPrice: '0.2' },
      pricingUnit: 'image',
    });
    expect(row.pricingUnit).toBe('image');
    expect(row.unitPrice).toBe('0.2');
  });

  it('isFree + unitPrice>0 → free_price_conflict（免费一致性含单价）', async () => {
    const { deps } = setup();
    await expect(
      createOk(deps, {
        isFree: true,
        prices: { inputPrice: '0', outputPrice: '0', cacheInputPrice: '0', unitPrice: '0.1' },
        pricingUnit: 'image',
      }),
    ).rejects.toMatchObject({ code: 'control_plane.free_price_conflict' });
  });

  it('变体差价回显；PATCH billingConfig: null → 清除差价回 {}（不残留 variant）', async () => {
    const { deps, models } = setup();
    const row = await createOk(deps, {
      prices: { inputPrice: '0', outputPrice: '0', cacheInputPrice: '0', unitPrice: '0.3' },
      pricingUnit: 'image',
      billingConfig: {
        strategy: 'variant',
        params: { selector: 'size', prices: { '1024*1024': '0.3' } },
      },
    });
    expect(row.billingConfig).toMatchObject({ strategy: 'variant' });
    await updateModel(deps, { ctx: adminCtx(), mappingId: row.id, patch: { billingConfig: null } });
    expect(models.rows.get(row.id)!.billingConfig).toEqual({});
  });

  it('variant 缺 prices 或缺 selector → invalid_model_input 不触库', async () => {
    const { deps } = setup();
    await expect(
      createOk(deps, {
        billingConfig: { strategy: 'variant', params: { selector: 'size' } },
      }),
    ).rejects.toMatchObject({ code: 'control_plane.invalid_model_input' });
    await expect(
      createOk(deps, {
        billingConfig: { strategy: 'variant', params: { prices: { '1024*1024': '0.2' } } },
      }),
    ).rejects.toMatchObject({ code: 'control_plane.invalid_model_input' });
  });
});

describe('重名创建 → model_exists 精确回执', () => {
  it('重复 externalName → model_exists，context 带已存在 id 与状态', async () => {
    const { deps } = setup();
    const row = await createOk(deps);
    await expect(createOk(deps, { realModel: 'another' })).rejects.toMatchObject({
      code: 'control_plane.model_exists',
      context: expect.objectContaining({ externalName: row.externalName, existingId: row.id }),
    });
  });
});

describe('绑定全量替换 + channelIds 回显', () => {
  it('绑 A → 绑 B = 全量替换（只剩 B）；空数组 = 解绑全部', async () => {
    const { deps, models } = setup();
    const row = await createOk(deps);
    await bindModelChannels(deps, {
      ctx: adminCtx(),
      mappingId: row.id,
      channels: [{ channelId: 11 }],
    });
    expect(models.rows.get(row.id)!.bindings.map((b) => b.channelId)).toEqual([11]);
    await bindModelChannels(deps, {
      ctx: adminCtx(),
      mappingId: row.id,
      channels: [{ channelId: 22 }],
    });
    expect(models.rows.get(row.id)!.bindings.map((b) => b.channelId)).toEqual([22]);
    const listResult = await listModels(deps, {
      q: row.externalName,
      sortBy: 'createdAt',
      order: 'desc',
      limit: 10,
      offset: 0,
    });
    expect(listResult.rows[0]!.channelIds).toEqual([22]);
    // 空数组 = 解绑全部
    await bindModelChannels(deps, { ctx: adminCtx(), mappingId: row.id, channels: [] });
    expect(models.rows.get(row.id)!.bindings).toHaveLength(0);
    const after = await listModels(deps, {
      q: row.externalName,
      sortBy: 'createdAt',
      order: 'desc',
      limit: 10,
      offset: 0,
    });
    expect(after.rows[0]!.channelIds).toEqual([]); // 未绑定 = []（而非 undefined）
  });

  it('绑定不存在的模型 → model_not_found', async () => {
    const { deps } = setup();
    await expect(
      bindModelChannels(deps, {
        ctx: adminCtx(),
        mappingId: 999999999,
        channels: [{ channelId: 1 }],
      }),
    ).rejects.toMatchObject({ code: 'control_plane.model_not_found' });
  });
});

describe('模型探针', () => {
  it('逐渠道最小成本生成：请求形状 = 真实模型名 + 解密密钥；结果含 tokens', async () => {
    const { deps, models, probe } = setup();
    const secretStore = createMemoryChannelStore(() => 'prov');
    void secretStore;
    const row = await createOk(deps, { realModel: 'probe-real' });
    await bindModelChannels(deps, {
      ctx: adminCtx(),
      mappingId: row.id,
      channels: [{ channelId: 5 }],
    });
    const result = await probeModel(
      { db: deps.db, stores: { model: deps.stores.model }, cipher: fakeCipher, probe: probe.probe },
      row.id,
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ channelId: 5, ok: true, tokens: 3 });
    expect(probe.calls[0]).toMatchObject({ kind: 'model', model: 'probe-real' });
    expect(probe.calls[0]!.target.apiKey).toBe('enc-for-5'); // 内存替身 cipher 解密路径
    expect(probe.calls[0]!.requestId).toBe(`model-test-${row.id}-5`);
    void models;
  });

  it('上游失败 → ok:false + 错误码透传；模型不存在 → model_not_found', async () => {
    const { deps, probe } = setup();
    const failing = createStubProbe({
      model: () => ({
        ok: false,
        durationMs: 1,
        error: { code: 'rate_limited', message: 'upstream busy' },
      }),
    });
    const row = await createOk(deps);
    await bindModelChannels(deps, {
      ctx: adminCtx(),
      mappingId: row.id,
      channels: [{ channelId: 9 }],
    });
    const result = await probeModel(
      {
        db: deps.db,
        stores: { model: deps.stores.model },
        cipher: fakeCipher,
        probe: failing.probe,
      },
      row.id,
    );
    expect(result.results[0]!.ok).toBe(false);
    expect(result.results[0]!.error).toMatchObject({ code: 'rate_limited' });
    await expect(
      probeModel(
        {
          db: deps.db,
          stores: { model: deps.stores.model },
          cipher: fakeCipher,
          probe: probe.probe,
        },
        999,
      ),
    ).rejects.toMatchObject({ code: 'control_plane.model_not_found' });
  });
});
