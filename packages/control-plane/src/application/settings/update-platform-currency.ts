/**
 * 平台币种写（admin settings 面）——**写一次配置**：账本按币种记账，存在任何
 * 钱包行 / 渠道进货 / 用量记录即锁定（409 platform_currency_locked）。
 * 换币是带汇率换算的数据迁移，不是运营配置；守卫在用例内以三表存在性判定。
 */
import { PLATFORM_CURRENCY_KEY, parsePlatformCurrencySetting } from '@tillgate/billing';
import { controlPlaneErrors } from '../../errors';
import type { Db } from '@tillgate/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { SettingsStore } from '../../ports/settings-store';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';

export interface UpdatePlatformCurrencyDeps {
  readonly db: Db;
  readonly stores: { readonly settings: SettingsStore };
  readonly audit: AuditSink;
  /** 处女系统探针：任一事实表存在行 → 不可换币（装配注入查询；纯函数可测） */
  readonly systemVirgin: (db: Db) => Promise<boolean>;
}

export interface UpdatePlatformCurrencyInput {
  readonly ctx: ControlContext;
  readonly currency: string;
}

export async function updatePlatformCurrency(
  deps: UpdatePlatformCurrencyDeps,
  input: UpdatePlatformCurrencyInput,
): Promise<{ currency: string }> {
  if (parsePlatformCurrencySetting({ currency: input.currency }) === null) {
    throw controlPlaneErrors.business('invalid_platform_currency', { currency: input.currency });
  }
  if (!(await deps.systemVirgin(deps.db))) {
    throw controlPlaneErrors.business('platform_currency_locked', {
      hint: 'ledger/channel-funds/usage rows exist; currency change requires an explicit migration',
    });
  }
  const adminId = adminIdOf(input.ctx);
  await deps.stores.settings.updatePlatformCurrency(deps.db, {
    currency: input.currency,
    adminId,
  });
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId,
    action: 'settings.platform_currency',
    targetType: 'system_config',
    targetId: PLATFORM_CURRENCY_KEY,
    detail: { currency: input.currency },
  });
  return { currency: input.currency };
}
