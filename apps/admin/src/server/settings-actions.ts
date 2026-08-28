'use server';

import { getTranslations } from 'next-intl/server';
import { ApiError } from '@tillgate/api-client';

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

/** 计费时区写（IANA 名；后端域校验 + 审计）。失败在 action 内翻译成 error 字段——
 * Server Action 抛错会被 Next 脱敏成「unexpected response」整体弹错，不走此口径 */
export async function updateBillingTimezoneAction(timezone: string): Promise<{
  ok?: true;
  error?: string;
}> {
  const tc = await getTranslations('common');
  try {
    await adminApi().put('/v1/settings/billing-timezone', { timezone });
    return { ok: true };
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : tc('saveFailed') };
  }
}

// ---- 第三方集成动态配置 ----

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
 * totpCode = step-up 强制（服务端验证当前管理员验证器，未绑定者拒绝）。
 * 失败在 action 内翻译成 error 字段（ApiError.message）——Server Action 直接抛错
 * 会被 Next 脱敏成「unexpected response」弹错，错误细节到不了 toast */
export async function updateIntegrationAction(
  key: string,
  body: { totpCode: string; enabled?: boolean; config?: Record<string, string | null> },
): Promise<{ item?: IntegrationSettingItem; error?: string }> {
  const tc = await getTranslations('common');
  try {
    const item = await adminApi().put<IntegrationSettingItem>(
      `/v1/settings/integrations/${key}`,
      body,
    );
    return { item };
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : tc('saveFailed') };
  }
}

/** 注册送礼金额读（Turnstile 停用联动警告用） */
export async function getMarketingSignupGiftAction(): Promise<{ signupGiftAmount: string | null }> {
  try {
    const res = await adminApi().get<{ signupGiftAmount: string }>('/v1/marketing/settings');
    return { signupGiftAmount: res.signupGiftAmount ?? '0' };
  } catch {
    return { signupGiftAmount: null };
  }
}

/** SMTP 探针结果（成功/失败都是 200 探针结果；error 为传输层诊断如 EAUTH） */
export interface IntegrationProbeResult {
  ok: boolean;
  durationMs: number;
  error?: { code: string; message: string };
}

/**
 * SMTP 连通性测试（连接+认证校验，不发送邮件）。config = 弹窗当前填写值
 * （与保存同形三态；空 = 只测已保存配置）。失败在 action 内翻译成 error 字段。
 */
export async function testIntegrationAction(
  key: string,
  body: { config?: Record<string, string | null> },
): Promise<{ result?: IntegrationProbeResult; error?: string }> {
  const tc = await getTranslations('common');
  try {
    const result = await adminApi().post<IntegrationProbeResult>(
      `/v1/settings/integrations/${key}/test`,
      body,
    );
    return { result };
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : tc('saveFailed') };
  }
}

/** 透支地板全局默认读（未配置 = "0" 不透支） */
export async function getDebitFloorDefaultAction(): Promise<{
  floor: string;
  error?: string;
}> {
  try {
    return await adminApi().get<{ floor: string }>('/v1/settings/debit-floor-default');
  } catch {
    return { floor: '0', error: 'unavailable' };
  }
}

/** 透支地板全局默认写（即时生效;新钱包套用;存量需手动刷默认）。 */
export async function updateDebitFloorDefaultAction(floor: string): Promise<{
  ok?: true;
  error?: string;
}> {
  const tc = await getTranslations('common');
  try {
    await adminApi().put('/v1/settings/debit-floor-default', { floor } satisfies { floor: string });
    return { ok: true };
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : tc('saveFailed') };
  }
}

/** 存量批量刷默认地板（仅 default 来源;manual 永不覆盖）。 */
export async function applyDebitFloorDefaultAction(): Promise<
  { ok: true; applied: number; skipped: number } | { ok?: false; error: string }
> {
  const tc = await getTranslations('common');
  try {
    const res = await adminApi().post<{ applied: number; skipped: number; floor: string }>(
      '/v1/wallets/debit-floor/apply-default',
    );
    return { ok: true, applied: res.applied, skipped: res.skipped };
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : tc('actionFailed') };
  }
}

/** 预扣策略读（未配置 = full 全额保守预扣） */
export async function getBillingReservationAction(): Promise<{
  policy: { mode: 'full' | 'fixed'; amount?: string } | null;
  error?: string;
}> {
  try {
    const res = await adminApi().get<{ policy: { mode: 'full' | 'fixed'; amount?: string } }>(
      '/v1/settings/billing-reservation',
    );
    return { policy: res.policy };
  } catch {
    return { policy: null, error: 'unavailable' };
  }
}

/** 预扣策略写（网关 TTL 缓存内拾取;fixed 金额必须为正——与后端二道防线同口径） */
export async function updateBillingReservationAction(
  policy: { mode: 'full' } | { mode: 'fixed'; amount: string },
): Promise<{ ok?: true; error?: string }> {
  const tc = await getTranslations('common');
  if (policy.mode === 'fixed' && !/^\d{1,20}(?:\.\d{1,18})?$/.test(policy.amount)) {
    return { error: 'invalidAmount' };
  }
  if (policy.mode === 'fixed' && /^0+(?:\.0+)?$/.test(policy.amount)) {
    return { error: 'invalidAmount' };
  }
  try {
    await adminApi().put('/v1/settings/billing-reservation', policy);
    return { ok: true };
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : tc('saveFailed') };
  }
}

/** 单笔预估敞口上限读（未配置 = 1000） */
export async function getBillingReservationLimitAction(): Promise<{
  limit: string;
  error?: string;
}> {
  try {
    const res = await adminApi().get<{ limit: string }>('/v1/settings/billing-reservation-limit');
    return { limit: res.limit };
  } catch {
    return { limit: '1000', error: 'unavailable' };
  }
}

/** 单笔预估敞口上限写（正金额；网关 TTL 缓存内拾取） */
export async function updateBillingReservationLimitAction(limit: string): Promise<{
  ok?: true;
  error?: string;
}> {
  const tc = await getTranslations('common');
  if (!/^\d{1,20}(?:\.\d{1,18})?$/.test(limit) || /^0+(?:\.0+)?$/.test(limit)) {
    return { error: 'invalidAmount' };
  }
  try {
    await adminApi().put('/v1/settings/billing-reservation-limit', { limit } satisfies {
      limit: string;
    });
    return { ok: true };
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : tc('saveFailed') };
  }
}
