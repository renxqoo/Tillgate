'use server';

/**
 * 管理员自助改密（POST /v1/me/password）。服务端成功即推进 admin realm 失效线
 * ——**旧会话全部失效**（含本浏览器）,必须立即用响应的新 token 换 BFF cookie,
 * 否则改密成功等于把自己登出。
 */
import { getTranslations } from 'next-intl/server';

import { ApiError } from '@tokenlens/api-client';
import { setAdminSessionToken } from '@tokenlens/api-client/next';

import { validatePasswordChange, type PasswordChangeInput } from '@/features/auth/password-policy';

import { adminApi } from './admin-api';

export async function changeMyPasswordAction(
  input: PasswordChangeInput,
): Promise<{ error?: string }> {
  const t = await getTranslations('changePassword');
  const invalid = validatePasswordChange(input);
  if (invalid != null) return { error: t(`errors.${invalid}`) };
  try {
    const { token } = await adminApi().changeMyPassword({
      oldPassword: input.oldPassword,
      newPassword: input.newPassword,
    });
    await setAdminSessionToken(token);
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : t('fetchError') };
  }
}
