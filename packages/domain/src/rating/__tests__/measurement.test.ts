/** 计量描述符（纯函数）：各定价单位的上界与实值——预扣与结算共用同一真相。 */
import { describe, expect, it } from 'vitest';
import { measurementOf } from '../measurement.js';

describe('计量描述符注册表', () => {
  it('token：不走单位轴（上界与实值恒 0——token 三价承载全部金额）', () => {
    const d = measurementOf('token');
    expect(d.unitsUpperBoundOf({ estInputTokens: 999 })).toBe(0);
    expect(d.unitsOf({}, { usage: { total_tokens: 999 } })).toBe(0);
  });

  it('image：n 倍数上界（缺省 1，钳 16）；结算取响应实值，空 data 兜底 n，最少 1', () => {
    const d = measurementOf('image');
    expect(d.unitsUpperBoundOf({})).toBe(1);
    expect(d.unitsUpperBoundOf({ n: 4 })).toBe(4);
    expect(d.unitsUpperBoundOf({ n: 99 })).toBe(16);
    expect(d.unitsOf({}, { data: [1, 2, 3] })).toBe(3);
    expect(d.unitsOf({ n: 2 }, { data: [] })).toBe(2);
    expect(d.unitsOf({})).toBe(1);
  });

  it('second：audioSeconds（文件字节推得，向上取整）优先于 duration 钳制（4-15s，缺省 6）', () => {
    const d = measurementOf('second');
    expect(d.unitsUpperBoundOf({ audioSeconds: 90.4 })).toBe(91);
    expect(d.unitsOf({ audioSeconds: 12.2 })).toBe(13);
    expect(d.unitsUpperBoundOf({ audioSeconds: 0 })).toBe(6); // 非法秒 → duration 口径
    expect(d.unitsUpperBoundOf({})).toBe(6);
    expect(d.unitsUpperBoundOf({ duration: 2 })).toBe(4);
    expect(d.unitsUpperBoundOf({ duration: 20 })).toBe(15);
  });

  it('char：输入字符数（码点口径——emoji 不被 UTF-16 拆半）', () => {
    const d = measurementOf('char');
    expect(d.unitsUpperBoundOf({ input: '你好世界' })).toBe(4);
    expect(d.unitsUpperBoundOf({ input: 'a😀b' })).toBe(3);
  });

  it('request：恒 1', () => {
    const d = measurementOf('request');
    expect(d.unitsUpperBoundOf({})).toBe(1);
    expect(d.unitsOf({})).toBe(1);
  });

  it('未知单位 → request 兜底', () => {
    const d = measurementOf('nonexistent');
    expect(d.unitsUpperBoundOf({})).toBe(1);
  });
});
