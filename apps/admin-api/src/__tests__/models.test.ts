/**
 * 模型映射语义（v1 models / model-bindings / model-bindings-echo /
 * models.numeric-domain.red 的 v2 对位）：
 *   - R6：isFree=true 必须全零价（创建直判 + 更新合并判——部分补丁不能造矛盾态）
 *   - 绑定全量替换（A→B 只剩 B；空数组 = 解绑）
 *   - 列表 channelIds 回显（未绑定 = []）
 *   - 数值域铁三角 red：'1e999'(Infinity) / 1e21 / contextLength 1e30 → 400 不触库
 *   - 探针：chat 请求 = 1 条 "1" + max_tokens 1，密钥已解密
 * 金额断言用 Decimal .eq()（PG numeric(38,18) 尾零不干扰）。
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Decimal } from '@ai-gateway/domain';
import { modelChannels, modelMappings } from '@ai-gateway/db';
import {
  buildTestApp,
  db,
  newAdmin,
  newChannelRow,
  newProviderRow,
  stubAi,
  trackMapping,
  uid,
} from './helpers.js';

async function createModel(
  request: ReturnType<typeof buildTestApp>['request'],
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<{
  res: Response;
  body: { id: number; externalName: string };
  json: Record<string, unknown>;
}> {
  const externalName = uid('model');
  const res = await request('/v1/models', {
    token,
    body: {
      externalName,
      realModel: uid('real'),
      inputPrice: '1',
      outputPrice: '2',
      cacheInputPrice: '0.5',
      ...overrides,
    },
  });
  const json = (await res.json()) as Record<string, unknown>;
  const id = json.id as number;
  if (res.status === 201) trackMapping(id);
  return { res, body: { id, externalName }, json };
}

describe('模型 CRUD 与 R6 免费价格一致性', () => {
  it('创建 isFree=true + 非零价 → 400 free_model_price_conflict', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const { res, json } = await createModel(request, token, { isFree: true, inputPrice: '1' });
    expect(res.status).toBe(400);
    expect((json.error as { code: string }).code).toBe('free_model_price_conflict');
  });

  it('创建全零价 + isFree=true → 201', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const { res } = await createModel(request, token, {
      isFree: true,
      inputPrice: '0',
      outputPrice: '0',
      cacheInputPrice: '0',
    });
    expect(res.status).toBe(201);
  });

  it('部分补丁不能造矛盾态：isFree=true + 只改 outputPrice>0 → 400（合并判）', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const { body } = await createModel(request, token, {
      isFree: true,
      inputPrice: '0',
      outputPrice: '0',
      cacheInputPrice: '0',
    });
    const res = await request(`/v1/models/${body.id}`, {
      method: 'PATCH',
      token,
      body: { outputPrice: '3' },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('free_model_price_conflict');
    // 库中价格未被动过
    const [row] = await db.select().from(modelMappings).where(eq(modelMappings.id, body.id));
    expect(new Decimal(row!.outputPrice).eq(0)).toBe(true);
  });

  it('更新/退役不存在 → 404 model_not_found', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    expect((await request('/v1/models/999999999', { method: 'PATCH', token, body: { realModel: 'x' } })).status).toBe(404);
    expect((await request('/v1/models/999999999', { method: 'DELETE', token })).status).toBe(404);
  });
});

describe('单位计价（图片/音频族——unitPrice+pricingUnit 管理面通道，2026-08-21 补齐）', () => {
  it('创建图片模型：pricingUnit=image + unitPrice + token 三价 0 → 201 落库', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const res = await request('/v1/models', {
      token,
      body: {
        externalName: uid('img'),
        realModel: 'qwen-image-3.0',
        inputPrice: '0', outputPrice: '0', cacheInputPrice: '0',
        pricingUnit: 'image',
        unitPrice: '0.2',
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { pricingUnit: string; unitPrice: string };
    expect(body.pricingUnit).toBe('image');
    expect(new Decimal(body.unitPrice).eq('0.2')).toBe(true); // numeric 全精度串
  });

  it('编辑改单价生效；非法单位 → 400', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const { body } = await createModel(request, token);
    const patch = await request(`/v1/models/${body.id}`, {
      method: 'PATCH',
      token,
      body: { pricingUnit: 'second', unitPrice: '1.5' },
    });
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as { pricingUnit: string; unitPrice: string };
    expect(patched.pricingUnit).toBe('second');
    expect(new Decimal(patched.unitPrice).eq('1.5')).toBe(true);

    const bad = await request('/v1/models', {
      token,
      body: { externalName: uid('u'), realModel: 'x', inputPrice: '0', outputPrice: '0', cacheInputPrice: '0', pricingUnit: 'banana', unitPrice: '1' },
    });
    expect(bad.status).toBe(400);
  });

  it('isFree + unitPrice>0 → 400（免费一致性含单价）', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const res = await request('/v1/models', {
      token,
      body: { externalName: uid('f'), realModel: 'x', inputPrice: '0', outputPrice: '0', cacheInputPrice: '0', isFree: true, pricingUnit: 'image', unitPrice: '0.1' },
    });
    expect(res.status).toBe(400);
  });
});

describe('变体价格（分辨率差价——billingConfig 管理面通道，编辑表单依赖 null=清除语义）', () => {
  it('创建图片模型带 variant 差价 → 201 回显 selector 与价格表', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const res = await request('/v1/models', {
      token,
      body: {
        externalName: uid('var'),
        realModel: 'qwen-image-3.0',
        inputPrice: '0', outputPrice: '0', cacheInputPrice: '0',
        pricingUnit: 'image', unitPrice: '0.2',
        billingConfig: {
          strategy: 'variant',
          params: { selector: 'size', prices: { '1024*1024': '0.2', '2048*2048': '0.5' } },
        },
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      billingConfig: { strategy: string; params: { selector: string; prices: Record<string, string> } };
    };
    expect(body.billingConfig.strategy).toBe('variant');
    expect(body.billingConfig.params.selector).toBe('size');
    expect(new Decimal(body.billingConfig.params.prices['2048*2048']!).eq('0.5')).toBe(true);
  });

  it('PATCH billingConfig: null → 清除差价回到统一单价（库中不残留 variant）', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const { body } = await createModel(request, token, {
      inputPrice: '0', outputPrice: '0', cacheInputPrice: '0',
      pricingUnit: 'image', unitPrice: '0.3',
      billingConfig: {
        strategy: 'variant',
        params: { selector: 'size', prices: { '1024*1024': '0.3' } },
      },
    });
    const patch = await request(`/v1/models/${body.id}`, {
      method: 'PATCH',
      token,
      body: { billingConfig: null },
    });
    expect(patch.status).toBe(200);
    const [row] = await db.select().from(modelMappings).where(eq(modelMappings.id, body.id));
    expect(row!.billingConfig).toEqual({}); // 清除 = 空对象，不是残留 variant
  });

  it('variant 缺 prices 或缺 selector → 400 不触库', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const noPrices = await request('/v1/models', {
      token,
      body: {
        externalName: uid('np'), realModel: 'x',
        inputPrice: '0', outputPrice: '0', cacheInputPrice: '0',
        pricingUnit: 'image', unitPrice: '0.2',
        billingConfig: { strategy: 'variant', params: { selector: 'size' } },
      },
    });
    expect(noPrices.status).toBe(400);

    const noSelector = await request('/v1/models', {
      token,
      body: {
        externalName: uid('ns'), realModel: 'x',
        inputPrice: '0', outputPrice: '0', cacheInputPrice: '0',
        pricingUnit: 'image', unitPrice: '0.2',
        billingConfig: { strategy: 'variant', params: { prices: { '1024*1024': '0.2' } } },
      },
    });
    expect(noSelector.status).toBe(400);
  });
});

describe('重名创建 → 409 精确文案（曾折叠成「重名/引用/数值域」盲猜）', () => {
  it('重复 externalName → 409 model_exists，报已存在 id 与状态', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const { body } = await createModel(request, token);
    const dup = await request('/v1/models', {
      token,
      body: {
        externalName: body.externalName,
        realModel: uid('rm'),
        inputPrice: '1', outputPrice: '2', cacheInputPrice: '1',
      },
    });
    expect(dup.status).toBe(409);
    const err = (await dup.json()) as { error: { code: string; message: string } };
    expect(err.error.code).toBe('model_exists');
    expect(err.error.message).toContain(body.externalName);
    expect(err.error.message).toContain(String(body.id));
  });
});

describe('数值域铁三角（red：zod 层收口，绝不溢出到 PG 500）', () => {
  it.each([
    { body: { inputPrice: '1e999' }, why: '字符串 Infinity' },
    { body: { inputPrice: '1e21' }, why: '超 MONEY_MAX' },
    { body: { contextLength: 1e30 }, why: '超上下文上限' },
  ])('$why → 400 且不触库', async ({ body }) => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const { res, body: created } = await createModel(request, token, body);
    expect(res.status).toBe(400);
    const [row] = await db.select().from(modelMappings).where(eq(modelMappings.externalName, created.externalName));
    expect(row).toBeUndefined();
  });
});

describe('绑定全量替换 + channelIds 回显', () => {
  it('绑 A → 绑 B = 全量替换（只剩 B）；空数组 = 解绑全部', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const providerId = await newProviderRow();
    const channelA = await newChannelRow(providerId);
    const channelB = await newChannelRow(providerId);
    const { body } = await createModel(request, token);

    const bindA = await request(`/v1/models/${body.id}/channels`, {
      token,
      body: { channels: [{ channelId: channelA }] },
    });
    expect(bindA.status).toBe(200);
    let rows = await db.select().from(modelChannels).where(eq(modelChannels.mappingId, body.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channelId).toBe(channelA);

    await request(`/v1/models/${body.id}/channels`, {
      token,
      body: { channels: [{ channelId: channelB }] },
    });
    rows = await db.select().from(modelChannels).where(eq(modelChannels.mappingId, body.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channelId).toBe(channelB);

    // 列表回显（按对外名搜）：绑定 B
    const list = (await (
      await request(`/v1/models?q=${body.externalName}`, { token })
    ).json()) as { rows: Array<{ id: number; channelIds: number[] }> };
    const mine = list.rows.find((r) => r.id === body.id);
    expect(mine!.channelIds).toEqual([channelB]);

    // 空数组 = 解绑全部
    await request(`/v1/models/${body.id}/channels`, { token, body: { channels: [] } });
    rows = await db.select().from(modelChannels).where(eq(modelChannels.mappingId, body.id));
    expect(rows).toHaveLength(0);
  });

  it('未绑定模型的 channelIds = []（而非 undefined）', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const { body } = await createModel(request, token);
    const list = (await (
      await request(`/v1/models?q=${body.externalName}`, { token })
    ).json()) as { rows: Array<{ id: number; channelIds: number[] }> };
    const mine = list.rows.find((r) => r.id === body.id);
    expect(mine!.channelIds).toEqual([]);
  });

  it('绑定不存在的模型 → 404', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const providerId = await newProviderRow();
    const channelA = await newChannelRow(providerId);
    const res = await request('/v1/models/999999999/channels', {
      token,
      body: { channels: [{ channelId: channelA }] },
    });
    expect(res.status).toBe(404);
  });
});

describe('模型探针', () => {
  it('逐渠道最小成本生成："1" + max_tokens 1；密钥已解密；结果含 tokens', async () => {
    const calls: unknown[] = [];
    const { request } = buildTestApp({ createTester: stubAi((input) => calls.push(input)) });
    const { token } = await newAdmin();
    const providerId = await newProviderRow();
    const secret = 'sk-probe-model-secret';
    const channelId = (
      (await (
        await request('/v1/channels', { token, body: { providerId, name: uid('ch'), apiKey: secret } })
      ).json()) as { id: number }
    ).id;
    const realModel = uid('real');
    const { body } = await createModel(request, token, { realModel });
    await request(`/v1/models/${body.id}/channels`, { token, body: { channels: [{ channelId }] } });

    const res = await request(`/v1/models/${body.id}/test`, { method: 'POST', token });
    expect(res.status).toBe(200);
    const responseBody = (await res.json()) as {
      results: Array<{ channelId: number; ok: boolean; tokens?: number; durationMs: number }>;
    };
    expect(responseBody.results).toHaveLength(1);
    expect(responseBody.results[0]).toMatchObject({ channelId, ok: true, tokens: 3 });
    expect(responseBody.results[0]!.durationMs).toBeGreaterThanOrEqual(0);

    // 探针请求形状：1 条消息、max_tokens 1、真实模型名、解密后的明文密钥
    const call = calls[0] as {
      request: { model: string; messages: unknown[]; max_tokens: number };
      channel: { apiKey: string };
      ctx: { maxRetries: number };
    };
    expect(call.request.messages).toHaveLength(1);
    expect(call.request.max_tokens).toBe(1);
    expect(call.request.model).toBe(realModel);
    expect(call.ctx.maxRetries).toBe(0);
    expect(call.channel.apiKey).toBe(secret);
  });

  it('上游失败 → ok:false + 错误码透传', async () => {
    const { request } = buildTestApp({
      createTester: stubAi(undefined, { status: 'error', code: 'rate_limited' }),
    });
    const { token } = await newAdmin();
    const providerId = await newProviderRow();
    const channelId = (
      (await (
        await request('/v1/channels', { token, body: { providerId, name: uid('ch'), apiKey: 'sk-x' } })
      ).json()) as { id: number }
    ).id;
    const { body } = await createModel(request, token);
    await request(`/v1/models/${body.id}/channels`, { token, body: { channels: [{ channelId }] } });

    const res = await request(`/v1/models/${body.id}/test`, { method: 'POST', token });
    const responseBody = (await res.json()) as { results: Array<{ ok: boolean; error: { code: string } }> };
    expect(responseBody.results[0]!.ok).toBe(false);
    expect(responseBody.results[0]!.error.code).toBe('rate_limited');
  });
});
