/**
 * 模型定价编辑器纯函数行为锁定（billing-config-payload.ts）：
 * 档位行构造（预设归位/自定义追加/按 value 或 label 匹配）、窗口行构造与形状校验、
 * 提交形状转换（空串剔除）、billingConfig 提交组装（schedule 优先 / variant 只含完整档位 /
 * 错误分流标记）——拆分 model-form 前先锁死当前行为，逐字等价搬迁的回归底座。
 */
import { describe, expect, it } from 'vitest';

import {
  buildBillingConfigPayload,
  buildTiers,
  buildWindows,
  toWindowPayload,
  trimToPayload,
  windowRowInvalid,
  type TierRow,
  type WindowRow,
} from '../src/features/models/models-content/billing-config-payload';

/** 造一行完整窗口（start ≠ end、HH:MM 合法、有价格） */
const goodWindow = (over: Partial<WindowRow> = {}): WindowRow => ({
  label: '夜间',
  start: '18:00',
  end: '07:00',
  inputPrice: '0.001',
  outputPrice: '',
  cacheInputPrice: '',
  unitPrice: '',
  ...over,
});

/** 造一行预设档位（勾选、value/price 齐全） */
const tier = (over: Partial<TierRow> = {}): TierRow => ({
  label: '1K',
  value: '1024*1024',
  price: '0.04',
  on: true,
  custom: false,
  ...over,
});

describe('buildTiers（billingConfig → 档位行）', () => {
  it('无预设单位（token/request）或空配置 → 预设为空，仅剩自定义行/空数组', () => {
    expect(buildTiers('token')).toEqual([]);
    expect(buildTiers('request', { params: { prices: {} } })).toEqual([]);
    expect(buildTiers('unknown-unit')).toEqual([]);
  });

  it('预设归位：未配置价格的预设行全在但 on=false、price 空串', () => {
    const rows = buildTiers('image');
    expect(rows).toEqual([
      { label: '1K', value: '1024*1024', price: '', on: false, custom: false },
      { label: '2K', value: '2048*2048', price: '', on: false, custom: false },
    ]);
  });

  it('价格按 value 匹配归位：1024*1024 → 1K 行勾选并带价', () => {
    const rows = buildTiers('image', { params: { prices: { '1024*1024': '0.04' } } });
    expect(rows).toEqual([
      { label: '1K', value: '1024*1024', price: '0.04', on: true, custom: false },
      { label: '2K', value: '2048*2048', price: '', on: false, custom: false },
    ]);
  });

  it('价格按 label 匹配归位：键 "2K" 也能点亮 2K 预设行（value ≠ label 时双通道匹配）', () => {
    const rows = buildTiers('image', { params: { prices: { '2K': '0.08' } } });
    expect(rows).toEqual([
      { label: '1K', value: '1024*1024', price: '', on: false, custom: false },
      { label: '2K', value: '2048*2048', price: '0.08', on: true, custom: false },
    ]);
  });

  it('value 与 label 同名单位（second/480p）：键只归位一次，不产生重复自定义行', () => {
    const rows = buildTiers('second', { params: { prices: { '720p': '0.02' } } });
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.value === '720p')).toHaveLength(1);
    expect(rows.every((r) => !r.custom)).toBe(true);
  });

  it('未知键进自定义行：label=value=原键、恒开（on=true, custom=true），追加在预设之后', () => {
    const rows = buildTiers('image', {
      params: { prices: { '1024*1024': '0.04', 'size:quality': '0.5' } },
    });
    expect(rows).toHaveLength(3);
    expect(rows[2]).toEqual({
      label: 'size:quality',
      value: 'size:quality',
      price: '0.5',
      on: true,
      custom: true,
    });
  });
});

describe('buildWindows（billingConfig → 窗口行）', () => {
  it('非 schedule 策略（含缺省 / variant）→ 空数组', () => {
    expect(buildWindows()).toEqual([]);
    expect(buildWindows({ strategy: 'variant' })).toEqual([]);
    expect(buildWindows({ strategy: 'schedule', params: {} })).toEqual([]);
  });

  it('schedule 回显：字段齐全逐项映射，缺省字段补空串（不产生 undefined）', () => {
    const rows = buildWindows({
      strategy: 'schedule',
      params: {
        windows: [
          { label: '夜间', start: '18:00', end: '07:00', inputPrice: '0.001' },
          { start: '09:00', end: '12:00', unitPrice: '0.2' },
        ],
      },
    });
    expect(rows[0]).toEqual({
      label: '夜间',
      start: '18:00',
      end: '07:00',
      inputPrice: '0.001',
      outputPrice: '',
      cacheInputPrice: '',
      unitPrice: '',
    });
    expect(rows[1]).toEqual({
      label: '',
      start: '09:00',
      end: '12:00',
      inputPrice: '',
      outputPrice: '',
      cacheInputPrice: '',
      unitPrice: '0.2',
    });
  });
});

describe('windowRowInvalid（窗口行形状校验）', () => {
  it('合法行：HH:MM、start ≠ end、至少一个价格字段 → false（token 三价或单位单价任一）', () => {
    expect(windowRowInvalid(goodWindow())).toBe(false);
    expect(windowRowInvalid(goodWindow({ inputPrice: '', unitPrice: '0.2' }))).toBe(false);
    expect(windowRowInvalid(goodWindow({ inputPrice: ' 0.001 ' }))).toBe(false);
  });

  it('HH:MM 非法（缺前导零 / 24:00 / 末尾字母）→ true', () => {
    expect(windowRowInvalid(goodWindow({ start: '9:00' }))).toBe(true);
    expect(windowRowInvalid(goodWindow({ end: '24:00' }))).toBe(true);
    expect(windowRowInvalid(goodWindow({ start: '18:0a' }))).toBe(true);
  });

  it('start == end → true（零长窗口非法）', () => {
    expect(windowRowInvalid(goodWindow({ start: '08:00', end: '08:00' }))).toBe(true);
  });

  it('四个价格字段全空（含纯空白）→ true', () => {
    expect(
      windowRowInvalid(
        goodWindow({ inputPrice: '', outputPrice: ' ', cacheInputPrice: '', unitPrice: '' }),
      ),
    ).toBe(true);
  });
});

describe('toWindowPayload / trimToPayload（窗口行 → 提交形状）', () => {
  it('trimToPayload：空串与纯空白 → undefined；非空 → 去前后空白', () => {
    expect(trimToPayload('')).toBeUndefined();
    expect(trimToPayload('   ')).toBeUndefined();
    expect(trimToPayload(' 0.001 ')).toBe('0.001');
  });

  it('空串字段剔除：价格全空的行只提交 start/end，label 空也不出现', () => {
    expect(
      toWindowPayload({ ...goodWindow(), label: '', inputPrice: '', outputPrice: ' ' }),
    ).toEqual({ start: '18:00', end: '07:00' });
  });

  it('label 可选保留：非空 label 与非空价格进 payload（trim 后）', () => {
    expect(toWindowPayload(goodWindow({ label: ' 夜间 ', outputPrice: ' 0.002 ' }))).toEqual({
      label: '夜间',
      start: '18:00',
      end: '07:00',
      inputPrice: '0.001',
      outputPrice: '0.002',
    });
  });
});

describe('buildBillingConfigPayload（schedule/variant 互斥提交组装）', () => {
  it('schedule 优先：启用分时段即按窗口表提交，不再看档位（tier 未填齐也不报错）', () => {
    const res = buildBillingConfigPayload({
      scheduleOn: true,
      windows: [goodWindow()],
      tiers: [tier({ price: '' })],
      selector: '',
      pricingUnit: 'image',
      unitMode: true,
    });
    expect(res).toEqual({
      billingConfig: {
        strategy: 'schedule',
        params: { windows: [toWindowPayload(goodWindow())] },
      },
    });
  });

  it('schedule 开 + 空窗表 → error: windows（不产出 billingConfig）', () => {
    const res = buildBillingConfigPayload({
      scheduleOn: true,
      windows: [],
      tiers: [],
      selector: 'size',
      pricingUnit: 'token',
      unitMode: false,
    });
    expect(res).toEqual({ error: 'windows' });
  });

  it('schedule 开 + 任一坏窗（HH:MM 非法 / 无价格）→ error: windows', () => {
    for (const bad of [goodWindow({ start: '9:00' }), goodWindow({ inputPrice: '' })]) {
      expect(
        buildBillingConfigPayload({
          scheduleOn: true,
          windows: [goodWindow(), bad],
          tiers: [],
          selector: 'size',
          pricingUnit: 'token',
          unitMode: false,
        }),
      ).toEqual({ error: 'windows' });
    }
  });

  it('单位模式勾选未填齐（price 空或 value 空）→ error: tiers', () => {
    expect(
      buildBillingConfigPayload({
        scheduleOn: false,
        windows: [],
        tiers: [tier({ price: '' })],
        selector: 'size',
        pricingUnit: 'image',
        unitMode: true,
      }),
    ).toEqual({ error: 'tiers' });
    expect(
      buildBillingConfigPayload({
        scheduleOn: false,
        windows: [],
        tiers: [tier({ value: '  ' })],
        selector: 'size',
        pricingUnit: 'image',
        unitMode: true,
      }),
    ).toEqual({ error: 'tiers' });
  });

  it('variant prices 只含完整档位：未勾选行不进表，勾选行 value/price 提交前 trim', () => {
    const res = buildBillingConfigPayload({
      scheduleOn: false,
      windows: [],
      tiers: [
        tier({ value: ' 1024*1024 ', price: ' 0.04 ' }),
        tier({ label: '2K', value: '2048*2048', price: '0.08', on: false }),
      ],
      selector: 'size',
      pricingUnit: 'image',
      unitMode: true,
    });
    expect(res).toEqual({
      billingConfig: {
        strategy: 'variant',
        params: { selector: 'size', prices: { '1024*1024': '0.04' } },
      },
    });
  });

  it('单位模式无任何有效档位（全未勾选）→ 不带 billingConfig、无错误', () => {
    const res = buildBillingConfigPayload({
      scheduleOn: false,
      windows: [],
      tiers: [tier({ on: false })],
      selector: 'size',
      pricingUnit: 'image',
      unitMode: true,
    });
    expect(res).toEqual({});
  });

  it('非单位模式（token）不带 billingConfig：即使档位勾选且填写完整（差价仅限单位计价）', () => {
    const res = buildBillingConfigPayload({
      scheduleOn: false,
      windows: [],
      tiers: [tier()],
      selector: 'model',
      pricingUnit: 'token',
      unitMode: false,
    });
    expect(res).toEqual({});
  });

  it('selector 空白回退：按计价方式取默认（image→size），无默认单位（token）→ model 兜底', () => {
    expect(
      buildBillingConfigPayload({
        scheduleOn: false,
        windows: [],
        tiers: [tier()],
        selector: '   ',
        pricingUnit: 'image',
        unitMode: true,
      }).billingConfig?.params?.selector,
    ).toBe('size');
    // UI 不可达组合（token 恒非单位模式），字面锁定回退链末端的 'model' 兜底
    expect(
      buildBillingConfigPayload({
        scheduleOn: false,
        windows: [],
        tiers: [tier()],
        selector: '',
        pricingUnit: 'token',
        unitMode: true,
      }).billingConfig?.params?.selector,
    ).toBe('model');
  });

  it('selector 非空白优先于默认值（自定义参数名直传）', () => {
    expect(
      buildBillingConfigPayload({
        scheduleOn: false,
        windows: [],
        tiers: [tier()],
        selector: 'size:quality',
        pricingUnit: 'image',
        unitMode: true,
      }).billingConfig?.params?.selector,
    ).toBe('size:quality');
  });
});
