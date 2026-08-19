/** 定价策略（纯函数）：flat 兼容 / variant 三模态 / 保守估计 vs 精确结算。 */
import { describe, expect, it } from 'vitest';
import { strategyOf, type PricingContext } from '../pricing-strategy.js';

const ctx = (overrides: Partial<PricingContext> = {}): PricingContext => ({
  units: 1,
  body: {},
  config: {},
  fallbackUnitPrice: '0.04',
  ...overrides,
});

describe('flat 策略（缺省——现有模型零迁移兼容）', () => {
  it('unitPrice 列直接生效；config.params.unitPrice 覆盖', () => {
    const s = strategyOf({});
    expect(s.settleUnitPrice(ctx())).toBe('0.04');
    expect(s.settleUnitPrice(ctx({ config: { strategy: 'flat', params: { unitPrice: '0.10' } } }))).toBe('0.10');
  });
});

describe('variant 策略（图/视频/音乐多变体）', () => {
  const variantConfig = {
    strategy: 'variant',
    params: {
      selector: 'size',
      prices: { '512x512': '0.02', '1024x1024': '0.04', '1024x1792': '0.08' },
    },
  };

  it('请求参数命中 → 精确选价（结算与预扣一致）', () => {
    const s = strategyOf(variantConfig);
    const context = ctx({ config: variantConfig, body: { size: '1024x1024' } });
    expect(s.settleUnitPrice(context)).toBe('0.04');
    expect(s.estimateUnitPrice(context)).toBe('0.04');
  });

  it('参数未指定 → 预扣取最高价（保守），结算回落缺省', () => {
    const s = strategyOf(variantConfig);
    const context = ctx({ config: variantConfig, body: {} });
    expect(s.estimateUnitPrice(context)).toBe('0.08'); // 最高价
    expect(s.settleUnitPrice(context)).toBe('0.04');   // 回落 fallbackUnitPrice
  });

  it('多参数组合键（size:quality）', () => {
    const combo = {
      strategy: 'variant',
      params: {
        selector: 'size:quality',
        prices: { '1024x1024:hd': '0.08', '1024x1024:standard': '0.04' },
      },
    };
    const s = strategyOf(combo);
    expect(
      s.settleUnitPrice(ctx({ config: combo, body: { size: '1024x1024', quality: 'hd' } })),
    ).toBe('0.08');
  });

  it('视频按分辨率：1080p 每秒价高于 720p', () => {
    const videoConfig = {
      strategy: 'variant',
      params: {
        selector: 'resolution',
        prices: { '720p': '0.08', '1080p': '0.12', '4k': '0.30' },
      },
    };
    const s = strategyOf(videoConfig);
    expect(
      s.settleUnitPrice(ctx({ config: videoConfig, body: { resolution: '1080p' } })),
    ).toBe('0.12');
  });

  it('音乐按时长档一口价', () => {
    const musicConfig = {
      strategy: 'variant',
      params: {
        selector: 'duration',
        prices: { '30s': '0.10', '60s': '0.15', full: '0.25' },
      },
    };
    const s = strategyOf(musicConfig);
    expect(
      s.settleUnitPrice(ctx({ config: musicConfig, body: { duration: '60s' } })),
    ).toBe('0.15');
  });

  it('空价格表回落缺省价', () => {
    const emptyConfig = { strategy: 'variant', params: {} };
    const s = strategyOf(emptyConfig);
    expect(s.settleUnitPrice(ctx({ config: emptyConfig }))).toBe('0.04');
  });
});

describe('策略注册表', () => {
  it('未声明 = flat；未知策略名 = flat 兜底', () => {
    expect(strategyOf({})).toBe(strategyOf({ strategy: 'flat' }));
    expect(strategyOf({ strategy: 'nonexistent' })).toBe(strategyOf({}));
  });
});
