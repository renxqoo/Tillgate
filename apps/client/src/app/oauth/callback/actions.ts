'use server';

import { redirect } from 'next/navigation';
import { setSessionToken } from '@ai-gateway/api-client';

/** OAuth fragment token → BFF 会话 cookie（由回调页客户端调用） */
export async function completeOAuthAction(
  token: string,
  next?: string | null,
): Promise<{ error?: string }> {
  if (!token) return { error: '未收到登录凭证' };
  await setSessionToken(token);
  redirect(next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard');
}
