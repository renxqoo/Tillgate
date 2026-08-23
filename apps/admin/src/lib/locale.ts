/**
 * 前端 locale 常量（client-safe，app 自持）。
 *
 * D1 孪生口径（api-client ./next/locale.ts 头注同款）：api-client 的 locale 协商内核
 * 挂在 `./next` 子出口（含 next/headers，client 组件禁引）；本模块是 client 组件
 * （locale-switcher）所需的三常量的 app 侧副本——cookie 键名是与 BFF 的线协议，
 * 两侧同步演进（D1 已裁决该形态可接受：http 与 api-client 的 locale 内核即为先例孪生）。
 */
export const LOCALES = ['en', 'zh'] as const;
export type Locale = (typeof LOCALES)[number];

/** 前端语言 cookie 键（与 api-client ./next 的 LOCALE_COOKIE 同值线协议） */
export const LOCALE_COOKIE = 'NEXT_LOCALE';
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}
