/**
 * 计费时区写（admin settings 面）：IANA 合法性结构性校验 + upsert + 审计。
 * 生效节奏 = 消费方缓存 TTL（网关默认 60s）；变更只影响其后新请求的选档，
 * 历史账单行自带 pricing_window 标签与价格快照，无需重算。
 */
import { controlPlaneErrors } from '../../errors';
import type { Db } from '@tillgate/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { SettingsStore } from '../../ports/settings-store';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';

export interface UpdateBillingTimezoneDeps {
  readonly db: Db;
  readonly stores: { readonly settings: SettingsStore };
  readonly audit: AuditSink;
}

export interface UpdateBillingTimezoneInput {
  readonly ctx: ControlContext;
  readonly timezone: string;
}

function assertIANATimezone(timezone: string): void {
  try {
    // 构造即探测:非法时区抛 RangeError;作函数调用返回实例(等价 new,规避副作用 new)
    Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw controlPlaneErrors.business('invalid_billing_timezone', { timezone });
  }
}

export async function updateBillingTimezone(
  deps: UpdateBillingTimezoneDeps,
  input: UpdateBillingTimezoneInput,
): Promise<{ timezone: string }> {
  assertIANATimezone(input.timezone);
  const adminId = adminIdOf(input.ctx);
  await deps.stores.settings.updateBillingTimezone(deps.db, {
    timezone: input.timezone,
    adminId,
  });
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId,
    action: 'settings.billing_timezone',
    targetType: 'system_config',
    targetId: 'billing_timezone',
    detail: { timezone: input.timezone },
  });
  return { timezone: input.timezone };
}
