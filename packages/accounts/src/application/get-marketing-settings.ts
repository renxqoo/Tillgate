/** 拉新参数读(worker 佣金循环每 tick 读现值;管理面 GET 同源) */
import type { MarketingSettingsRecord } from '../ports/account-store.js';
import type { UseCaseContext } from './context.js';

export function getMarketingSettings(ctx: UseCaseContext): Promise<MarketingSettingsRecord> {
  return ctx.store.getMarketingSettings(ctx.db);
}
