import { describe, expect, it } from 'vitest';
import { measurementOf } from '../src/domain/usage/measurement';

describe('domain/usage/measurement：pricingUnit 计量注册表（表驱动）', () => {
  it('token 恒 0（金额全走 token 三价）；request 恒 1', () => {
    expect(measurementOf('token').unitsUpperBoundOf({ n: 5 })).toBe(0);
    expect(measurementOf('token').unitsOf({ n: 5 }, { data: [1, 2] })).toBe(0);
    expect(measurementOf('request').unitsOf({})).toBe(1);
  });

  it('image：上界取 n（≤16 钳制）；实值响应张数优先、兜底 n、最少 1', () => {
    const m = measurementOf('image');
    expect(m.unitsUpperBoundOf({ n: 3 })).toBe(3);
    expect(m.unitsUpperBoundOf({ n: 99 })).toBe(16);
    expect(m.unitsUpperBoundOf({ n: 0 })).toBe(1);
    expect(m.unitsOf({ n: 2 }, { data: [{}, {}, {}] })).toBe(3);
    expect(m.unitsOf({ n: 2 }, { data: [] })).toBe(2);
    expect(m.unitsOf({}, undefined)).toBe(1);
  });

  it('second：audioSeconds（向上取整）优先于 duration 钳制（4-15 缺省 6）', () => {
    const m = measurementOf('second');
    expect(m.unitsUpperBoundOf({ audioSeconds: 2.1 })).toBe(3);
    expect(m.unitsUpperBoundOf({ duration: 3 })).toBe(4); // 低于下界抬到 4
    expect(m.unitsUpperBoundOf({ duration: 99 })).toBe(15); // 高于上界压到 15
    expect(m.unitsUpperBoundOf({})).toBe(6); // 缺省 6（new-api #5498 少押教训）
    expect(m.unitsOf({ audioSeconds: 5, duration: 9 })).toBe(5);
  });

  it('char：码点口径（emoji/增补平面不被 UTF-16 拆半）；非字符串 0', () => {
    const m = measurementOf('char');
    expect(m.unitsUpperBoundOf({ input: 'a😀b' })).toBe(3);
    expect(m.unitsUpperBoundOf({ input: 42 })).toBe(0);
  });

  it('未知单位按次兜底（目录脏数据不崩）', () => {
    expect(measurementOf('byte').unitsOf({})).toBe(1);
  });
});
