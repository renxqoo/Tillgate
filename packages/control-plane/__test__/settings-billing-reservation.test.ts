/**
 * 预扣策略 settings 用例：读取回落 full（fail-closed）/ 写入值域二道防线 /
 * emitAudit 动作与 best-effort 降级（sink 故障不反噬）。
 * 适配器（postgres upsert）由 admin-api 契约 + 部署栈实测覆盖。
 */
import { describe, expect, it } from 'vitest';
import type { Db } from '@tillgate/db';
import type { FundingReservationPolicy } from '@tillgate/billing';
import type { SettingsStore } from '../src/ports/settings-store';
import { readBillingReservation } from '../src/application/settings/read-billing-reservation';
import {
  updateBillingReservation,
  type UpdateBillingReservationDeps,
} from '../src/application/settings/update-billing-reservation';
import { adminCtx, createMemoryAudit } from './memory';

interface StoreLog {
  writes: { policy: FundingReservationPolicy; adminId: number | null }[];
}

function makeDeps(stored: FundingReservationPolicy | null, log: StoreLog = { writes: [] }) {
  const store: SettingsStore = {
    async readBillingTimezone() {
      return null;
    },
    async updateBillingTimezone() {},
    async readDebitFloorDefault() {
      return null;
    },
    async updateDebitFloorDefault() {},
    async readBillingReservationLimit() {
      return null;
    },
    async updateBillingReservationLimit() {},
    async readPlatformCurrency() {
      return null;
    },
    async updatePlatformCurrency() {},
    async readBillingReservationPolicy() {
      return stored;
    },
    async updateBillingReservationPolicy(_db, input) {
      log.writes.push(input);
    },
  };
  const audit = createMemoryAudit();
  const deps = {
    db: {} as Db,
    stores: { settings: store },
    audit: audit.sink,
  } satisfies UpdateBillingReservationDeps;
  return { deps, audit, log };
}

describe('readBillingReservation', () => {
  it('未配置 → 回落 full（保守预扣 fail-closed）', async () => {
    await expect(readBillingReservation(makeDeps(null).deps)).resolves.toEqual({
      policy: { mode: 'full' },
    });
  });

  it('已配置 fixed → 原样返回', async () => {
    await expect(
      readBillingReservation(makeDeps({ mode: 'fixed', amount: '0.01' }).deps),
    ).resolves.toEqual({ policy: { mode: 'fixed', amount: '0.01' } });
  });
});

describe('updateBillingReservation', () => {
  it('合法 full/fixed → 落库 + emitAudit(settings.billing_reservation) + 回显', async () => {
    for (const policy of [{ mode: 'full' } as const, { mode: 'fixed', amount: '0.01' } as const]) {
      const { deps, audit, log } = makeDeps(null);
      await expect(updateBillingReservation(deps, { ctx: adminCtx(7), policy })).resolves.toEqual({
        policy,
      });
      expect(log.writes).toEqual([{ policy, adminId: 7 }]);
      expect(audit.entries.at(-1)).toMatchObject({
        actor: 'admin',
        adminId: 7,
        action: 'settings.billing_reservation',
        targetType: 'system_config',
        targetId: 'billing_reservation_policy',
      });
    }
  });

  it('非法策略 → invalid_reservation_policy 且零落库（表驱动）', async () => {
    for (const policy of [
      { mode: 'other' },
      { mode: 'fixed' },
      { mode: 'fixed', amount: '0' },
      { mode: 'fixed', amount: '-1' },
      { mode: 'fixed', amount: 'abc' },
      {},
    ] as FundingReservationPolicy[]) {
      const { deps, log } = makeDeps(null);
      await expect(
        updateBillingReservation(deps, { ctx: adminCtx(), policy }),
      ).rejects.toMatchObject({ code: 'control_plane.invalid_reservation_policy' });
      expect(log.writes).toEqual([]);
    }
  });

  it('audit sink 故障不反噬（best-effort 降级路径）', async () => {
    const { deps, audit } = makeDeps(null);
    audit.fail.on = true;
    await expect(
      updateBillingReservation(deps, { ctx: adminCtx(), policy: { mode: 'full' } }),
    ).resolves.toEqual({ policy: { mode: 'full' } });
  });
});
