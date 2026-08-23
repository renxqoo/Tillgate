import { describe, expect, it } from 'vitest';
import { isBusinessError } from '@tokenlens/errors';
import { prepareChatRequest } from '../src/application/quote';
import { defaultInferenceDefaults } from '../src/config';
import { baseAuth, fakeCatalog, mapping } from './harness';

describe('application/quote：请求预检（白名单/目录/上界/估算）', () => {
  it('模型白名单拒绝先于一切资金动作（model_not_allowed）', async () => {
    const catalog = fakeCatalog({ 'gpt-x': mapping() }, {});
    const attempt = prepareChatRequest({
      catalog,
      defaults: defaultInferenceDefaults(),
      requestId: 'r',
      now: new Date('2026-08-24T03:00:00+08:00'),
      auth: { ...baseAuth, allowedModels: ['other-model'] },
      body: { model: 'gpt-x' },
    });
    await expect(attempt).rejects.toSatisfy(
      (e: unknown) => isBusinessError(e) && e.code === 'inference.model_not_allowed',
    );
  });

  it('目录无映射 → model_not_found；body.model 非字符串同判（垃圾形状不崩）', async () => {
    const catalog = fakeCatalog({}, {});
    const defaults = defaultInferenceDefaults();
    await expect(
      prepareChatRequest({
        catalog,
        defaults,
        requestId: 'r',
        now: new Date('2026-08-24T03:00:00+08:00'),
        auth: baseAuth,
        body: { model: 'nope' },
      }),
    ).rejects.toSatisfy(
      (e: unknown) => isBusinessError(e) && e.code === 'inference.model_not_found',
    );
    await expect(
      prepareChatRequest({
        catalog,
        defaults,
        requestId: 'r',
        now: new Date('2026-08-24T03:00:00+08:00'),
        auth: baseAuth,
        body: {},
      }),
    ).rejects.toSatisfy(
      (e: unknown) => isBusinessError(e) && e.code === 'inference.model_not_found',
    );
  });

  it('候选链 = 主 + fallback 解析；声明超封顶钳制进 upstreamBody；双口径估算就位', async () => {
    const catalog = fakeCatalog(
      {
        'gpt-x': mapping({ fallbackModels: ['gpt-y'] }),
        'gpt-y': mapping({ mappingId: 12, externalModel: 'gpt-y', realModel: 'gpt-y-real' }),
      },
      {},
    );
    const prepared = await prepareChatRequest({
      catalog,
      defaults: defaultInferenceDefaults(),
      requestId: 'r',
      now: new Date('2026-08-24T03:00:00+08:00'),
      auth: baseAuth,
      body: { model: 'gpt-x', messages: [{ role: 'user', content: '你好' }], max_tokens: 50_000 },
    });
    expect(prepared.candidates.map((c) => c.realModel)).toEqual(['gpt-x-real', 'gpt-y-real']);
    // 声明超 exposureCap → 压到 32_768（「预估敞口 ≥ 实际输出」）
    expect(prepared.outputCap).toBe(32_768);
    expect(prepared.upstreamBody.max_tokens).toBe(32_768);
    // 敞口口径 = JSON 字节；实扣口径 = 特征估算（两个不同数字，双口径不混用）
    expect(prepared.inputUpperBound).toBeGreaterThan(0);
    expect(prepared.inputEstimate).toBeGreaterThan(0);
  });

  it('embeddings 端点输出上界 0（钳制不改写转发体）', async () => {
    const catalog = fakeCatalog({ 'gpt-x': mapping() }, {});
    const prepared = await prepareChatRequest({
      catalog,
      defaults: defaultInferenceDefaults(),
      requestId: 'r',
      now: new Date('2026-08-24T03:00:00+08:00'),
      auth: baseAuth,
      body: { model: 'gpt-x', input: 'hi' },
      endpoint: 'embeddings',
    });
    expect(prepared.outputCap).toBe(0);
    expect(prepared.upstreamBody).toEqual({ model: 'gpt-x', input: 'hi' });
  });
});
