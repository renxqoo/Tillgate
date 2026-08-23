/**
 * 纯前端工具测试：URL 列表状态（list-query）、分页 href、金额 tone、
 * 登录 URL 白名单清理、formatters 字符串精确语义（不过 Number）。
 */
import { describe, expect, it } from 'vitest';

import { stripAuthParams } from '../src/lib/auth-url';
import {
  fmtDateTime,
  formatMoney,
  formatPoints,
  fmtPrice,
  msToHuman,
  toPoints,
  unitWord,
} from '../src/lib/formatters';
import { moneyText, numericText } from '../src/lib/forms';
import { pagerHref } from '../src/lib/pager-href';
import { signedAmountTone } from '../src/lib/money-tone';
import { parseListSearchParams } from '../src/lib/list-query';

describe('formatters（numeric 字符串直读，零 IEEE-754）', () => {
  it('formatMoney：4 位小数截断（不四舍五入）+ 千分位', () => {
    expect(formatMoney('49.999990000000000000')).toBe('49.9999');
    expect(formatMoney('1234567.891')).toBe('1234567.8910');
    expect(formatMoney('0')).toBe('0.0000');
  });

  it('formatMoney：负数与 null/undefined/垃圾形状不抛', () => {
    expect(formatMoney('-1.5')).toBe('-1.5000');
    expect(formatMoney(null)).toBe('0.0000');
    expect(formatMoney('abc')).toBe('0.0000');
  });

  it('formatPoints：元转点（×100）展示', () => {
    expect(toPoints('1')).toBe(100);
    expect(formatPoints('1.5')).toBe('150.00');
  });

  it('fmtPrice / msToHuman / fmtDateTime 基线', () => {
    expect(fmtPrice('0.0001')).toBe('0.0001');
    expect(msToHuman(1500)).toContain('1.5');
    expect(fmtDateTime('2026-08-23T00:00:00.000Z')).toMatch(/2026/);
    expect(fmtDateTime(null)).toBe('—');
  });

  it('unitWord：计价单位词表（en/zh 双语）', () => {
    expect(unitWord('image')).toBe('image');
    expect(unitWord('image', 'zh')).toBe('张');
    expect(unitWord(null)).toBe('unit');
  });
});

describe('forms schema（金额编辑期保持字符串）', () => {
  it('moneyText：拒绝负数/零（按配置）与垃圾形状；合法十进制通过', () => {
    expect(moneyText().safeParse('12.34').success).toBe(true);
    expect(moneyText().safeParse('-1').success).toBe(false);
    expect(moneyText({ allowNegative: true }).safeParse('-1').success).toBe(true);
    expect(moneyText({ allowZero: false }).safeParse('0').success).toBe(false);
    expect(moneyText().safeParse('1e3').success).toBe(false);
  });

  it('numericText：空串=必填错误；数字串 transform 为 number', () => {
    const r = numericText().safeParse('42');
    expect(r.success && r.data).toBe(42);
    expect(numericText().safeParse('').success).toBe(false);
  });
});

describe('list-query URL 状态', () => {
  it('parseListSearchParams：page/limit 钳位与垃圾输入兜底', () => {
    const q = parseListSearchParams({ page: '3', sort_by: 'createdAt', order: 'asc', q: 'x' });
    expect(q).toEqual({ q: 'x', page: 3, sortBy: 'createdAt', order: 'asc' });
    expect(parseListSearchParams({ page: 'abc' }).page).toBe(1);
    expect(parseListSearchParams({ order: 'weird' }).order).toBe('desc');
  });
});

describe('pager-href（保留筛选、独立页键）', () => {
  it('翻页保留现有参数并覆写 pageKey；空值参数跳过', () => {
    expect(pagerHref({ q: 'x', status: '', page: '1' }, 'page', 3)).toBe('?q=x&page=3');
    expect(pagerHref({ tpage: '1' }, 'tpage', 2)).toBe('?tpage=2');
  });
});

describe('money-tone（语言相关的正负配色）', () => {
  it('zh 红涨绿跌；en 相反；零/无效不着色', () => {
    expect(signedAmountTone('1', 'zh')).toContain('destructive');
    expect(signedAmountTone('-1', 'zh')).toContain('emerald');
    expect(signedAmountTone('1', 'en')).toContain('emerald');
    expect(signedAmountTone('0', 'en')).toBe('');
    expect(signedAmountTone('x', 'en')).toBe('');
  });
});

describe('auth-url（登录页查询参数白名单）', () => {
  it('白名单外参数剥除（含凭证误传）；无脏参返回 null 不重定向', () => {
    expect(stripAuthParams('/login', { email: 'a@b.c', next: '/dashboard' }, ['next'])).toBe(
      '/login?next=%2Fdashboard',
    );
    expect(stripAuthParams('/login', { next: '/x' }, ['next'])).toBeNull();
  });
});
