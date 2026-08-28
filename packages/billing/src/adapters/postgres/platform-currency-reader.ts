/**
 * 平台币种启动读（装配根专用）：KV 未配置/形状异常回落缺省 CNY。
 * 写一次语义下进程内无需再读；读取失败不吞——币种是账本身份，猜错比拒启更糟。
 */
import { eq } from 'drizzle-orm';
import type { Db } from '@tillgate/db';
import { systemConfigs } from '@tillgate/db';
import {
  DEFAULT_PLATFORM_CURRENCY,
  PLATFORM_CURRENCY_KEY,
  parsePlatformCurrencySetting,
} from '../../application/billing/platform-currency.js';

export async function readPlatformCurrency(db: Db): Promise<string> {
  const row = await db.query.systemConfigs.findFirst({
    where: eq(systemConfigs.key, PLATFORM_CURRENCY_KEY),
    columns: { value: true },
  });
  return parsePlatformCurrencySetting(row?.value) ?? DEFAULT_PLATFORM_CURRENCY;
}
