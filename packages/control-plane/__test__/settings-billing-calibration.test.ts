/**
 * 校准 settings 用例测试（对照 settings-billing-reservation 同族）：
 * 读取回落保守缺省（fail-closed）/ 写入值域二道防线 / 审计动作。
 */
import { describe, expect, it } from 'vitest';
import type { Db } from '@tillgate/db';
import type { CalibrationConfig } from '@tillgate/billing';
import type { SettingsStore } from '../src/ports/settings-store';
import { readBillingCalibration } from '../src/application/settings/read-billing-calibration';
import {
  updateBillingCalibration,
  type UpdateBillingCalibrationDeps,
} from '../src/application/settings/update-billing-calibration';
import { adminCtx, createMemoryAudit } from './memory';

const VALID: CalibrationConfig = {
  enabled: true,
  windowMs: 300_000,
  cacheRatio: 0.9,
  userSide: false,
};

function makeDeps(stored: CalibrationConfig | null) {
  const writes: CalibrationConfig[] = [];
  const store = {
    async readBillingCalibration() {
      return stored;
    },
    async updateBillingCalibration(_db: unknown, input: { config: CalibrationConfig }) {
      writes.push(input.config);
    },
  } as unknown as SettingsStore;
  const audit = createMemoryAudit();
  const deps = {
    db: {} as Db,
    stores: { settings: store },
    audit: audit.sink,
  } satisfies UpdateBillingCalibrationDeps;
  return { deps, audit, writes };
}

describe('readBillingCalibration', () => {
  it('未配置 → 回落保守缺省（enabled=false fail-closed）', async () => {
    await expect(readBillingCalibration(makeDeps(null).deps)).resolves.toEqual({
      config: { enabled: false, windowMs: 300_000, cacheRatio: 0.9, userSide: false },
    });
  });

  it('已配置 → 原样返回', async () => {
    await expect(readBillingCalibration(makeDeps(VALID).deps)).resolves.toEqual({
      config: VALID,
    });
  });
});

describe('updateBillingCalibration', () => {
  it('合法配置写入 + 审计 settings.billing_calibration', async () => {
    const { deps, audit, writes } = makeDeps(null);
    await updateBillingCalibration(deps, { ctx: adminCtx(), config: VALID });
    expect(writes).toEqual([VALID]);
    expect(audit.entries.at(-1)).toMatchObject({
      action: 'settings.billing_calibration',
      targetType: 'system_config',
    });
  });

  it.each([
    ['ratio>1', { ...VALID, cacheRatio: 1.5 }],
    ['ratio 0', { ...VALID, cacheRatio: 0 }],
    ['window 超上限', { ...VALID, windowMs: 3_600_001 }],
    ['window 非整数', { ...VALID, windowMs: 1.5 }],
    ['矛盾态：关用户侧开', { ...VALID, enabled: false, userSide: true }],
  ])('值域二道防线拒绝 %s（不写库）', async (_name, config) => {
    const { deps, writes } = makeDeps(null);
    await expect(
      updateBillingCalibration(deps, { ctx: adminCtx(), config: config as CalibrationConfig }),
    ).rejects.toMatchObject({ code: 'control_plane.invalid_calibration_config' });
    expect(writes).toEqual([]);
  });
});
