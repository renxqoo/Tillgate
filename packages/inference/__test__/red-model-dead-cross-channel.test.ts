/**
 * 候选死记忆跨渠道连坐（2026-08-31 已修复转绿——原红测承载）：
 *
 * 【事故形态】死记忆键 = realModel（候选维，跨渠道共享）。openrouter 上游 402
 * （健康证据）+ 腾讯云被预算闸门拒（请求维临时状态）→ 候选「耗尽」×3 → realModel
 * 判死 60s → 腾讯云充值恢复后仍被整候选跳过（连坐）。
 *
 * 【修复】判死证据收窄为「全部渠道以健康证据耗尽」：候选内存在请求维门拒绝
 * （预算/软限流——临时状态，随充值/窗口恢复）时不计死——该渠道从未被证明死亡。
 * 渠道级真实失败仍由惩罚箱/熔断挡；全渠道真失败（如上游 5xx）仍正常判死。
 */
import { describe, expect, it } from 'vitest';
import {
  baseAuth,
  buildInference,
  channel,
  fakeAi,
  fakeBilling,
  fakeCatalog,
  fakeUpstream,
  mapping,
  usage,
  upstreamError,
} from './harness';
import { staticRoutingPolicy } from '../src/ports/routing';
import { routingPolicySchema } from '../src/routing/policy';
import type { BillingPort } from '../src/ports/billing';

const smartPolicy = () => staticRoutingPolicy(routingPolicySchema.parse({ enabled: true }));

const body = { model: 'minimax-m3', messages: [{ role: 'user', content: '你好' }] };

/** 可编程预算闸门：按渠道余额表拒/放（敞口按 token 数×成本价，与生产公式同源） */
function gateByBalance(balances: () => Record<number, number>): BillingPort {
  return {
    authorize: async () => {},
    reserveChannel: async (input) => {
      const cost = input.costPrices;
      if (cost == null) return { allowed: true };
      const inputPrice = Math.max(Number(cost.inputPrice), Number(cost.cacheInputPrice));
      const amount =
        (inputPrice * input.estimatedInputTokens +
          Number(cost.outputPrice) * input.maxOutputTokens) /
        1e6;
      return amount > (balances()[input.channelId] ?? 0) ? { allowed: false } : { allowed: true };
    },
    signal: async () => {},
  };
}

const COST = {
  inputPrice: '2',
  cacheInputPrice: '1',
  cacheWritePrice: '0',
  outputPrice: '8',
  unitPrice: '0',
};

function setup(balances: () => Record<number, number>, tencentUpstreamFails = false) {
  const ai = fakeAi();
  const upstream = fakeUpstream();
  const billing = fakeBilling();
  billing.port.reserveChannel = gateByBalance(balances).reserveChannel;
  const catalog = fakeCatalog(
    {
      'minimax-m3': mapping({
        mappingId: 1,
        externalModel: 'minimax-m3',
        inputPrice: '2',
        outputPrice: '8',
      }),
    },
    {
      'gpt-x-real': [
        channel({ channelId: 1, channelName: 'openrouter', weight: 1, costPrices: COST }),
        channel({ channelId: 2, channelName: 'tencent', weight: 100, costPrices: COST }),
      ],
    },
  );
  // openrouter 上游恒失败（:free 配额尽形态）；腾讯云上游可编程
  upstream.onChat(async (ch) =>
    ch.channelId === 1 || tencentUpstreamFails
      ? { ok: false, error: upstreamError('quota_exhausted', { status: 402 }), durationMs: 1 }
      : { ok: true, usage: usage(), durationMs: 2, body: { ok: 1 } },
  );
  const inference = buildInference({
    ai: ai.ai,
    catalog,
    billing: billing.port,
    upstream: upstream.port,
    policy: smartPolicy(),
  });
  return { inference, upstream, detach: () => inference.close() };
}

describe('死记忆连坐修复：请求维门拒绝不计入判死证据', () => {
  it('修复锁定：openrouter 402 ×3 + 腾讯云预算拒（临时）→ 不判死；腾讯云恢复后立即服务', async () => {
    let balances: Record<number, number> = { 1: 10, 2: 0 };
    const s = setup(() => balances);
    for (let i = 0; i < 3; i += 1) {
      await expect(
        s.inference.chat({ requestId: `req-fixed-${i}`, auth: baseAuth, body }),
      ).rejects.toMatchObject({ code: 'inference.no_available_channel' });
    }
    // 腾讯云充值恢复——判死从未发生（预算拒是临时状态，不是死亡证据）
    balances = { 1: 10, 2: 10 };
    const delivered = await s.inference.chat({
      requestId: 'req-fixed-recovered',
      auth: baseAuth,
      body,
    });
    expect(delivered).toMatchObject({ ok: true, status: 200 });
    expect(s.upstream.calls.filter((c) => c.channel.channelId === 2)).not.toHaveLength(0);
    s.detach();
  });

  it('对照锁定：全渠道以健康证据耗尽（两渠道上游都真失败）仍正常判死省重试', async () => {
    const s = setup(() => ({ 1: 10, 2: 10 }), true); // 腾讯云上游也恒失败
    for (let i = 0; i < 3; i += 1) {
      await expect(
        s.inference.chat({ requestId: `req-dead-${i}`, auth: baseAuth, body }),
      ).rejects.toMatchObject({ code: 'inference.no_available_channel' });
    }
    // 第 4 个请求：候选已被健康证据判死（60s TTL 内）——整候选跳过，零上游尝试
    const callsBefore = s.upstream.calls.length;
    await expect(
      s.inference.chat({ requestId: 'req-dead-4', auth: baseAuth, body }),
    ).rejects.toMatchObject({ code: 'inference.no_available_channel' });
    expect(s.upstream.calls.length).toBe(callsBefore);
    s.detach();
  });
});
