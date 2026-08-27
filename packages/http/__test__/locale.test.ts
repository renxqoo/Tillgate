import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  DEFAULT_LOCALE,
  LOCALES,
  isLocale,
  htmlLang,
  localeFromContext,
  parseAcceptLanguage,
  resolveLocale,
} from '../src/errors/locale';

/**
 * Accept-Language 协商内核。
 * 原则：en|zh 闭集、默认英文；zh 系与 en 系子标签归并；q 值比较；cookie 优先。
 */

describe('parseAcceptLanguage', () => {
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

describe('resolveLocale：cookie 优先，其次请求头', () => {
  it('合法 cookie 值直接命中（大小写/空白容错）', () => {
    expect(resolveLocale(' zh ', 'en-US,en;q=0.9')).toBe('zh');
    expect(resolveLocale('EN', null)).toBe('en');
  });
  it('非法/缺失 cookie → 走 Accept-Language', () => {
    expect(resolveLocale('fr', 'zh-CN,zh;q=0.9')).toBe('zh');
    expect(resolveLocale(null, null)).toBe('en');
  });
});

describe('词表与工具', () => {
  it('LOCALES 闭集 en|zh，默认 en', () => {
    expect(LOCALES).toEqual(['en', 'zh']);
    expect(DEFAULT_LOCALE).toBe('en');
  });
  it('isLocale', () => {
    expect(isLocale('zh')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(isLocale(1)).toBe(false);
  });
  it('htmlLang：zh → zh-CN，en → en', () => {
    expect(htmlLang('zh')).toBe('zh-CN');
    expect(htmlLang('en')).toBe('en');
  });
});

describe('localeFromContext', () => {
  it('从 Hono 上下文取 accept-language 协商结果', async () => {
    const app = new Hono();
    app.get('/locale', (c) => c.json({ locale: localeFromContext(c) }));
    const zh = await app.request('/locale', { headers: { 'accept-language': 'zh-TW' } });
    expect(((await zh.json()) as { locale: string }).locale).toBe('zh');
    const none = await app.request('/locale');
    expect(((await none.json()) as { locale: string }).locale).toBe('en');
  });
});
