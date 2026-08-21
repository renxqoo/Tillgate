/**
 * 瀑布① 规划单元测试（stub 来源，零 DB）：切分/跳过/中断/投影——
 * 来源自身的 probe 语义（订阅开关/成员限额）由集成测试覆盖。
 */
import { describe, expect, it } from 'vitest';
import { Decimal, InsufficientBalanceError } from '@ai-gateway/domain';
import type { RepoContext } from '@ai-gateway/repository';
import { createFundingRegistry } from '../registry.js';
import { planFunding } from '../plan.js';
import { makeStubSource } from './stub-source.js';

const c = {} as RepoContext; // stub 来源不触连接
const now = new Date('2026-08-19T08:00:00Z');
const base = {
  userId: 7,
  requestId: 'v2f-plan-test',
  currency: 'CNY',
  credential: { apiKeyId: null, appId: null },
  resolved: { subscriptionId: null, allowPaygFallback: false },
};

describe('planFunding', () => {
  it('零金额：空计划且不 probe（免费快路径）', async () => {
    const payg = makeStubSource({ type: 'payg', priority: 100, available: 5 });
    const registry = createFundingRegistry([payg.source]);
    const plan = await planFunding(registry, c, { ...base, amount: '0', now });
    expect(plan.entries).toEqual([]);
    expect(plan.planReservedAmount).toBeNull();
    expect(payg.probed).toEqual([]);
  });

  it('单源足额：全额落 PAYG，投影无订阅份额', async () => {
    const payg = makeStubSource({ type: 'payg', priority: 100, available: 50 });
    const registry = createFundingRegistry([payg.source]);
    const plan = await planFunding(registry, c, { ...base, amount: '10', now });
    expect(plan.entries.map((e) => [e.source.type, e.take.toString()])).toEqual([['payg', '10']]);
    expect(plan.planReservedAmount).toBeNull();
  });

  it('开关 ON 额度不足：订阅出余量 + PAYG 补差，投影=订阅份额', async () => {
    const sub = makeStubSource({ type: 'subscription', priority: 10, available: 3 });
    const payg = makeStubSource({ type: 'payg', priority: 100, available: 100 });
    const registry = createFundingRegistry([sub.source, payg.source]);
    const plan = await planFunding(registry, c, {
      ...base,
      resolved: { subscriptionId: 42, allowPaygFallback: true },
      amount: '10',
      now,
    });
    expect(plan.entries.map((e) => [e.source.type, e.take.toString()])).toEqual([
      ['subscription', '3'],
      ['payg', '7'],
    ]);
    expect(plan.planReservedAmount).toBe('3');
    expect(plan.subscriptionId).toBe(42);
    // probe 拿到的是「当前缺口」：订阅看到 10，PAYG 看到 7
    expect(sub.probed[0]!.amount).toBe('10');
    expect(payg.probed[0]!.amount).toBe('7');
  });

  it('可选来源返回 0 → 跳过不占位', async () => {
    const promo = makeStubSource({ type: 'promo', priority: 1, available: 0 });
    const payg = makeStubSource({ type: 'payg', priority: 100, available: 10 });
    const registry = createFundingRegistry([promo.source, payg.source]);
    const plan = await planFunding(registry, c, { ...base, amount: '10', now });
    expect(plan.entries.map((e) => e.source.type)).toEqual(['payg']);
  });

  it('结构性非法：probe 抛错原样上抛，瀑布中断（不允许 fallback）', async () => {
    const sub = makeStubSource({ type: 'subscription', priority: 10, available: 'throw' });
    const payg = makeStubSource({ type: 'payg', priority: 100, available: 100 });
    const registry = createFundingRegistry([sub.source, payg.source]);
    await expect(
      planFunding(registry, c, {
        ...base,
        resolved: { subscriptionId: 1, allowPaygFallback: false },
        amount: '5',
        now,
      }),
    ).rejects.toThrow('probe:subscription');
    // 订阅抛错先行中断——PAYG 根本不被 probe
    expect(payg.probed).toEqual([]);
  });

  it('全链加总不足 → InsufficientBalanceError', async () => {
    const payg = makeStubSource({ type: 'payg', priority: 100, available: 4 });
    const registry = createFundingRegistry([payg.source]);
    await expect(planFunding(registry, c, { ...base, amount: '5', now })).rejects.toThrow(
      InsufficientBalanceError,
    );
  });

  it('金额口径：Decimal 全精度参与切分（无浮点污染）', async () => {
    const sub = makeStubSource({ type: 'subscription', priority: 10, available: 0.1 });
    const payg = makeStubSource({ type: 'payg', priority: 100, available: 1 });
    const registry = createFundingRegistry([sub.source, payg.source]);
    const plan = await planFunding(registry, c, { ...base, amount: '1.1', now });
    expect(new Decimal(plan.entries[1]!.take.toString()).eq('1')).toBe(true);
  });
});
