import { describe, expect, it } from 'vitest';
import { buildPolicy, formOf, validateForm } from '../src/features/routing/routing-policy-form';
import { ROUTING_FORM_BOUNDS } from '../src/features/routing/routing-bounds';
import type { PolicyForm } from '../src/features/routing/routing-content-types';

const valid: PolicyForm = {
  enabled: true,
  cacheAffinityEnabled: true,
  cacheBoost: '3',
  budgetWatermarkEnabled: true,
  softRatio: '0.2',
  costEnabled: true,
  costFloor: '0.5',
  sameChannelMaxRetries: '3',
  rateLimitBaseMs: '2000',
  rateLimitMaxMs: '60000',
  quotaMs: '1800000',
  conditionalBypass: true,
  modelDeadThreshold: '3',
  waitEnabled: true,
  maxWaitMs: '2000',
};

describe('routing-policy-form 纯函数', () => {
  it('validateForm：合法表单通过；bounds 上下界临界值通过（schema 闭区间）', () => {
    expect(validateForm(valid)).toBeNull();
    expect(validateForm({ ...valid, softRatio: '0.01' })).toBeNull();
    expect(validateForm({ ...valid, softRatio: '1' })).toBeNull();
    expect(validateForm({ ...valid, cacheBoost: '1' })).toBeNull();
    expect(validateForm({ ...valid, cacheBoost: '5' })).toBeNull();
  });

  it('validateForm：下界违规逐一拒绝（0/空/负数/非数字——校验矩阵）', () => {
    expect(validateForm({ ...valid, cacheBoost: '0' })).toMatchObject({
      key: 'invalidNumber',
      min: 1,
      max: 5,
    });
    expect(validateForm({ ...valid, cacheBoost: '' })?.key).toBe('invalidNumber');
    expect(validateForm({ ...valid, sameChannelMaxRetries: 'abc' })?.key).toBe('invalidNumber');
    expect(validateForm({ ...valid, maxWaitMs: '-1' })?.key).toBe('invalidNumber');
    // schema min 0.01：0 通过前端旧实现会被服务端 422/400 拒——边界漂移回归锁
    expect(validateForm({ ...valid, softRatio: '0' })).toMatchObject({
      key: 'invalidNumber',
      min: 0.01,
    });
  });

  it('validateForm：上界违规逐一拒绝（bounds 镜像 schema max）', () => {
    for (const [key, bound] of Object.entries(ROUTING_FORM_BOUNDS) as Array<
      [keyof typeof ROUTING_FORM_BOUNDS, { min: number; max: number; integer: boolean }]
    >) {
      const over = String(bound.max + (bound.integer ? 1 : 0.001));
      expect(
        validateForm({ ...valid, [key]: over }),
        `${key} 上界 ${bound.max} 应拒绝`,
      ).toMatchObject({ key: 'invalidNumber' });
    }
  });

  it('validateForm：modelDeadThreshold 非法输入拒绝（此前完全未校验——NaN 落库 400 回归锁）', () => {
    expect(validateForm({ ...valid, modelDeadThreshold: 'abc' })).toMatchObject({
      key: 'invalidNumber',
      min: 2,
      max: 10,
    });
    expect(validateForm({ ...valid, modelDeadThreshold: '1' })?.key).toBe('invalidNumber');
    expect(validateForm({ ...valid, modelDeadThreshold: '11' })?.key).toBe('invalidNumber');
  });

  it('validateForm：整数约束字段拒绝小数（schema z.number().int()）', () => {
    expect(validateForm({ ...valid, sameChannelMaxRetries: '2.5' })).toMatchObject({
      key: 'notInteger',
      field: 'retries',
    });
    expect(validateForm({ ...valid, quotaMs: '10000.5' })?.key).toBe('notInteger');
    // 非整数约束字段允许小数
    expect(validateForm({ ...valid, cacheBoost: '2.5' })).toBeNull();
  });

  it('validateForm：base > max 拒绝（schema 交叉校验的 UI 前置——两值各自在界内）', () => {
    expect(validateForm({ ...valid, rateLimitBaseMs: '50000', rateLimitMaxMs: '30000' })?.key).toBe(
      'baseExceedsMax',
    );
    expect(
      validateForm({ ...valid, rateLimitBaseMs: '60000', rateLimitMaxMs: '60000' }),
    ).toBeNull();
  });

  it('validateForm：costFloor 边界校验（scorers.costAffinity.floor 0.1–1）', () => {
    expect(validateForm({ ...valid, costFloor: '0.1' })).toBeNull();
    expect(validateForm({ ...valid, costFloor: '1' })).toBeNull();
    expect(validateForm({ ...valid, costFloor: '0' })).toMatchObject({
      key: 'invalidNumber',
      field: 'costFloor',
      min: 0.1,
      max: 1,
    });
    expect(validateForm({ ...valid, costFloor: '1.1' })?.key).toBe('invalidNumber');
    expect(validateForm({ ...valid, costFloor: '' })?.key).toBe('invalidNumber');
    expect(validateForm({ ...valid, costFloor: 'abc' })?.key).toBe('invalidNumber');
  });

  it('costAffinity：缺省关闭且 floor 回落 0.5（镜像 costAffinitySchema default——裁决 C4）', () => {
    const empty = formOf({});
    expect(empty.costEnabled).toBe(false);
    expect(empty.costFloor).toBe('0.5');
    // 已配置策略的防御解析：enabled 缺省 false，floor 携带值回显
    expect(formOf({ scorers: { costAffinity: { floor: 0.8 } } })).toMatchObject({
      costEnabled: false,
      costFloor: '0.8',
    });
    expect(formOf({ scorers: { costAffinity: { enabled: true, floor: 0.8 } } })).toMatchObject({
      costEnabled: true,
      costFloor: '0.8',
    });
  });

  it('buildPolicy：scorers.costAffinity 输出（开关 + floor 数值化）', () => {
    expect(buildPolicy(valid).scorers).toMatchObject({
      costAffinity: { enabled: true, floor: 0.5 },
    });
    expect(buildPolicy({ ...valid, costEnabled: false, costFloor: '0.9' }).scorers).toMatchObject({
      costAffinity: { enabled: false, floor: 0.9 },
    });
  });

  it('buildPolicy：产物无 version 字段（行级列是唯一真相）；formOf 往返稳定', () => {
    const policy = buildPolicy(valid);
    expect('version' in policy).toBe(false);
    expect(formOf(policy)).toEqual(valid);
  });

  it('formOf：空策略回落编译期缺省形态（各字段显式断言——不依赖恒真比较）', () => {
    const empty = formOf({});
    // enabled 缺省 false：无配置 = 单渠道直连
    expect(empty.enabled).toBe(false);
    expect(formOf({ enabled: true }).enabled).toBe(true);
    expect(empty.cacheBoost).toBe('3');
    expect(empty.softRatio).toBe('0.2');
    expect(empty.sameChannelMaxRetries).toBe('3');
    expect(empty.rateLimitBaseMs).toBe('2000');
    expect(empty.rateLimitMaxMs).toBe('60000');
    expect(empty.quotaMs).toBe('1800000');
    expect(empty.modelDeadThreshold).toBe('3');
    expect(empty.maxWaitMs).toBe('2000');
    expect(empty.budgetWatermarkEnabled).toBe(true);
    expect(empty.costEnabled).toBe(false);
    expect(empty.costFloor).toBe('0.5');
    expect(empty.waitEnabled).toBe(true);
  });
});
