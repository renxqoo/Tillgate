'use server';

/**
 * TOTP 绑定三动作（安全设置页）:enroll 出二维码（服务端渲染 SVG——qrcode 依赖
 * 不进客户端包）→ confirm 验码换恢复码（仅此一次返回）→ disable 须持有效码。
 * 会话经 adminApi() BFF 注入；失败统一 {error} 结构化返回。
 */
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import QRCode from 'qrcode';

import { ApiError } from '@tillgate/api-client';

import { adminApi } from './admin-api';

export interface TotpEnrollView {
  secret: string;
  otpauthUrl: string;
  qrSvg: string;
}

export async function enrollTotpAction(): Promise<{ enrollment?: TotpEnrollView; error?: string }> {
  const t = await getTranslations('settings.totp');
  try {
    const result = await adminApi().post<{ secret: string; otpauthUrl: string }>(
      '/v1/me/totp/enroll',
    );
    const qrSvg = await QRCode.toString(result.otpauthUrl, {
      type: 'svg',
      margin: 1,
      width: 220,
      color: { dark: '#09090b', light: '#ffffff' },
    });
    return { enrollment: { ...result, qrSvg } };
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : t('fetchError') };
  }
}

export async function confirmTotpAction(
  code: string,
): Promise<{ recoveryCodes?: string[]; error?: string }> {
  const t = await getTranslations('settings.totp');
  if (!/^([0-9]{6}|[A-Z0-9]{10})$/.test(code)) return { error: t('invalidCode') };
  try {
    const result = await adminApi().post<{ recoveryCodes: string[] }>('/v1/me/totp/confirm', {
      code,
    });
    revalidatePath('/dashboard/settings');
    return { recoveryCodes: result.recoveryCodes };
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : t('fetchError') };
  }
}

export async function disableTotpAction(code: string): Promise<{ ok?: boolean; error?: string }> {
  const t = await getTranslations('settings.totp');
  if (!/^([0-9]{6}|[A-Z0-9]{10})$/.test(code)) return { error: t('invalidCode') };
  try {
    await adminApi().post('/v1/me/totp/disable', { code });
    revalidatePath('/dashboard/settings');
    return { ok: true };
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : t('fetchError') };
  }
}
