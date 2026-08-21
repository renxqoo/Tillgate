/** 注册表解析链：applies 过滤 + priority 升序（小先耗）。 */
import { describe, expect, it } from 'vitest';
import { createFundingRegistry } from '../registry.js';
import type { FundingSourceContext } from '../source.js';
import { makeStubSource } from './stub-source.js';

const context: FundingSourceContext = {
  userId: 7,
  currency: 'CNY',
  credential: { apiKeyId: null, appId: null },
  resolved: { subscriptionId: null, allowPaygFallback: false },
};

describe('createFundingRegistry', () => {
  it('resolve：priority 升序（订阅 10 先于 PAYG 100），注册顺序无关', () => {
    const payg = makeStubSource({ type: 'payg', priority: 100, available: 0 });
    const sub = makeStubSource({ type: 'subscription', priority: 10, available: 0 });
    const registry = createFundingRegistry([payg.source, sub.source]);
    expect(registry.resolve(context).map((s) => s.type)).toEqual(['subscription', 'payg']);
  });

  it('resolve：不适用的来源不进解析链', () => {
    const sub = makeStubSource({ type: 'subscription', priority: 10, available: 5, applies: false });
    const payg = makeStubSource({ type: 'payg', priority: 100, available: 5 });
    const registry = createFundingRegistry([sub.source, payg.source]);
    expect(registry.resolve(context).map((s) => s.type)).toEqual(['payg']);
  });

  it('get：未注册类型抛错', () => {
    const registry = createFundingRegistry([]);
    expect(() => registry.get('promo')).toThrow('funding source not registered');
  });
});
