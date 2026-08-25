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

// ---- 第三方集成动态配置（docs/integration-settings/DESIGN.md §4.1）----

/** 集成设置项（GET 列表元素/PUT 响应；secret 字段为掩码回显） */
export interface IntegrationSettingItem {
  key: string;
  enabled: boolean;
  configured: boolean;
  config: Record<string, string | null>;
  secretsSet: string[];
  rotatedAt: string | null;
  updatedAt: string | null;
  updatedByAdminId: number | null;
}

/** 集成列表读（失败吞成 error——设置页降级展示，不整页失败） */
export async function getIntegrationSettingsAction(): Promise<{
  integrations: IntegrationSettingItem[];
  error?: string;
}> {
  try {
    const res = await adminApi().get<{ integrations: IntegrationSettingItem[] }>(
      '/v1/settings/integrations',
    );
    return { integrations: res.integrations };
  } catch {
    return { integrations: [], error: 'unavailable' };
  }
}

/** 集成更新（字段三态：缺席=保持 / null=清除 / 值=设置）；
 * totpCode = step-up 强制（ADR-0011——服务端验证当前管理员验证器，未绑定者拒绝） */
export async function updateIntegrationAction(
  key: string,
  body: { totpCode: string; enabled?: boolean; config?: Record<string, string | null> },
): Promise<IntegrationSettingItem> {
  return adminApi().put<IntegrationSettingItem>(`/v1/settings/integrations/${key}`, body);
}

/** 注册送礼金额读（Turnstile 停用联动警告用——DESIGN §5 D11） */
export async function getMarketingSignupGiftAction(): Promise<{ signupGiftAmount: string | null }> {
  try {
    const res = await adminApi().get<{ signupGiftAmount: string }>('/v1/marketing/settings');
    return { signupGiftAmount: res.signupGiftAmount ?? '0' };
  } catch {
    return { signupGiftAmount: null };
  }
}
