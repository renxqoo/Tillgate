/**
 * Accept-Language 协商内核（错误出口本地化 / BFF 转发共用，单一实现；v1 语义原样移植）。
 *
 * 支持语言固定为 en | zh，默认英文。zh-CN/zh-TW/zh-HK 等全部归并为 zh，
 * en-* 归并为 en；其余语言不命中，回落默认。
 */
import type { Context } from 'hono';

export const LOCALES = ['en', 'zh'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** 前端语言 cookie 键（与 next-intl 官方 routing 中间件同名） */
export const LOCALE_COOKIE = 'NEXT_LOCALE';
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** <html lang> 值：中文用 zh-CN（与简体书写地域一致），英文用 en */
export function htmlLang(locale: Locale): 'en' | 'zh-CN' {
  return locale === 'zh' ? 'zh-CN' : 'en';
}

/** 单条目 q 值解析：多个 q 参数后者胜；解析失败按 1 处理，夹取 [0,1] */
function entryQ(params: string[]): number {
  let q = 1;
  for (const param of params) {
    const [key, value] = param.trim().split('=');
    if (key?.toLowerCase() === 'q') {
      const parsed = Number.parseFloat(value ?? '');
      if (Number.isFinite(parsed)) q = Math.min(Math.max(parsed, 0), 1);
    }
  }
  return q;
}

/** 语言标签归并：zh* → zh，en* → en，其余不命中 */
function localeOfTag(tag: string): Locale | undefined {
  if (tag.startsWith('zh')) return 'zh';
  if (tag.startsWith('en')) return 'en';
  return undefined;
}

/**
 * 解析 Accept-Language 头（RFC 9110 简化版）：取 q 值最高的已支持语言；
 * q 解析失败按 1 处理；无命中回落默认英文。
 * 与 @tillgate/api-client/src/next/locale.ts 孪生(D1 同语义副本),两侧锁步演进。
 */
export function parseAcceptLanguage(header: string | null | undefined): Locale {
  if (!header) return DEFAULT_LOCALE;
  let best: { locale: Locale; q: number } | undefined;
  for (const part of header.split(',')) {
    const [tagRaw, ...params] = part.trim().split(';');
    const tag = tagRaw?.trim().toLowerCase();
    if (!tag) continue;
    const q = entryQ(params);
    const locale = localeOfTag(tag);
    if (locale && (!best || (q > best.q && q > 0))) best = { locale, q };
  }
  return best?.locale ?? DEFAULT_LOCALE;
}

/** 完整解析链：cookie 值优先，其次请求头自动识别，最后默认英文 */
export function resolveLocale(
  cookieValue: string | null | undefined,
  acceptLanguage: string | null | undefined,
): Locale {
  const fromCookie = cookieValue?.trim().toLowerCase();
  if (isLocale(fromCookie)) return fromCookie;
  return parseAcceptLanguage(acceptLanguage);
}

/** 从请求上下文协商出口语言（Accept-Language → en|zh，默认英文） */
export function localeFromContext(c: Context): Locale {
  return parseAcceptLanguage(c.req.header('accept-language'));
}
