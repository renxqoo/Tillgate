/**
 * 覆盖补面 II：formatters 全词表、list-query href、sidebar 路由契约、
 * i18n 配置装配、pager 数组参数、utils 分支。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fmtBalance,
  fmtCost,
  fmtDate,
  fmtDateTime,
  fmtInt,
  fmtPrice,
  msToHuman,
  unitWord,
} from '../src/lib/formatters';
import { firstParam, listHref } from '../src/lib/list-query';

import { mockCookieJar } from './harness';

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.doUnmock('next/headers');
  vi.doUnmock('next-intl/server');
});

describe('formatters 全词表（表驱动）', () => {
  it.each([
    ['fmtBalance 同 formatMoney 4 位截断', fmtBalance, ['12.34599'], '12.3459'],
    ['fmtCost 4 位截断', fmtCost, ['0.0001239'], '0.0001'],
    ['fmtPrice 原样十进制', fmtPrice, ['0.0001'], '0.0001'],
    ['fmtInt 取整字符串', fmtInt, ['1234567.6'], '1234568'],
  ] as const)('%s', (_name, fn, args, expected) => {
    expect((fn as (...a: string[]) => string)(...(args as unknown as string[]))).toBe(expected);
  });

  it.each([
    ['image', 'image', '张'],
    ['second', 'sec', '秒'],
    ['char', 'char', '字符'],
    ['request', 'request', '次'],
    [null, 'unit', '单位'],
  ] as const)('unitWord(%s) en=%s zh=%s', (unit, en, zh) => {
    expect(unitWord(unit, 'en')).toBe(en);
    expect(unitWord(unit, 'zh')).toBe(zh);
  });

  it('msToHuman 时间档位（秒/毫秒）', () => {
    expect(msToHuman(500)).toContain('ms');
    expect(msToHuman(61_000)).toContain('1');
  });

  it('fmtDate 只取日期；fmtDateTime 含日期', () => {
    expect(fmtDate('2026-08-23T10:11:12.000Z')).toMatch(/^\d{4}-\d{2}/);
    expect(fmtDateTime('2026-08-23T10:11:12.000Z')).toBeTruthy();
  });
});

describe('list-query href 构造', () => {
  it('保留筛选 + overrides 覆写；空值删除参数', () => {
    expect(listHref({ q: 'x', page: '1' }, { page: 3 })).toBe('?q=x&page=3');
    expect(listHref({ q: 'x' }, { q: '' })).toBe('');
    expect(listHref({ a: ['1', '2'] })).toBe('?a=1&a=2');
  });

  it('firstParam：数组取首个；空串=未传', () => {
    expect(firstParam(['a', 'b'])).toBe('a');
    expect(firstParam('')).toBeUndefined();
    expect(firstParam(undefined)).toBeUndefined();
  });
});

describe('i18n 配置装配（cookie → Accept-Language → messages 装载）', () => {
  it('zh cookie 命中时装载 zh 词表', async () => {
    vi.resetModules();
    const jar = mockCookieJar({ NEXT_LOCALE: 'zh' }).jar;
    vi.doMock('next/headers', () => ({
      cookies: async () => jar,
      headers: async () => new Map(),
    }));
    vi.doMock('next-intl/server', () => ({
      getRequestConfig: (fn: unknown) => fn,
    }));
    const load = (await import('../src/config/i18n-request')).default as () => Promise<{
      locale: string;
      messages: Record<string, unknown>;
    }>;
    const cfg = await load();
    expect(cfg.locale).toBe('zh');
    expect(Object.keys(cfg.messages).length).toBeGreaterThan(5);
  });

  it('无 cookie 时忽略 Accept-Language,回落中文(管理台内部面策略)', async () => {
    vi.resetModules();
    vi.doMock('next/headers', () => ({
      cookies: async () => mockCookieJar().jar,
      headers: async () => new Map([['accept-language', 'en-US,en;q=0.9']]),
    }));
    vi.doMock('next-intl/server', () => ({
      getRequestConfig: (fn: unknown) => fn,
    }));
    const load = (await import('../src/config/i18n-request')).default as () => Promise<{
      locale: string;
    }>;
    expect((await load()).locale).toBe('zh');
  });
});

describe('pager-href 数组参数保留', () => {
  it('数组值逐个 append 且翻页覆写', async () => {
    const { pagerHref } = await import('../src/lib/pager-href');
    expect(pagerHref({ status: ['0', '1'] }, 'page', 2)).toBe('?status=0&status=1&page=2');
  });
});

describe('utils formatCurrency 分支', () => {
  it('noDecimals/自定义币种', async () => {
    const { formatCurrency } = await import('../src/lib/utils');
    expect(formatCurrency(2000, { noDecimals: true })).toBe('$2,000');
    expect(formatCurrency(1, { currency: 'CNY', locale: 'zh-CN' })).toContain('1');
  });
});

describe('auth-url 数组与空值', () => {
  it('数组参数取首个；空串白名单值剥除', async () => {
    const { stripAuthParams } = await import('../src/lib/auth-url');
    expect(stripAuthParams('/login', { next: ['/a', '/b'], e: '' }, ['next'])).toBe(
      '/login?next=%2Fa',
    );
    expect(stripAuthParams('/login', {}, [])).toBeNull();
  });
});
