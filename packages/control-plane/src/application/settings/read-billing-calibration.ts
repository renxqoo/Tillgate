/**
 * 校准调参读（admin settings 面）：未配置/值域异常回落缺省调参
 * （300s/0.9——D18 恒开形态，回落为开启态缺省；垃圾值的降级面是调参
 * 不是功能）。
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
