import { describe, expect, it, beforeAll } from 'vitest';
import { getTracer, initOtel, clearRecentTraces, getRecentTraces, type Tracer } from '@ai-gateway/core';
import type { SettleClaimResult, SettlementClaim } from '@ai-gateway/ledger';
import { settleTelemetry } from '../settle-telemetry.js';

/**
 * 阶段2（worker 结算 span）：以 billing_requests.trace_parent 为远端父，
 * 结算动作挂回请求的同一条 trace。OTEL off/no-op 时自然零开销。
 */

let tracer: Tracer;
beforeAll(() => {
  initOtel({ serviceName: 'worker-test', mode: 'memory' });
  tracer = getTracer('worker.billing');
});

const TRACE_ID = 'ab'.repeat(16);
const SPAN_ID = 'cd'.repeat(8);

function claim(traceParent: string | null): SettlementClaim {
  return {
    requestId: '11111111-2222-3333-4444-555555555555',
    ownerId: 'test-worker',
    claimToken: '00000000-0000-0000-0000-000000000001',
    revision: 3,
    attempt: 1,
    receipt: {
      requestId: '11111111-2222-3333-4444-555555555555',
      userId: 42,
      apiKeyId: null,
      appId: null,
      credentialType: 'key',
      externalModel: 'test-model',
      realModel: 'test-real',
      channelId: 7,
      channelKey: 'test-channel',
      usage: { inputTokens: 1_000, cachedInputTokens: 200, outputTokens: 500, estimated: false },
      inputPrice: '1000',
      outputPrice: '2000',
      cacheInputPrice: '100',
      coefficient: '1',
      durationMs: 120,
      stream: true,
      streamAborted: false,
      mappingId: 1,
      billingPolicyFingerprint: null,
    },
    claimedAt: new Date(),
    claimUntil: new Date(Date.now() + 60_000),
    traceParent,
  };
}

const SETTLED: SettleClaimResult = {
  outcome: 'settled',
  settled: true,
  amount: '2.0',
  calculatedAmount: '2.0',
};

describe('settleTelemetry：结算 span 挂回请求 trace', () => {
  it('有 trace_parent → billing.settle 是同 traceId 的子 span，属性齐全', async () => {
    clearRecentTraces();
    const result = await settleTelemetry(tracer).settle!(
      claim(`00-${TRACE_ID}-${SPAN_ID}-01`),
      async () => SETTLED,
    );
    expect(result).toBe(SETTLED);

    const traces = getRecentTraces(10);
    const spans = traces.flatMap((t) => t.spans).filter((s) => s.name === 'billing.settle');
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.traceId).toBe(TRACE_ID);
    expect(span.parentSpanId).toBe(SPAN_ID);
    expect(span.attributes['billing.state']).toBe('settled');
    expect(span.attributes['billing.amount']).toBe('2.0');
    expect(span.attributes['usage.input_tokens']).toBe(1_000);
    expect(span.attributes['channel.key']).toBe('test-channel');
    expect(span.attributes['request.id']).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('结算抛错 → span 记录异常并保持同 trace', async () => {
    clearRecentTraces();
    await expect(
      settleTelemetry(tracer).settle!(claim(`00-${TRACE_ID}-${SPAN_ID}-01`), async () => {
        throw new Error('settle boom');
      }),
    ).rejects.toThrow('settle boom');
    const spans = getRecentTraces(10).flatMap((t) => t.spans).filter((s) => s.name === 'billing.settle');
    expect(spans).toHaveLength(1);
    expect(spans[0]!.traceId).toBe(TRACE_ID);
    expect(spans[0]!.status.code).toBe(2); // ERROR
  });

  it('无 trace_parent（历史行）→ 不产孤儿 span', async () => {
    clearRecentTraces();
    const result = await settleTelemetry(tracer).settle!(claim(null), async () => SETTLED);
    expect(result).toBe(SETTLED);
    expect(getRecentTraces(10)).toHaveLength(0);
  });
});
