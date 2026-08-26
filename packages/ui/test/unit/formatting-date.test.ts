import { describe, expect, it } from 'vitest';

import { createDateFormatter } from '../../src/formatting/date';

const NOW = new Date('2026-08-23T12:00:00Z');

describe('createDateFormatter', () => {
  const en = createDateFormatter({ locale: 'en-US', timeZone: 'UTC' });

  it('formatDate: 中等日期样式', () => {
    expect(en.formatDate('2026-08-23T12:34:56Z')).toBe('Aug 23, 2026');
    expect(en.formatDate(0)).toBe('Jan 1, 1970');
  });

  it('formatDateTime: 日期 + 时间', () => {
    // JSC 的 en-US 日期时间分隔符是 ' at '(node ICU 为 ', ')
    expect(en.formatDateTime(new Date('2026-08-23T12:34:56Z'))).toBe('Aug 23, 2026 at 12:34:56 PM');
  });

  it('timeZone 注入生效', () => {
    const shanghai = createDateFormatter({
      locale: 'en-US',
      timeZone: 'Asia/Shanghai',
    });
    expect(shanghai.formatDateTime('2026-08-23T12:34:56Z')).toBe('Aug 23, 2026 at 8:34:56 PM');
  });

  it('非法日期输入抛错', () => {
    expect(() => en.formatDate('not-a-date')).toThrow(/invalid date/i);
    expect(() => en.formatRelative(new Date('nope'))).toThrow(/invalid date/i);
  });

  describe('formatRelative 分桶', () => {
    const rel = (iso: string) => en.formatRelative(iso, NOW);

    it('秒级', () => {
      expect(rel('2026-08-23T11:59:30Z')).toBe('30 seconds ago');
      expect(rel('2026-08-23T12:00:10Z')).toBe('in 10 seconds');
    });

    it('分钟级(45s/90s 阈值)', () => {
      expect(rel('2026-08-23T11:59:15Z')).toBe('1 minute ago');
      expect(rel('2026-08-23T11:50:00Z')).toBe('10 minutes ago');
    });

    it('小时级(45m/90m 阈值)', () => {
      expect(rel('2026-08-23T10:30:00Z')).toBe('1 hour ago');
      expect(rel('2026-08-23T09:00:00Z')).toBe('3 hours ago');
    });

    it('天级(numeric:auto 产出 yesterday/tomorrow)', () => {
      expect(rel('2026-08-22T06:00:00Z')).toBe('yesterday');
      expect(rel('2026-08-25T06:00:00Z')).toBe('in 2 days');
    });

    it('超过 7 天回退绝对日期', () => {
      expect(rel('2026-08-15T00:00:00Z')).toBe('Aug 15, 2026');
      expect(rel('2026-06-01T00:00:00Z')).toBe('Jun 1, 2026');
    });
  });

  it('now 缺省取当前时间(不抛错即可)', () => {
    expect(typeof en.formatRelative(Date.now() - 5000)).toBe('string');
  });
});
