/**
 * 校准配置写（admin settings 面）：upsert + 审计。生效节奏 = 网关 TTL 缓存过期。
 * 值域由 billing 解析单一实现兜底（路由契约 zod 之外的二道防线——
 * ratio 值域/window 上限/矛盾态在此拒绝）。
 */
import {
  BILLING_CALIBRATION_KEY,
  parseCalibrationSetting,
  type CalibrationConfig,
} from '@tillgate/billing';
import { controlPlaneErrors } from '../../errors';
import type { Db } from '@tillgate/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { SettingsStore } from '../../ports/settings-store';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';

export interface UpdateBillingCalibrationDeps {
  readonly db: Db;
  readonly stores: { readonly settings: SettingsStore };
  readonly audit: AuditSink;
}

export interface UpdateBillingCalibrationInput {
  readonly ctx: ControlContext;
  readonly config: CalibrationConfig;
}

export async function updateBillingCalibration(
  deps: UpdateBillingCalibrationDeps,
  input: UpdateBillingCalibrationInput,
): Promise<{ config: CalibrationConfig }> {
  if (
    parseCalibrationSetting({
      window_ms: input.config.windowMs,
      cache_ratio: input.config.cacheRatio,
    }) === null
  ) {
    throw controlPlaneErrors.business('invalid_calibration_config', {
      config: JSON.stringify(input.config),
    });
  }
  const adminId = adminIdOf(input.ctx);
  await deps.stores.settings.updateBillingCalibration(deps.db, {
    config: input.config,
    adminId,
  });
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId,
    action: 'settings.billing_calibration',
    targetType: 'system_config',
    targetId: BILLING_CALIBRATION_KEY,
    detail: input.config as unknown as Record<string, unknown>,
  });
  return { config: input.config };
}
