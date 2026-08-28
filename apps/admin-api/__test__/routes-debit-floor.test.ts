/**
 * 透支地板管理面契约测试（方案 docs/debit-floor/DESIGN.md 测试口径）：
 * 三端点形状 / floor 参数矩阵（表驱动） / 贴线冲突透传 409 / 后置审计动作名 /
 * 读取富化字段。权限绑定（funds:floor）由迁移种子 + acl fail-closed 兜底，
 * 越权 403 断言在 e2e 旅程（真 PG 装置）。
 */
import { describe, expect, it, vi } from 'vitest';
import { BillingErrors } from '@tillgate/billing';
import { createAdminApp } from '../src/app';
import { fakeDeps } from './helpers';

const json = { authorization: 'Bearer admin-session-token', 'content-type': 'application/json' };

const floors = ['0', '0.5', '12.345'];
const badFloors = ['-1', 'abc', ''];

function appWith(
  walletOverrides: Record<string, unknown> = {},
  depsOverrides: Record<string, unknown> = {},
) {
  return createAdminApp(
    fakeDeps({
      wallet: {
        setDebitFloor: async () => ({ debitFloorAfter: '5' }),
        applyDefaultFloor: async () => ({ applied: 3, skipped: 1 }),
        accounts: async () => [{ kind: 'user', debitFloor: '0' }],
        ...walletOverrides,
      },
      controlPlane: {
        settings: {
          debitFloorDefault: {
            read: () => Promise.resolve({ floor: '0.5' }),
            update: ({ floor }: { floor: string }) => Promise.resolve({ floor }),
          },
        },
      },
      ...depsOverrides,
    }),
  );
}

describe('GET/PUT /v1/settings/debit-floor-default', () => {
  it('读 → {floor};写合法值回显（表驱动）', async () => {
    const app = appWith();
    const read = await app.request('/v1/settings/debit-floor-default', { headers: json });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ floor: '0.5' });

    for (const floor of floors) {
      const put = await app.request('/v1/settings/debit-floor-default', {
        method: 'PUT',
        headers: json,
        body: JSON.stringify({ floor }),
      });
      expect(put.status).toBe(200);
      expect(((await put.json()) as { floor: string }).floor).toBe(floor);
    }
  });

  it('非法 floor → 400（表驱动）', async () => {
    const app = appWith();
    for (const floor of badFloors) {
      const put = await app.request('/v1/settings/debit-floor-default', {
        method: 'PUT',
        headers: json,
        body: JSON.stringify({ floor }),
      });
      expect(put.status).toBe(400);
    }
  });
});

describe('PUT /v1/users/:id/debit-floor', () => {
  it('合法 → 200 {ok, floorAfter, source:manual} + 后置审计 wallet.set_debit_floor', async () => {
    const postAudit = vi.fn(async () => {});
    const app = appWith({ setDebitFloor: async () => ({ debitFloorAfter: '5' }) }, { postAudit });
    const res = await app.request('/v1/users/1/debit-floor', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ floor: '5' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, floorAfter: '5', source: 'manual' });
    expect(postAudit).toHaveBeenCalledTimes(1);
    const entry = postAudit.mock.calls[0] as unknown as [{ action: string }];
    expect(entry[0].action).toBe('wallet.set_debit_floor');
  });

  it('非法 floor → 400（表驱动）', async () => {
    const app = appWith();
    for (const floor of badFloors) {
      const res = await app.request('/v1/users/1/debit-floor', {
        method: 'PUT',
        headers: json,
        body: JSON.stringify({ floor }),
      });
      expect(res.status).toBe(400);
    }
  });

  it('贴线冲突 → 409 billing.debit_floor_conflict', async () => {
    const app = appWith({
      setDebitFloor: async () => {
        throw BillingErrors.business('debit_floor_conflict', { userId: 1 });
      },
    });
    const res = await app.request('/v1/users/1/debit-floor', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ floor: '0' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('billing.debit_floor_conflict');
  });
});

describe('POST /v1/wallets/debit-floor/apply-default', () => {
  it('→ {applied, skipped, floor}（读全局默认为基准）+ 后置审计', async () => {
    const postAudit = vi.fn(async () => {});
    const app = appWith({}, { postAudit });
    const res = await app.request('/v1/wallets/debit-floor/apply-default', {
      method: 'POST',
      headers: json,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: 3, skipped: 1, floor: '0.5' });
    const entry = postAudit.mock.calls[0] as unknown as [{ action: string }];
    expect(entry[0].action).toBe('wallet.apply_default_floor');
  });
});
