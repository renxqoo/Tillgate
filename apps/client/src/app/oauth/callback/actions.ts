'use server';

import { redirect } from 'next/navigation';
import { setSessionToken } from '@ai-gateway/api-client';
import { getTranslations } from 'next-intl/server';

/** OAuth fragment token → BFF 会话 cookie（由回调页客户端调用） */
export async function completeOAuthAction(
  token: string,
  next?: string | null,
): Promise<{ error?: string }> {
  const t = await getTranslations('auth');
  if (!token) return { error: t('noTokenError') };
  await setSessionToken(token);
  redirect(next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard');
}
