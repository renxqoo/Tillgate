/**
 * 渠道用例（v1 channels.test.ts 等价迁移）：
 * 密钥生命周期（落库即密文/返回体无密钥事实/换 Key 复位运行态）/
 * 批量导入 best-effort / 探针真解密 + 回显仅 keyPreview / 列表富化 / 404 族。
 */
import { describe, expect, it } from 'vitest';
import { createChannel } from '../src/application/channels/create-channel';
import { updateChannel } from '../src/application/channels/update-channel';
import { retireChannel } from '../src/application/channels/retire-channel';
import { listChannels } from '../src/application/channels/list-channels';
import { importChannels } from '../src/application/channels/import-channels';
import { probeChannel } from '../src/application/channels/probe-channel';
import {
  adminCtx,
  createMemoryChannelStore,
  createMemoryModelStore,
  createMemoryProviderStore,
  createMemoryAudit,
  createMemoryDb,
  createStubProbe,
  fakeCipher,
} from './memory';

function setup() {
  const db = createMemoryDb();
  const providers = createMemoryProviderStore([
    {
      id: 1,
      name: 'prov-a',
      protocol: 'openai-compatible',
      vendor: null,
      baseUrl: 'https://example.com/v1',
      status: 0,
      createdAt: new Date(),
    },
  ]);
  const channels = createMemoryChannelStore((id) => (id === 1 ? 'prov-a' : 'unknown'));
  const models = createMemoryModelStore();
  const audit = createMemoryAudit();
  const probe = createStubProbe();
  const deps = {
    db,
    stores: { channel: channels.store, provider: providers.store, model: models.store },
    cipher: fakeCipher,
    importMax: 200,
    audit: audit.sink,
  };
  return { deps, channels, models, audit, probe };
}

describe('渠道创建契约', () => {
  it('models 数组原样落库；apiKey 落库即密文，返回体不含明文也不含密文', async () => {
    const { deps, channels } = setup();
    const row = await createChannel(deps, {
      ctx: adminCtx(),
      providerId: 1,
      name: 'ch-1',
      apiKey: 'sk-plain-secret-xyz',
      models: ['gpt-4o', 'claude-3-5-sonnet'],
    });
    const stored = channels.rows.get(row.id)!;
    expect(stored.models).toEqual(['gpt-4o', 'claude-3-5-sonnet']);
    expect(stored.apiKeyEnc).toBe('fake-enc:sk-plain-secret-xyz');
    expect(JSON.stringify(row)).not.toContain('sk-plain-secret-xyz');
    expect(JSON.stringify(row)).not.toContain('apiKeyEnc');
  });

  it('重名 → channel_exists（唯一索引翻译）', async () => {
    const { deps } = setup();
    await createChannel(deps, { ctx: adminCtx(), providerId: 1, name: 'ch', apiKey: 'k1' });
    await expect(
      createChannel(deps, { ctx: adminCtx(), providerId: 1, name: 'ch', apiKey: 'k2' }),
    ).rejects.toMatchObject({ code: 'control_plane.channel_exists' });
  });
});

describe('渠道更新与退役', () => {
  it('换 Key：重加密 + 复位运行态（status 4 → 0、failCount 清零）', async () => {
    const { deps, channels } = setup();
    const created = await createChannel(deps, {
      ctx: adminCtx(),
      providerId: 1,
      name: 'ch',
      apiKey: 'sk-old-key',
    });
    // 造死凭据态
    channels.rows.get(created.id)!.status = 4;
    channels.rows.get(created.id)!.failCount = 7;
    const updated = await updateChannel(deps, {
      ctx: adminCtx(),
      channelId: created.id,
      patch: { apiKey: 'sk-rotated-key-2' },
    });
    const row = channels.rows.get(created.id)!;
    expect(updated.status).toBe(0);
    expect(row.status).toBe(0);
    expect(row.failCount).toBe(0);
    expect(fakeCipher.decrypt(row.apiKeyEnc)).toBe('sk-rotated-key-2');
  });

  it('不换 Key 的普通 patch 不复位运行态', async () => {
    const { deps, channels } = setup();
    const created = await createChannel(deps, {
      ctx: adminCtx(),
      providerId: 1,
      name: 'ch2',
      apiKey: 'k',
    });
    channels.rows.get(created.id)!.status = 4;
    await updateChannel(deps, { ctx: adminCtx(), channelId: created.id, patch: { weight: 5 } });
    expect(channels.rows.get(created.id)!.status).toBe(4);
  });

  it('更新/退役不存在 → channel_not_found', async () => {
    const { deps } = setup();
    await expect(
      updateChannel(deps, { ctx: adminCtx(), channelId: 999999999, patch: { name: 'x' } }),
    ).rejects.toMatchObject({ code: 'control_plane.channel_not_found' });
    await expect(
      retireChannel(deps, { ctx: adminCtx(), channelId: 999999999 }),
    ).rejects.toMatchObject({
      code: 'control_plane.channel_not_found',
    });
  });
});

describe('批量导入（best-effort）', () => {
  it('供应商缺失条目失败不中断；成功条目落库并绑定同目录名映射', async () => {
    const { deps, channels, models } = setup();
    const mapping = await models.store.insertMapping({} as never, {
      externalName: 'imp-model',
      realModel: 'real-1',
      inputPrice: '1',
      outputPrice: '2',
      cacheInputPrice: '0.5',
      isFree: false,
    });
    const result = await importChannels(deps, {
      ctx: adminCtx(),
      channels: [
        { provider: 'no-such-provider', name: 'x', apiKey: 'sk-1' },
        { provider: 'prov-a', name: 'imp-ch', apiKey: 'sk-2', models: ['imp-model'] },
      ],
    });
    expect(result).toMatchObject({ total: 2, success: 1, failed: 1 });
    expect(result.details[0]!.ok).toBe(false);
    expect(result.details[0]!.error).toContain('not found');
    const chan = [...channels.rows.values()].find((c) => c.name === 'imp-ch')!;
    expect(chan).toBeTruthy();
    expect(fakeCipher.decrypt(chan.apiKeyEnc)).toBe('sk-2');
    // 同名映射绑定建立（weight 1 / priority 0）
    expect(models.rows.get(mapping.id)!.bindings).toEqual([
      { channelId: chan.id, weight: 1, priority: 0 },
    ]);
  });

  it('空数组 → import_empty；超上限 → import_limit_exceeded', async () => {
    const { deps } = setup();
    await expect(importChannels(deps, { ctx: adminCtx(), channels: [] })).rejects.toMatchObject({
      code: 'control_plane.import_empty',
    });
    const { deps: limited } = { deps: { ...deps, importMax: 1 } };
    await expect(
      importChannels(limited, {
        ctx: adminCtx(),
        channels: [
          { provider: 'prov-a', name: 'a', apiKey: 'k' },
          { provider: 'prov-a', name: 'b', apiKey: 'k' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'control_plane.import_limit_exceeded' });
  });

  it('全败 = success 0（拒绝信号由结果承载——协议层映射）+ 审计仍记录', async () => {
    const { deps, audit } = setup();
    const result = await importChannels(deps, {
      ctx: adminCtx(),
      channels: [{ provider: 'ghost', name: 'x', apiKey: 'sk' }],
    });
    expect(result.success).toBe(0);
    expect(result.failed).toBe(1);
    expect(audit.entries.at(-1)).toMatchObject({
      action: 'channel.import',
      detail: { total: 1, success: 0 },
    });
  });
});

describe('渠道探针', () => {
  it('解密真发生 + 回显仅 keyPreview；探针目标取 baseUrlOverride 优先', async () => {
    const { deps, probe } = setup();
    const created = await createChannel(deps, {
      ctx: adminCtx(),
      providerId: 1,
      name: 'probe-ch',
      apiKey: 'sk-probe-secret-abcdef',
      baseUrlOverride: 'https://override.example.com/v1',
    });
    const depsWithProbe = { ...deps, probe: probe.probe };
    const result = await probeChannel(depsWithProbe, created.id);
    expect(result.ok).toBe(true);
    expect(probe.calls[0]!.target).toMatchObject({
      apiKey: 'sk-probe-secret-abcdef',
      baseUrl: 'https://override.example.com/v1',
      protocol: 'openai-compatible',
    });
    expect(result.keyPreview).not.toBe('sk-probe-secret-abcdef');
    expect(JSON.stringify(result)).not.toContain('sk-probe-secret-abcdef');
  });

  it('探针失败也是结果不是错误（上游 error 透传；坏密文无预览）', async () => {
    const { deps, probe } = setup();
    const created = await createChannel(deps, {
      ctx: adminCtx(),
      providerId: 1,
      name: 'bad-ct',
      apiKey: 'k',
    });
    // 坏密文：直接改库内密文
    const failing = {
      ...deps,
      probe: probe.probe,
      cipher: {
        encrypt: fakeCipher.encrypt,
        decrypt: () => {
          throw new Error('gcm auth failed');
        },
      },
    };
    const result = await probeChannel(failing, created.id);
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'internal', message: 'gcm auth failed' });
    expect(result.keyPreview).toBeUndefined();
  });

  it('渠道不存在 → channel_not_found', async () => {
    const { deps, probe } = setup();
    await expect(probeChannel({ ...deps, probe: probe.probe }, 999999999)).rejects.toMatchObject({
      code: 'control_plane.channel_not_found',
    });
  });
});

describe('渠道列表富化', () => {
  it('无 q 全量路径 + 富化缺省', async () => {
    const { deps } = setup();
    await createChannel(deps, { ctx: adminCtx(), providerId: 1, name: 'no-q', apiKey: 'k' });
    const result = await listChannels(deps, { sortBy: 'id', order: 'asc', limit: 10, offset: 0 });
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.rows[0]!.upstreamConsumed).toBe('0');
  });

  it('含 providerName/boundModels/upstreamConsumed；密文不出结果', async () => {
    const { deps } = setup();
    await createChannel(deps, {
      ctx: adminCtx(),
      providerId: 1,
      name: 'list-ch',
      apiKey: 'sk-list',
    });
    const result = await listChannels(deps, {
      q: 'list-ch',
      sortBy: 'createdAt',
      order: 'desc',
      limit: 10,
      offset: 0,
    });
    expect(result.total).toBe(1);
    expect(result.rows[0]).toMatchObject({
      providerName: 'prov-a',
      boundModels: [],
      upstreamConsumed: '0',
    });
    expect(JSON.stringify(result)).not.toContain('apiKeyEnc');
  });
});
