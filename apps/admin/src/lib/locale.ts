/**
 * 前端 locale 常量（client-safe，app 自持）。
 *
 * api-client 的 locale 协商内核挂在 `./next` 子出口（含 next/headers，client 组件禁引）；
 * 本模块是 client 组件（locale-switcher）所需的三常量的 app 侧副本（与 api-client
 * ./next/locale.ts 同口径）——cookie 键名是与 BFF 的线协议，两侧同步演进。
 */
export const LOCALES = ['en', 'zh'] as const;
export type Locale = (typeof LOCALES)[number];

/** 前端语言 cookie 键（与 api-client ./next 的 LOCALE_COOKIE 同值线协议） */
export const LOCALE_COOKIE = 'NEXT_LOCALE';
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}
