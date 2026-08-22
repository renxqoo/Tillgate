import { describe, expect, it } from 'vitest';
import { isBusinessError } from '@tokenlens/errors';
import {
  baseAuth,
  buildInference,
  channel,
  fakeAi,
  fakeBilling,
  fakeCatalog,
  fakeUpstream,
  mapping,
  upstreamError,
  usage,
} from './harness';
import type { BillingSignal } from '../src/ports/billing';

function setup(defaults?: Parameters<typeof buildInference>[0]['defaults']) {
  const ai = fakeAi();
  const upstream = fakeUpstream();
  const billing = fakeBilling();
  const catalog = fakeCatalog(
    {
      'gpt-x': mapping({ fallbackModels: ['gpt-y'] }),
      'gpt-y': mapping({ mappingId: 12, externalModel: 'gpt-y', realModel: 'gpt-y-real' }),
    },
    {
      'gpt-x-real': [channel({ channelId: 1, channelName: 'ch-a' })],
      'gpt-y-real': [channel({ channelId: 2, channelName: 'ch-b' })],
    },
  );
  const inference = buildInference({
    ai: ai.ai,
    catalog,
    billing: billing.port,
    upstream: upstream.port,
    ...(defaults != null ? { defaults } : {}),
  });
  return { inference, upstream, billing, catalog, emit: ai.emit, detach: () => inference.close() };
}

const body = { model: 'gpt-x', messages: [{ role: 'user', content: '你好' }] };

describe('application/chat：非流式尝试（先结算后交付）', () => {
  it('成功：可信 usage 收据 → request_succeeded → 200 交付（顺序：signal 先于返回）', async () => {
    const s = setup();
    s.upstream.onChat(async () => ({
      ok: true,
      usage: usage({
        inputTokens: 100,
        cachedInputTokens: 30,
        outputTokens: 40,
        cacheWriteTokens: 5,
      }),
      durationMs: 12,
      body: { id: 'cmpl', choices: [] },
    }));
    const delivered = await s.inference.chat({ requestId: 'req-1', auth: baseAuth, body });
    expect(delivered).toMatchObject({ ok: true, status: 200 });
    const succeeded = s.billing.signals.find((e) => e.type === 'request_succeeded') as
      | Extract<BillingSignal, { type: 'request_succeeded' }>
      | undefined;
    expect(succeeded?.receipt).toMatchObject({
      requestId: 'req-1',
      channelId: 1,
      realModel: 'gpt-x-real',
      stream: false,
      credentialType: 'key',
    });
    expect(succeeded?.receipt.usage).toEqual({
      estimated: false,
      inputTokens: 100,
      cachedInputTokens: 30,
      outputTokens: 40,
      cacheWriteTokens: 5,
    });
    // authorize 收到候选链与敞口口径
    expect(s.billing.authorizations[0]).toMatchObject({
      requestId: 'req-1',
      stream: false,
      inputTokenUpperBound: expect.any(Number),
      maxOutputTokens: 4_096,
    });
    expect(s.billing.authorizations[0]?.candidates).toHaveLength(2);
    s.detach();
  });

  it('二进制成功：rawBody 原样字节 + content-type 透传（JSON 信封会毁掉字节流）', async () => {
    const s = setup();
    const bytes = new Uint8Array([1, 2, 3]);
    s.upstream.onChat(async () => ({
      ok: true,
      durationMs: 3,
      rawBody: bytes,
      rawContentType: 'audio/mpeg',
    }));
    const delivered = await s.inference.chat({ auth: baseAuth, body, endpoint: 'audio_speech' });
    expect(delivered).toEqual({
      ok: true,
      status: 200,
      rawBody: bytes,
      rawContentType: 'audio/mpeg',
    });
    s.detach();
  });

  it('缺 usage：估算收据（ai 估算值优先）仍结算（不漏收零 usage 响应）', async () => {
    const s = setup();
    s.upstream.onChat(async () => ({ ok: true, durationMs: 3, body: { done: true } }));
    await s.inference.chat({ requestId: 'req-2', auth: baseAuth, body });
    const succeeded = s.billing.signals.find((e) => e.type === 'request_succeeded') as
      | Extract<BillingSignal, { type: 'request_succeeded' }>
      | undefined;
    expect(succeeded?.receipt.usage.estimated).toBe(true);
    expect(succeeded?.receipt.estimatedFor).toBe('usage_missing_nonstream');
    expect(succeeded?.receipt.usage.inputTokens).toBeGreaterThan(0);
    expect(succeeded?.receipt.usage.outputTokens).toBeGreaterThan(0);
    s.detach();
  });

  it('结算重试耗尽 → finalize_unavailable（未交付不结算）；重试按退避逐次进行', async () => {
    const s = setup({ settleSignal: { attempts: 3, baseDelayMs: 1, maxDelayMs: 4 } });
    s.upstream.onChat(async () => ({ ok: true, durationMs: 3, body: {} }));
    const original = s.billing.port.signal;
    let succeededAttempts = 0;
    s.billing.port.signal = async (input) => {
      if (input.type === 'request_succeeded') {
        succeededAttempts += 1;
        throw new Error('db down');
      }
      await original(input);
    };
    const result = await s.inference.chat({ requestId: 'req-3', auth: baseAuth, body }).then(
      (value) => value,
      (e: unknown) => e,
    );
    expect(isBusinessError(result) && result.code === 'inference.finalize_unavailable').toBe(true);
    expect(succeededAttempts).toBe(3); // 退避重试后耗尽（非一击即溃）
    s.detach();
  });

  it('上游 4xx：透传终局（原码返回）且发 request_failed；不换渠不吞 502', async () => {
    const s = setup();
    s.upstream.onChat(async () => ({
      ok: false,
      error: upstreamError('invalid_request', { status: 400, message: 'bad' }),
      durationMs: 2,
    }));
    const delivered = await s.inference.chat({ requestId: 'req-4', auth: baseAuth, body });
    expect(delivered).toMatchObject({
      ok: true,
      passthrough: true,
      status: 400,
      code: 'invalid_request',
    });
    expect(s.billing.signals).toEqual([
      { type: 'upstream_started', requestId: 'req-4', leaseOwner: 'inference', leaseMs: 300_000 },
      { type: 'request_failed', requestId: 'req-4', reason: 'invalid_request' },
    ]);
    s.detach();
  });

  it('可换错误换渠：ch-a 网络失败 → ch-b 成功（fallback 候选兜底）', async () => {
    const s = setup();
    const seen: number[] = [];
    s.upstream.onChat(async (ch) => {
      seen.push(ch.channelId);
      if (ch.channelId === 1) {
        return { ok: false, error: upstreamError('network'), durationMs: 1 };
      }
      return { ok: true, usage: usage(), durationMs: 2, body: { ok: 1 } };
    });
    const delivered = await s.inference.chat({ requestId: 'req-5', auth: baseAuth, body });
    expect(delivered).toMatchObject({ ok: true, status: 200, body: { ok: 1 } });
    expect(seen).toEqual([1, 2]);
    s.detach();
  });

  it('requestId 缺省生成（幂等键不为空）且贯穿 authorize/收据', async () => {
    const s = setup();
    s.upstream.onChat(async () => ({ ok: true, usage: usage(), durationMs: 1, body: {} }));
    await s.inference.chat({ auth: baseAuth, body });
    expect(s.billing.authorizations[0]?.requestId).toBeTruthy();
    s.detach();
  });
});
