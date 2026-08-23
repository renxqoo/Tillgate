/**
 * 展示口径配置（客户端可读——NEXT_PUBLIC_ 前缀保证 SSR 与浏览器 bundle 同值，
 * 避免水合不一致）。默认与后端 CLIENT_USAGE_TZ 同源（北京时间日界）。
 */
export const DISPLAY_TZ = process.env.NEXT_PUBLIC_DISPLAY_TZ ?? 'Asia/Shanghai';

/** 钱包默认展示币种（MeInfo.accounts 多账户时按各自 currency 渲染） */
export const DEFAULT_CURRENCY = 'CNY';
