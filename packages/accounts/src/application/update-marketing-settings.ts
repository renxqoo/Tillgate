/**
 * 拉新参数写(管理面唯一入口;PUT /v1/marketing/settings):域校验
 * (非负/比例 ≤1/精度)→ 单语句 upsert returning(避免两往返)→ 同事务审计。
 * 生效语义:下一动作生效、历史不重算。
 */
import { runTx } from '@tillgate/db';
import { AccountsErrors } from '../domain/errors.js';
import { validateMarketingPatch, type MarketingSettingsPatch } from '../domain/marketing.js';
import type { MarketingSettingsRecord } from '../ports/account-store.js';
import type { UseCaseContext } from './context.js';

export async function updateMarketingSettings(
  ctx: UseCaseContext,
  input: { patch: MarketingSettingsPatch; adminId: number | null },
): Promise<MarketingSettingsRecord> {
  const invalid = validateMarketingPatch(input.patch);
  if (invalid !== null) {
    throw AccountsErrors.business('marketing_settings_invalid', { fields: invalid });
  }
  return runTx(
    ctx.db,
    async (tx) => {
      const settings = await ctx.store.upsertMarketingSettings(tx, {
        patch: input.patch,
        updatedBy: input.adminId,
      });
      await ctx.audit.record(tx, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'marketing.settings.update',
        targetType: 'marketing_settings',
        targetId: '1',
        detail: { patch: input.patch },
      });
      return settings;
    },
    ctx.txRetry,
  );
}
