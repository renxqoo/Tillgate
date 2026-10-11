/**
 * 校准配置读（admin settings 面）：未配置/值域异常回落保守缺省
 * （enabled=false——fail-closed，绝不把垃圾值当开启放行收缩）。
 */
import { DEFAULT_CALIBRATION_CONFIG, type CalibrationConfig } from '@tillgate/billing';
import type { Db } from '@tillgate/db';
import type { SettingsStore } from '../../ports/settings-store';

export interface ReadBillingCalibrationDeps {
  readonly db: Db;
  readonly stores: { readonly settings: SettingsStore };
}

export async function readBillingCalibration(
  deps: ReadBillingCalibrationDeps,
): Promise<{ config: CalibrationConfig }> {
  return {
    config:
      (await deps.stores.settings.readBillingCalibration(deps.db)) ?? DEFAULT_CALIBRATION_CONFIG,
  };
}
