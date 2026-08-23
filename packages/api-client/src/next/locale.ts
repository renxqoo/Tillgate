/**
 * Accept-Language 协商内核 + BFF 出口语言(仅 ./next 子入口导出)。
 *
 * D1 同语义副本:孪生实现在 @tokenlens/http/src/errors/locale.ts(发布闭包裁决,
 * 总纲 §7.3 顺序一;api-client 禁止依赖私有包)。两侧语义必须同步演进,
 * 测试向量与 http 包 locale.test.ts 锁步一致(IMPLEMENTATION §1.2)。
 *
 * 支持语言固定为 en | zh,默认英文。zh-CN/zh-TW/zh-HK 等全部归并为 zh,
 * en-* 归并为 en;其余语言不命中,回落默认。
 */
import { cookies, headers } from 'next/headers';

export const LOCALES = ['en', 'zh'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/**
 * 语言解析策略(app 级注入,缺省 = 完整协商:cookie → Accept-Language → en)。
 * 管理后台等内部面可注入 { honorAcceptLanguage: false, fallback: 'zh' }:
 * cookie 显式选择优先,其余一律中文(en 仅经语言切换器主动选择)。
 */
export interface LocaleResolution {
  /** 无 cookie 时是否跟随浏览器 Accept-Language(默认 true) */
  honorAcceptLanguage?: boolean;
  /** 协商不命中时的回落语言(默认英文) */
  fallback?: Locale;
}

/** 前端语言 cookie 键(与 next-intl 官方 routing 中间件同名) */
export const LOCALE_COOKIE = 'NEXT_LOCALE';
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** <html lang> 值:中文用 zh-CN(与简体书写地域一致),英文用 en */
export function htmlLang(locale: Locale): 'en' | 'zh-CN' {
  return locale === 'zh' ? 'zh-CN' : 'en';
}

/**
 * 解析 Accept-Language 头(RFC 9110 简化版):取 q 值最高的已支持语言;
 * q 解析失败按 1 处理;无命中回落默认英文。
 */
export function parseAcceptLanguage(
  header: string | null | undefined,
  fallback: Locale = DEFAULT_LOCALE,
): Locale {
  if (!header) return fallback;
  let best: { locale: Locale; q: number } | undefined;
  for (const part of header.split(',')) {
    const [tagRaw, ...params] = part.trim().split(';');
    const tag = tagRaw?.trim().toLowerCase();
    if (!tag) continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.trim().split('=');
      if (key?.toLowerCase() === 'q') {
        const parsed = Number.parseFloat(value ?? '');
        if (Number.isFinite(parsed)) q = Math.min(Math.max(parsed, 0), 1);
      }
    }
    const locale: Locale | undefined = tag.startsWith('zh')
      ? 'zh'
      : tag.startsWith('en')
        ? 'en'
        : undefined;
    if (locale && (!best || (q > best.q && q > 0))) best = { locale, q };
  }
  return best?.locale ?? fallback;
}

/**
 * 完整解析链:cookie 值优先,其次请求头自动识别(可关),最后回落默认英文。
 * opts 注入 app 级策略(见 LocaleResolution),缺省与历史行为完全一致。
 */
export function resolveLocale(
  cookieValue: string | null | undefined,
  acceptLanguage: string | null | undefined,
  opts: LocaleResolution = {},
): Locale {
  const { honorAcceptLanguage = true, fallback = DEFAULT_LOCALE } = opts;
  const fromCookie = cookieValue?.trim().toLowerCase();
  if (isLocale(fromCookie)) return fromCookie;
  if (!honorAcceptLanguage) return fallback;
  return parseAcceptLanguage(acceptLanguage, fallback);
}

/**
 * BFF 出口语言:与 UI 同源(cookie NEXT_LOCALE → 浏览器 Accept-Language → 默认英文,
 * 均可经 opts 重载),注入 accept-language 让 API 错误 message 语言与界面一致。
 * 非请求上下文(SSG 构建等)回落英文。
 */
export async function outgoingLocale(opts: LocaleResolution = {}): Promise<Locale> {
  const fallback = opts.fallback ?? DEFAULT_LOCALE;
  try {
    const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
    return resolveLocale(cookieStore.get(LOCALE_COOKIE)?.value, headerStore.get('accept-language'), opts);
  } catch {
    return fallback; // 非请求上下文(SSG 构建等):无入站 cookie/头可读
  }
}
