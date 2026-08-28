/**
 * 平台记账币种（system_configs KV 'platform_currency'）：**写一次配置**——
 * 账本按币种记账（wallet_accounts.currency + 全部金额），有账之后换币是带汇率
 * 换算的数据迁移而非配置；写入守卫 = 处女系统（无钱包行/渠道进货/用量记录）。
 * 各 app 装配根启动读一次（不可变期间无热读、无竞态）。
 */
export const PLATFORM_CURRENCY_KEY = 'platform_currency';

/** 缺省（迁移种子同值；KV 未配置时的回落——部署事实 CNY） */
export const DEFAULT_PLATFORM_CURRENCY = 'CNY';

interface PlatformCurrencyValue {
  currency?: unknown;
}

/** 值域解析：3 位大写字母 ISO 4217 形态（严格大写；非法 → null = 消费方回落缺省） */
export function parsePlatformCurrencySetting(raw: unknown): string | null {
  if (raw == null || typeof raw !== 'object') return null;
  const { currency } = raw as PlatformCurrencyValue;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return null;
  return currency;
}
