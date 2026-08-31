/**
 * 渠道预算闸门口径（2026-08-30/31 生产事故已修复转绿——原红测承载）：
 *
 * 【事故】渠道绑定成本五轴全 NULL 且未标 cost_is_free 时，SQL COALESCE 静默继承
 * 映射卖价（input=2/output=8），叠加 JSON 字节保守上界 → 1MB 请求敞口 ≈ $2.13，
 * 双渠道余额（0.4641/0.0665）全拒 → no_available_channel 503，上游零调用。
 *
 * 【修复】成本口径全线统一为「未配置 = 零成本」：
 *   SQL 原样透传 NULL（不 COALESCE）→ catalog-port 全 NULL 未标 free 物化
 *   undefined → 闸门 channelCostAmount 返回 '0'（不预扣不拒绝）→ 结算 receipt
 *   物化全 0（与闸门同源）。配了成本价/free 标记的渠道照常精确管控。
 */
import { describe, expect, it } from 'vitest';
import {
  baseAuth,
  buildInference,
  channel,
  fakeAi,
  fakeCatalog,
  fakeUpstream,
  mapping,
  usage,
} from './harness';
import { staticRoutingPolicy } from '../src/ports/routing';
import { routingPolicySchema } from '../src/routing/policy';
import type { BillingPort } from '../src/ports/billing';

const smartPolicy = () => staticRoutingPolicy(routingPolicySchema.parse({ enabled: true }));

/** 生产 minimax-m3 映射快照（卖价 2/0.4/8——见 model_mappings id=1） */
const prodMapping = () =>
  mapping({
    mappingId: 1,
    externalModel: 'minimax-m3',
    realModel: 'minimax/minimax-m3:free',
    inputPrice: '2',
    cacheInputPrice: '0.4',
    cacheWritePrice: null,
    outputPrice: '8',
  });

/** cost_is_free=true 的物化结果（全 0 成本轴——gateway catalog-port costPricesOf） */
const freeCost = {
  inputPrice: '0',
  cacheInputPrice: '0',
  cacheWritePrice: '0',
  outputPrice: '0',
  unitPrice: '0',
};

/** 显式配置的成本五轴（修复后：配了才有预算管控） */
const configuredCost = {
  inputPrice: '0.2',
  cacheInputPrice: '0.04',
  cacheWritePrice: '0',
  outputPrice: '0.8',
  unitPrice: '0',
};

/** ZCode 长对话形态：≈1MB JSON 请求体，未声明 max_tokens（outputCap 落缺省 4096） */
const bigBody = {
  model: 'minimax-m3',
  messages: [{ role: 'user', content: 'x'.repeat(1_048_000) }],
};

type ReserveInput = Parameters<BillingPort['reserveChannel']>[0];

/**
 * 模拟真实闸门（同源公式：gateway channelCostAmount → billing estimateMaxCost；
 * 成本面缺失 undefined → amount 0 恒放行——修复后语义）。
 */
function exposureGate(balances: Record<number, number>) {
  const reserves: ReserveInput[] = [];
  const port: BillingPort = {
    authorize: async () => {},
    reserveChannel: async (input) => {
      reserves.push(input);
      const cost = input.costPrices;
      if (cost == null) return { allowed: true, remaining: '0' };
      const inputPrice = Math.max(
        Number(cost.inputPrice),
        Number(cost.cacheInputPrice),
        Number(cost.cacheWritePrice),
      );
      const outputPrice = Number(cost.outputPrice);
      const amount =
        (inputPrice * input.estimatedInputTokens + outputPrice * input.maxOutputTokens) / 1e6;
      return amount > (balances[input.channelId] ?? 0)
        ? { allowed: false }
        : { allowed: true, remaining: String((balances[input.channelId] ?? 0) - amount) };
    },
    signal: async () => {},
  };
  return { port, reserves };
}

function setup(balances: Record<number, number>, cost: typeof freeCost | undefined) {
  const ai = fakeAi();
  const upstream = fakeUpstream();
  const billing = exposureGate(balances);
  const catalog = fakeCatalog(
    { 'minimax-m3': prodMapping() },
    {
      'minimax/minimax-m3:free': [
        channel({
          channelId: 2,
          channelName: 'tencent',
          weight: 100,
          upstreamModel: 'minimax-m3',
          ...(cost != null ? { costPrices: cost } : {}),
        }),
        channel({
          channelId: 1,
          channelName: 'openrouter',
          weight: 1,
          upstreamModel: 'minimax/minimax-m3:free',
          ...(cost != null ? { costPrices: cost } : {}),
        }),
      ],
    },
  );
  const inference = buildInference({
    ai: ai.ai,
    catalog,
    billing: billing.port,
    upstream: upstream.port,
    policy: smartPolicy(),
  });
  upstream.onChat(async () => ({ ok: true, usage: usage(), durationMs: 5, body: { ok: 1 } }));
  return { inference, upstream, billing, detach: () => inference.close() };
}

describe('生产事故修复：渠道预算闸门成本口径统一（未配置 = 零成本）', () => {
  it('成本未配置的渠道（生产腾讯云/openrouter 修复后形态）：大请求必须到达上游', async () => {
    // 事故现场参数：腾讯云 0.4641 / openrouter 0.0665，1MB body（旧口径敞口 $2.13 全拒）
    const s = setup({ 2: 0.4641, 1: 0.0665 }, undefined);
    const delivered = await s.inference.chat({
      requestId: 'req-fixed-1',
      auth: baseAuth,
      body: bigBody,
    });
    expect(delivered).toMatchObject({ ok: true, status: 200 });
    expect(s.upstream.calls).toHaveLength(1);
    s.detach();
  });

  it('权重失效修复（8/30 14:33 实况）：主渠道 weight=100 不再被虚高敞口全量跳过', async () => {
    const s = setup({ 2: 0.9, 1: 1_000_000 }, undefined);
    const served: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const delivered = await s.inference.chat({
        requestId: `req-fixed-2-${i}`,
        auth: baseAuth,
        body: bigBody,
      });
      expect(delivered).toMatchObject({ ok: true, status: 200 });
      served.push(s.upstream.calls.at(-1)?.channel.channelId ?? 0);
    }
    // 闸门放行后权重主导：weight 100 的腾讯云至少承载一个请求
    expect(served).toContain(2);
    s.detach();
  });

  it('cost_is_free 渠道：同场景放行，请求到达上游（绿锚点——能力不变）', async () => {
    const s = setup({ 2: 0.4641, 1: 0.0665 }, freeCost);
    const delivered = await s.inference.chat({
      requestId: 'req-fixed-3',
      auth: baseAuth,
      body: bigBody,
    });
    expect(delivered).toMatchObject({ ok: true, status: 200 });
    expect(s.upstream.calls).toHaveLength(1);
    s.detach();
  });

  it('已配置成本的渠道：预算闸门照常精确管控（配了才有管控——修复不放松资金面）', async () => {
    // 成本 0.2/0.8 × 字节口径：敞口 = 0.2×1_048_576/1e6 + 0.8×4096/1e6 ≈ 0.24 > 0.1 余额 → 拒
    const s = setup({ 2: 0.1, 1: 0.1 }, configuredCost);
    await expect(
      s.inference.chat({ requestId: 'req-fixed-4', auth: baseAuth, body: bigBody }),
    ).rejects.toMatchObject({ code: 'inference.no_available_channel' });
    expect(s.upstream.calls).toHaveLength(0);
    // 配置了成本的渠道按配置价评估（未配置回落卖价的旧口径已根除）
    expect(s.billing.reserves.map((r) => r.costPrices?.inputPrice)).toEqual(['0.2', '0.2']);
    s.detach();
  });
});
