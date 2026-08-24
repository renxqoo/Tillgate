/**
 * E2E ⑮ 慢上游三形态实测（v1 e2e-slow 迁移）：慢生成非流式（响应头晚到）/
 * 慢生成流式（首字节后长流）/ 计费租约 vs 长流时长。回答「上游本身很慢会有问题吗」。
 *
 * v1 用真 MiniMax 22s 生成 + connect 旋钮放宽验证；v2 语义映射（kit 头注释同源）：
 * connectMs 只覆盖建连，慢响应归 GATEWAY_UPSTREAM_DEADLINE_MS（totalMs）支配——
 * mock 上游以确定性延迟等价复现「慢生成」，预算两分支（紧→502 释放 / 宽→200 计费）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  defined,
  E2EKeys,
  E2E_MODEL,
  e2ePost,
  setupE2EWorld,
  sleep,
  startE2EGateway,
  type E2EGateway,
  type E2EWorld,
} from './kit';

const hasEnv = process.env.DB_TEST_URL != null || process.env.DATABASE_URL != null;

describe.skipIf(!hasEnv)('E2E ⑮ 慢上游三形态', () => {
  let world: E2EWorld;
  /** 紧预算网关（deadline 2s——慢于它的上游 502 释放） */
  let tightGateway: E2EGateway;
  /** 宽预算网关（v1 connect=60s 放宽形态的 v2 等价：deadline 30s） */
  let relaxedGateway: E2EGateway;
  let keys: E2EKeys;

  beforeAll(async () => {
    world = await setupE2EWorld();
    tightGateway = await startE2EGateway(world, { GATEWAY_UPSTREAM_DEADLINE_MS: '2000' });
    relaxedGateway = await startE2EGateway(world);
    keys = new E2EKeys(world, relaxedGateway.assembly.billingFacade);
  }, 180_000);

  afterAll(async () => {
    if (relaxedGateway) await relaxedGateway.stop();
    if (tightGateway) await tightGateway.stop();
    if (world) await world.teardown();
  });

  it('⑮a-紧 慢生成（延迟 3s > deadline 2s）→ 502 上游失败、三路归还、资金一致', async () => {
    world.upstream.script = 'nonstream-usage';
    world.upstream.delayMs = 3_000;
    const { raw, userId } = await keys.issue('1');
    const res = await e2ePost(tightGateway.baseUrl, raw, {
      model: E2E_MODEL,
      max_tokens: 100,
      messages: [{ role: 'user', content: '写一篇 3000 字的散文，主题：海' }],
    });
    expect(res.status).toBe(502); // 预算不足 → 上游超时形态
    await res.text().catch(() => {});
    await sleep(1_500);
    await keys.settleAll(userId);
    const bills = await keys.billsOf(userId);
    expect(bills.every((b) => b.status === 'released')).toBe(true); // 全额归还
    await keys.assertReconciled(userId, '1'); // 余额==充值（零扣）
    world.upstream.delayMs = 0;
  }, 60_000);

  it('⑮a-宽 慢生成非流式（延迟 3s < deadline 30s）：照常完成并计费（紧预算会误杀）', async () => {
    world.upstream.script = 'nonstream-usage';
    world.upstream.delayMs = 3_000;
    const { raw, userId } = await keys.issue('1');
    const t0 = Date.now();
    const res = await e2ePost(relaxedGateway.baseUrl, raw, {
      model: E2E_MODEL,
      max_tokens: 20_000,
      messages: [{ role: 'user', content: '写一篇 3000 字的散文，主题：海' }],
    });
    const elapsed = Math.round((Date.now() - t0) / 1000);
    console.log(`⑮a 非流式慢生成（deadline=30s）：${elapsed}s → ${res.status}`);
    expect(res.status).toBe(200); // 旋钮生效：慢生成不再被紧预算误杀
    await res.text();
    await keys.settleAll(userId);
    const bills = await keys.billsOf(userId);
    expect(bills.length).toBe(1);
    expect(defined(bills[0], 'bills[0]').status).toBe('settled');
    await keys.assertReconciled(userId, '1'); // 慢但照实计费
    world.upstream.delayMs = 0;
  }, 120_000);

  it('⑮b 慢生成流式（长流慢帧）：透传全程 + 尾帧 usage 照实计费', async () => {
    world.upstream.script = 'stream-usage';
    world.upstream.delayMs = 500; // 首响应延迟
    world.upstream.frameGapMs = 60; // 慢帧（20 帧 × 60ms ≈ 1.2s 长流）
    const { raw, userId } = await keys.issue('1');
    const t0 = Date.now();
    const res = await e2ePost(relaxedGateway.baseUrl, raw, {
      model: E2E_MODEL,
      stream: true,
      max_tokens: 20_000,
      messages: [{ role: 'user', content: '写一篇 2000 字的散文，主题：山' }],
    });
    console.log(`⑮b 流式首响应 ${res.status} @ ${Date.now() - t0}ms`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const elapsed = Math.round((Date.now() - t0) / 1000);
    console.log(`⑮b 流式全程 ${elapsed}s，转发 ${text.length} 字节`);
    expect(text.length).toBeGreaterThan(500);

    await sleep(2_000);
    await keys.settleAll(userId);
    const bills = await keys.billsOf(userId);
    expect(bills.length).toBe(1);
    expect(defined(bills[0], 'bills[0]').status).toBe('settled');
    // 尾帧 usage 是可信计量（不估算）
    const receipt = defined(bills[0], 'bills[0]').receipt as {
      usage?: { estimated?: boolean; inputTokens?: number };
    };
    expect(receipt.usage?.estimated).toBe(false);
    expect(receipt.usage?.inputTokens).toBe(50);
    await keys.assertReconciled(userId, '1');
    world.upstream.delayMs = 0;
    world.upstream.frameGapMs = 0;
  }, 120_000);
});
