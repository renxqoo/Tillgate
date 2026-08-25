/**
 * 红测（审计问题 #8：allPricesZero 用 Number(p) === 0 判免费）：
 * billing-port 的免费闸把候选价格经 Number() 归零判定——Number('')、
 * Number(' 0 ') 均为 0，脏数据价格会被误判为免费并给报价盖 explicitlyFree。
 * 口径不一致：下游 billing 全部走 Decimal（calculateRequired 的免费一致性
 * 检查遇 '' 会抛未分类 Decimal 构造异常，请求 500 而非免费放行——无资损，
 * 但授权闸语义被污染）。契约：免费判定必须走 Decimal 口径，脏值不得进
 * 免费快径。本文件当前为红，修复后转绿。
 */
import { describe, expect, it } from 'vitest';
import type { QuoteCandidate } from '@tillgate/inference';
import { createGatewayBilling } from '../src/adapters/billing-port';
import { defined } from './defined';

function candidate(overrides: Partial<QuoteCandidate>): QuoteCandidate {
  return {
    mappingId: 1,
    externalModel: 'gpt-test',
    realModel: 'gpt-test',
    inputPrice: '0',
    cacheInputPrice: '0',
    cacheWritePrice: null,
    outputPrice: '0',
    unitPrice: null,
    pricingUnit: 'token',
    unitUpperBound: 0,
    coefficient: '1',
    billingPolicyFingerprint: null,
    ...overrides,
  };
}

function harness() {
  const quotes: Array<{ explicitlyFree?: boolean }> = [];
  const port = createGatewayBilling(
    {
      authorize: async (input) => {
        quotes.push(input.quote);
      },
      signal: async () => {},
      reserveChannel: async () => ({ allowed: true, remaining: '0', switched: false }),
    },
    { reservationLimit: '10', reservationPolicy: { mode: 'full' } },
  );
  return { port, quotes };
}

describe('免费闸的 Decimal 口径', () => {
  it('脏数据价格（空串）不得被误判为免费并盖 explicitlyFree', async () => {
    const { port, quotes } = harness();
    await port.authorize({
      requestId: 'req-red-test',
      userId: 1,
      apiKeyId: null,
      appId: null,
      stream: false,
      candidates: [candidate({ inputPrice: '' })],
      inputTokenUpperBound: 100,
      maxOutputTokens: 100,
      authorizationTtlMs: 60_000,
    });
    const quote = defined(quotes[0], 'quotes[0]');
    expect(quote.explicitlyFree).toBeUndefined();
  });

  it('对照：真实全零价格照常盖 explicitlyFree', async () => {
    const { port, quotes } = harness();
    await port.authorize({
      requestId: 'req-red-test-2',
      userId: 1,
      apiKeyId: null,
      appId: null,
      stream: false,
      candidates: [candidate({})],
      inputTokenUpperBound: 100,
      maxOutputTokens: 100,
      authorizationTtlMs: 60_000,
    });
    const quote = defined(quotes[0], 'quotes[0]');
    expect(quote.explicitlyFree).toBe(true);
  });
});
