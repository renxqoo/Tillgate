/**
 * 渠道语义：
 *   - models 白名单契约 = string[]（逗号串 4xx；转换职责在调用方边界）
 *   - apiKey 落库即密文（enc:v1 格式；响应/列表永不回密文与明文）
 *   - 换 Key 复位运行态（status 4 → 0、failCount 清零）
 *   - 批量导入 best-effort：供应商缺失条目失败不中断；全败 400；空数组 400
 *   - 探针：解密真发生、回显仅 keyPreview
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { channels as channelsTable, modelChannels, providers as providersTable } from '@ai-gateway/db';
import { decrypt } from '@ai-gateway/core';
import type { Ai } from '@ai-gateway/ai';
import {
  buildTestApp,
  db,
  newAdmin,
  newMappingRow,
  newProviderRow,
  TEST_ENCRYPTION_KEY,
  uid,
} from './helpers.js';

async function createChannel(
  request: ReturnType<typeof buildTestApp>['request'],
  token: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return request('/v1/channels', { token, body });
}

describe('渠道创建契约', () => {
  it('models 数组 → 201 且原样落库', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const providerId = await newProviderRow();
    const res = await createChannel(request, token, {
      providerId,
      name: uid('ch'),
      apiKey: 'sk-test-123',
      models: ['gpt-4o', 'claude-3-5-sonnet'],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number };
    const [row] = await db.select().from(channelsTable).where(eq(channelsTable.id, body.id));
    expect(row!.models).toEqual(['gpt-4o', 'claude-3-5-sonnet']);
  });

  it('models 逗号字符串 → 4xx（契约是数组）', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const providerId = await newProviderRow();
    const res = await createChannel(request, token, {
      providerId,
      name: uid('ch'),
      apiKey: 'sk-test-123',
      models: 'gpt-4o,claude-3-5-sonnet',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('models 缺省 → 201（不限白名单）', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const providerId = await newProviderRow();
    const res = await createChannel(request, token, { providerId, name: uid('ch'), apiKey: 'sk-test-123' });
    expect(res.status).toBe(201);
  });

  it('apiKey 落库即密文（enc:v1）；响应体不含明文也不含密文', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const providerId = await newProviderRow();
    const name = uid('ch');
    const plaintext = 'sk-plain-secret-xyz';
    const res = await createChannel(request, token, { providerId, name, apiKey: plaintext });
    expect(res.status).toBe(201);
    const bodyText = JSON.stringify(await res.json());
    expect(bodyText).not.toContain(plaintext);
    expect(bodyText).not.toContain('apiKeyEnc');

    const [row] = await db.select().from(channelsTable).where(eq(channelsTable.name, name));
    expect(row!.apiKeyEnc).toMatch(/^enc:v1:/);
    expect(row!.apiKeyEnc).not.toContain(plaintext);
    // 密文可解回明文（单 key 单格式链路）
    expect(decrypt(row!.apiKeyEnc, TEST_ENCRYPTION_KEY)).toBe(plaintext);
  });
});

describe('渠道更新与退役', () => {
  it('换 Key：重加密 + 复位运行态（status 4 → 0、failCount 清零）', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const providerId = await newProviderRow();
    const created = (await (
      await createChannel(request, token, { providerId, name: uid('ch'), apiKey: 'sk-old-key' })
    ).json()) as { id: number };
    // 造死凭据态
    await db
      .update(channelsTable)
      .set({ status: 4, failCount: 7 })
      .where(eq(channelsTable.id, created.id));

    const newKey = 'sk-rotated-key-2';
    const res = await request(`/v1/channels/${created.id}`, {
      method: 'PATCH',
      token,
      body: { apiKey: newKey },
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(channelsTable).where(eq(channelsTable.id, created.id));
    expect(row!.status).toBe(0);
    expect(Number(row!.failCount)).toBe(0);
    expect(decrypt(row!.apiKeyEnc, TEST_ENCRYPTION_KEY)).toBe(newKey);
  });

  it('更新/退役不存在 → 404', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    expect(
      (await request('/v1/channels/999999999', { method: 'PATCH', token, body: { name: uid('x') } })).status,
    ).toBe(404);
    expect((await request('/v1/channels/999999999', { method: 'DELETE', token })).status).toBe(404);
  });
});

describe('批量导入（best-effort）', () => {
  it('供应商缺失条目失败不中断；成功条目落库并绑定同目录名映射', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const providerName = uid('imp-prov');
    // 预建同名映射（导入条目 models 引用其 externalName → 应建绑定）
    const externalName = uid('imp-model');
    const mappingId = await newMappingRow({ externalName });
    await db
      .insert(providersTable)
      .values({ name: providerName, protocol: 'openai-compatible', baseUrl: 'https://imp.example.com/v1' });

    const chanName = uid('imp-ch');
    const res = await request('/v1/channels/import', {
      token,
      body: {
        channels: [
          { provider: 'no-such-provider', name: uid('x'), apiKey: 'sk-1' },
          { provider: providerName, name: chanName, apiKey: 'sk-2', models: [externalName] },
        ],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      success: number;
      failed: number;
      details: Array<{ ok: boolean; error?: string }>;
    };
    expect(body).toMatchObject({ total: 2, success: 1, failed: 1 });
    expect(body.details[0]!.ok).toBe(false);
    expect(body.details[0]!.error).toContain('not found');

    const [chan] = await db.select().from(channelsTable).where(eq(channelsTable.name, chanName));
    expect(chan).toBeTruthy();
    expect(chan!.apiKeyEnc).toMatch(/^enc:v1:/);
    // 同名映射绑定建立（weight 1 / priority 0）
    const [binding] = await db
      .select()
      .from(modelChannels)
      .where(eq(modelChannels.channelId, chan!.id));
    expect(binding?.mappingId).toBe(mappingId);
  });

  it('全部失败 → 400；空数组 → 400', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const allFail = await request('/v1/channels/import', {
      token,
      body: { channels: [{ provider: 'ghost', name: uid('x'), apiKey: 'sk' }] },
    });
    expect(allFail.status).toBe(400);
    const empty = await request('/v1/channels/import', { token, body: { channels: [] } });
    expect(empty.status).toBe(400);
  });
});

describe('渠道探针', () => {
  it('解密真发生 + 回显仅 keyPreview（首4****尾4）', async () => {
    let probed: { baseUrl: string; apiKey: string; protocol: string } | null = null;
    const createTester = (): Ai =>
      ({
        async probe(channel: { baseUrl: string; apiKey: string; protocol: string }) {
          probed = channel;
          return { ok: true, durationMs: 3 };
        },
      }) as unknown as Ai;
    const { request } = buildTestApp({ createTester });
    const { token } = await newAdmin();
    const providerId = await newProviderRow();
    const secret = 'sk-probe-secret-abcdef';
    const created = (await (
      await createChannel(request, token, { providerId, name: uid('ch'), apiKey: secret })
    ).json()) as { id: number };

    const res = await request(`/v1/channels/${created.id}/test`, { method: 'POST', token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; keyPreview: string };
    expect(body.ok).toBe(true);
    expect(probed!.apiKey).toBe(secret);
    expect(probed!.baseUrl).toBe('https://example.com/v1');
    // 回显脱敏：不等于明文
    expect(body.keyPreview).not.toBe(secret);
    expect(JSON.stringify(body)).not.toContain(secret);
  });
});

describe('渠道列表富化', () => {
  it('含 providerName/boundModels/upstreamConsumed；密文不出库', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const providerId = await newProviderRow();
    const name = uid('ch');
    await createChannel(request, token, { providerId, name, apiKey: 'sk-list' });
    const res = await request(`/v1/channels?q=${encodeURIComponent(name)}`, { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ providerName: string; boundModels: string[]; upstreamConsumed: string }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.rows[0]!.providerName).toBeTruthy();
    expect(body.rows[0]!.boundModels).toEqual([]);
    expect(body.rows[0]!.upstreamConsumed).toBe('0');
    expect(JSON.stringify(body)).not.toContain('apiKeyEnc');
  });
});
