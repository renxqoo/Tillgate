'use server';

/**
 * OAuth 回调落地：client-api 经 URL fragment `#token=…` 回传会话 token
 * （不进日志/Referer），本 action 换成 HttpOnly cookie 并按 next 白名单跳转。
 */
import { redirect } from 'next/navigation';

import { setSessionToken } from '@tokenlens/api-client/next';

import { safeNext } from '../next-url';

export async function completeOAuthAction(token: string, next?: string | null): Promise<void> {
  await setSessionToken(token);
  redirect(safeNext(next));
}
