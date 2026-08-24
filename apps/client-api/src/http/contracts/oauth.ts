/**
 * OAuth 契约：provider 路径参数词表（github/google）。
 */
import { z } from 'zod';

export const providerParamSchema = z.object({
  provider: z.enum(['github', 'google']),
});

/** state cookie 名（双提交比对：cookie ↔ query） */
export const OAUTH_STATE_COOKIE = 'tl_oauth_state';

/** 回跳上下文归一：站内绝对路径（防开放重定向）；非法回落 /dashboard（v1 口径） */
export function safeNext(raw?: string | undefined | null): string {
  if (typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//')) return raw;
  return '/dashboard';
}
