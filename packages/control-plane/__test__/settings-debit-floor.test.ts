/**
 * 透支地板默认 settings 用例：读取回落 "0"（fail-closed）/ 写入值域二道防线 /
 * emitAudit 动作与 best-effort 降级（sink 故障不反噬已提交业务）。
 * 适配器（postgres upsert）由 admin-api 契约 + e2e 真 PG 覆盖。
 */
import { describe, expect, it } from 'vitest';
import type { Db } from '@tillgate/db';
import type { SettingsStore } from '../src/ports/settings-store';
import { readDebitFloorDefault } from '../src/application/settings/read-debit-floor-default';
import {
  updateDebitFloorDefault,
  type UpdateDebitFloorDefaultDeps,
} from '../src/application/settings/update-debit-floor-default';
import { adminCtx, createMemoryAudit } from './memory';

interface StoreLog {
  reads: number;
  writes: { floor: string; adminId: number | null }[];
}

function makeDeps(stored: string | null, log: StoreLog = { reads: 0, writes: [] }) {
  const store: SettingsStore = {
    async readBillingTimezone() {
      return null;
    },
    async updateBillingTimezone() {},
    async readDebitFloorDefault() {
      log.reads += 1;
      return stored;
    },
    async updateDebitFloorDefault(_db, input) {
      log.writes.push(input);
    },
    async readBillingReservationPolicy() {
      return null;
    },
    async updateBillingReservationPolicy() {},
    async readBillingReservationLimit() {
      return null;
    },
    async updateBillingReservationLimit() {},
    async readPlatformCurrency() {
      return null;
    },
    async updatePlatformCurrency() {},
  };
  const audit = createMemoryAudit();
  const deps = {
    db: {} as Db,
    stores: { settings: store },
    audit: audit.sink,
  } satisfies UpdateDebitFloorDefaultDeps;
  return { deps, audit, log };
}

describe('readDebitFloorDefault', () => {
  it('未配置/形状异常 → 回落 "0"（不透支 fail-closed）', async () => {
    await expect(readDebitFloorDefault(makeDeps(null).deps)).resolves.toEqual({ floor: '0' });
  });

  it('已配置 → 原样返回', async () => {
    await expect(readDebitFloorDefault(makeDeps('0.5').deps)).resolves.toEqual({ floor: '0.5' });
  });
});

describe('updateDebitFloorDefault', () => {
  it('合法值 → 落库 + emitAudit(settings.debit_floor_default) + 回显', async () => {
    const { deps, audit, log } = makeDeps('0');
    await expect(
      updateDebitFloorDefault(deps, { ctx: adminCtx(7), floor: '0.5' }),
    ).resolves.toEqual({ floor: '0.5' });
    expect(log.writes).toEqual([{ floor: '0.5', adminId: 7 }]);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      actor: 'admin',
      adminId: 7,
      action: 'settings.debit_floor_default',
      targetType: 'system_config',
      targetId: 'debit_floor_default',
      detail: { floor: '0.5' },
    });
  });

  it('非法 floor → invalid_debit_floor 且零落库（表驱动）', async () => {
    // 注：'1e3' 类科学计数法 billing Decimal 解析接受（wire 契约 zod 才拒），不在本层非法表
    for (const floor of ['-1', 'abc', '']) {
      const { deps, log } = makeDeps('0');
      await expect(updateDebitFloorDefault(deps, { ctx: adminCtx(), floor })).rejects.toMatchObject(
        { code: 'control_plane.invalid_debit_floor' },
      );
      expect(log.writes).toEqual([]);
    }
  });

  it('audit sink 故障不反噬（best-effort 降级路径）', async () => {
    const { deps, audit } = makeDeps('0');
    audit.fail.on = true;
    await expect(updateDebitFloorDefault(deps, { ctx: adminCtx(), floor: '2' })).resolves.toEqual({
      floor: '2',
    });
  });
});
