/**
 * 回跳 next 参数白名单（防开放重定向）：登录验证码步、注册验证码步、OAuth
 * 回调三处复用。站内绝对路径 = `/` 开头且非 `//`；非法/缺省回落
 * /dashboard——与 client-api 契约 safeNext 同语义（app 不 import app 代码，
 * 等价实现单点在此）。
 */
export function safeNext(raw: string | undefined | null): string {
  if (typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//')) return raw;
  return '/dashboard';
}
