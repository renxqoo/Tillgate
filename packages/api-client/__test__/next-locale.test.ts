/**
 * ./next locale 行为规格。
 * 内核向量与 @tokenlens/http __test__/locale.test.ts 锁步一致(D1 同语义副本约束);
 * outgoingLocale 为 BFF 出口封装(mock next/headers)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cookieStore, headerStore } = vi.hoisted(() => ({
  cookieStore: { get: vi.fn() },
  headerStore: { get: vi.fn() },
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => cookieStore),
  headers: vi.fn(async () => headerStore),
}));

import {
  DEFAULT_LOCALE,
  LOCALES,
  htmlLang,
  isLocale,
  outgoingLocale,
  parseAcceptLanguage,
  resolveLocale,
} from '../src/next/locale';

beforeEach(() => {
  cookieStore.get.mockReset();
  headerStore.get.mockReset();
});

describe('parseAcceptLanguage(http locale.test 同向量)', () => {
  it.each([
    ['zh-CN,zh;q=0.9,en;q=0.8', 'zh'],
    ['en-US,en;q=0.9', 'en'],
    ['zh-TW,zh;q=0.9', 'zh'],
    ['fr-FR,fr;q=0.9,en;q=0.5', 'en'],
    ['en;q=0.3,zh-CN;q=0.9', 'zh'],
    ['', 'en'],
    [undefined, 'en'],
  ])('%s → %s', (header, expected) => {
    expect(parseAcceptLanguage(header)).toBe(expected);
  });
});

describe('resolveLocale:cookie 优先,其次请求头(http locale.test 同向量)', () => {
  it('合法 cookie 值直接命中(大小写/空白容错)', () => {
    expect(resolveLocale(' zh ', 'en-US,en;q=0.9')).toBe('zh');
    expect(resolveLocale('EN', undefined)).toBe('en');
  });
  it('非法/缺失 cookie → 走 Accept-Language', () => {
    expect(resolveLocale('fr', 'zh-CN,zh;q=0.9')).toBe('zh');
    expect(resolveLocale(undefined, undefined)).toBe('en');
  });
});

describe('词表与工具(http locale.test 同向量)', () => {
  it('LOCALES 闭集 en|zh,默认 en', () => {
    expect(LOCALES).toEqual(['en', 'zh']);
    expect(DEFAULT_LOCALE).toBe('en');
  });
  it('isLocale', () => {
    expect(isLocale('zh')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(isLocale(1)).toBe(false);
  });
  it('htmlLang:zh → zh-CN,en → en', () => {
    expect(htmlLang('zh')).toBe('zh-CN');
    expect(htmlLang('en')).toBe('en');
  });
});

describe('outgoingLocale:BFF 出口语言(cookie → 头 → en)', () => {
  it('cookie NEXT_LOCALE 命中即用', async () => {
    cookieStore.get.mockImplementation((name: string) =>
      name === 'NEXT_LOCALE' ? { value: 'zh' } : undefined,
    );
    headerStore.get.mockReturnValue('en-US,en;q=0.9');
    await expect(outgoingLocale()).resolves.toBe('zh');
  });
  it('无 cookie 走 accept-language;全空回落 en', async () => {
    cookieStore.get.mockReturnValue(undefined);
    headerStore.get.mockImplementation((name: string) =>
      name === 'accept-language' ? 'zh-CN,zh;q=0.9' : null,
    );
    await expect(outgoingLocale()).resolves.toBe('zh');

    headerStore.get.mockReturnValue(null);
    await expect(outgoingLocale()).resolves.toBe('en');
  });
  it('非请求上下文(SSG 构建等 cookies()/headers() 抛出)→ en 兜底', async () => {
    const { cookies, headers } = await import('next/headers');
    vi.mocked(cookies).mockRejectedValueOnce(new Error('outside request'));
    vi.mocked(headers).mockRejectedValueOnce(new Error('outside request'));
    await expect(outgoingLocale()).resolves.toBe('en');
  });
});
