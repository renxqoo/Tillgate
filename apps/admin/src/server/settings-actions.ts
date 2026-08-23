'use server';

import { adminApi } from './admin-api';

/** 计费时区读（null = 未配置，消费方回落缺省 Asia/Shanghai） */
export async function getBillingTimezoneAction(): Promise<{
  timezone: string | null;
  error?: string;
}> {
  try {
    return await adminApi().get('/v1/settings/billing-timezone');
  } catch {
    return { timezone: null, error: 'unavailable' };
  }
}

/** 计费时区写（IANA 名；后端域校验 + 审计）；失败抛错由 useActionResult 呈现 */
export async function updateBillingTimezoneAction(timezone: string): Promise<{ ok: true }> {
  await adminApi().put('/v1/settings/billing-timezone', { timezone });
  return { ok: true };
}
