import type { PolicyForm } from './routing-content-types';
import { ROUTING_FORM_BOUNDS } from './routing-bounds';

/** 策略段取值（unknown 收窄） */
function seg(policy: Record<string, unknown> | undefined, key: string): Record<string, unknown> {
  return (policy?.[key] ?? {}) as Record<string, unknown>;
}

export function formOf(policy: Record<string, unknown> | undefined): PolicyForm {
  const affinity = seg(seg(policy, 'scorers'), 'cacheAffinity');
  const watermark = seg(seg(policy, 'scorers'), 'budgetWatermark');
  const penalty = seg(policy, 'penalty');
  const wait = seg(policy, 'wait');
  return {
    cacheAffinityEnabled: affinity.enabled === true,
    cacheBoost: String(affinity.boost ?? 3),
    budgetWatermarkEnabled: watermark.enabled !== false,
    softRatio: String(watermark.softRatio ?? 0.2),
    sameChannelMaxRetries: String(seg(policy, 'retry').sameChannelMaxRetries ?? 3),
    rateLimitBaseMs: String(penalty.rateLimitBaseMs ?? 2000),
    rateLimitMaxMs: String(penalty.rateLimitMaxMs ?? 60_000),
    quotaMs: String(penalty.quotaMs ?? 1_800_000),
    conditionalBypass: penalty.conditionalBypass !== false,
    modelDeadThreshold: String(seg(policy, 'modelDead').failureThreshold ?? 3),
    waitEnabled: wait.enabled !== false,
    maxWaitMs: String(wait.maxWaitMs ?? 2000),
  };
}

/** 校验失败形态（结构化——编排器按 key 取本地化文案；bounds 见 routing-bounds.ts） */
export type FormValidationError =
  | { key: 'invalidNumber'; field: string; min: number; max: number }
  | { key: 'notInteger'; field: string }
  | { key: 'baseExceedsMax' };

/** 数值字段：表单键 → (i18n 字段标签键, schema JSON 路径段)——validateForm 与 bounds 的登记面 */
const NUMERIC_FIELDS: ReadonlyArray<{
  form: keyof typeof ROUTING_FORM_BOUNDS;
  label: string;
}> = [
  { form: 'cacheBoost', label: 'boost' },
  { form: 'softRatio', label: 'softRatio' },
  { form: 'sameChannelMaxRetries', label: 'retries' },
  { form: 'rateLimitBaseMs', label: 'penaltyBase' },
  { form: 'rateLimitMaxMs', label: 'penaltyMax' },
  { form: 'quotaMs', label: 'quotaCooldown' },
  { form: 'modelDeadThreshold', label: 'modelDeadThreshold' },
  { form: 'maxWaitMs', label: 'maxWait' },
];

/**
 * 数值字段显式校验（null = 通过）：非有限值/越下界/越上界 → invalidNumber（携带
 * bounds 区间供文案渲染）；整数约束违反 → notInteger。边界单一真相 =
 * ROUTING_FORM_BOUNDS（routingPolicySchema 镜像，对照测试锁定）。
 */
export function validateForm(form: PolicyForm): FormValidationError | null {
  for (const { form: key, label } of NUMERIC_FIELDS) {
    const bound = ROUTING_FORM_BOUNDS[key];
    const value = Number(form[key]);
    if (!Number.isFinite(value) || value < bound.min || value > bound.max) {
      return { key: 'invalidNumber', field: label, min: bound.min, max: bound.max };
    }
    if (bound.integer && !Number.isInteger(value)) {
      return { key: 'notInteger', field: label };
    }
  }
  if (Number(form.rateLimitBaseMs) > Number(form.rateLimitMaxMs)) {
    return { key: 'baseExceedsMax' };
  }
  return null;
}

/** 表单 → 策略体（routingPolicySchema 形状；version 由服务端行级自增——不进 JSONB） */
export function buildPolicy(form: PolicyForm): Record<string, unknown> {
  return {
    scorers: {
      cacheAffinity: {
        enabled: form.cacheAffinityEnabled,
        boost: Number(form.cacheBoost),
        ttlMs: 300_000,
        prefixChars: 4_096,
      },
      budgetWatermark: {
        enabled: form.budgetWatermarkEnabled,
        softRatio: Number(form.softRatio),
      },
    },
    retry: { sameChannelMaxRetries: Number(form.sameChannelMaxRetries) },
    penalty: {
      rateLimitBaseMs: Number(form.rateLimitBaseMs),
      rateLimitMaxMs: Number(form.rateLimitMaxMs),
      quotaMs: Number(form.quotaMs),
      conditionalBypass: form.conditionalBypass,
    },
    modelDead: {
      failureThreshold: Number(form.modelDeadThreshold),
      ttlMs: 60_000,
      windowMs: 300_000,
    },
    wait: { enabled: form.waitEnabled, maxWaitMs: Number(form.maxWaitMs) },
  };
}
