/**
 * 集成卡纯函数（无 React——可独立测试）：卡片次序/图标键/字段标签键/
 * 表单提交值的组装（write-only 语义：空值缺席、勾选清除提交 null）。
 */

/**
 * 独立卡渲染次序（管理面阅读序：防刷 → 支付）。SMTP 挂「邮箱验证码二次登录」卡；
 * OAuth 三键（base/github/google）合并为一张「OAuth 登录」组合卡（2026-08-25
 * 用户裁决：基地址是共享部署配置，不独立占卡）。
 */
export const INTEGRATION_CARD_ORDER = [
  'captcha.turnstile',
  'payment.epay',
  'payment.stripe',
] as const;

/** 卡片图标名（lucide 组件映射在 integration-card.tsx——此处纯数据） */
export const INTEGRATION_ICON: Record<string, string> = {
  'oauth.base': 'globe',
  'oauth.github': 'github',
  'oauth.google': 'chrome',
  'captcha.turnstile': 'shield',
  'payment.epay': 'wallet',
  'payment.stripe': 'card',
};

/**
 * 表单提交值组装：值非空 → set；空且勾选清除 → null；否则缺席（保持现值）。
 * 键名恒为 i18n 字段标签的尾段（settings.integrations.fields.<name>）。
 */
export function buildConfigPayload(
  fields: readonly string[],
  values: Readonly<Record<string, string>>,
  cleared: ReadonlySet<string>,
): Record<string, string | null> {
  const payload: Record<string, string | null> = {};
  for (const field of fields) {
    const value = (values[field] ?? '').trim();
    if (value.length > 0) payload[field] = value;
    else if (cleared.has(field)) payload[field] = null;
  }
  return payload;
}

/** 表单是否无变化（无设置值且无清除勾选——提交按钮禁用） */
export function payloadIsEmpty(payload: Record<string, string | null>): boolean {
  return Object.keys(payload).length === 0;
}

/** 掩码展示值：null = 未设置；'****…' 原样（服务端已掩码） */
export function maskedDisplay(value: string | null): string {
  return value ?? '';
}

/** i18n 键消毒：集成键含点（next-intl 键分隔符）——统一转下划线 */
export function i18nKey(key: string): string {
  return key.replace(/\./g, '_');
}
