/**
 * 预扣策略管理面契约测试：GET/PUT 形状 / 模式与金额参数矩阵（表驱动）/
 * 值域二道防线透传 / 后置审计在用例内（funds:floor 越权 403 归 e2e 真 PG）。
 */
import { describe, expect, it } from 'vitest';
import { createAdminApp } from '../src/app';
import { fakeDeps } from './helpers';

const json = { authorization: 'Bearer admin-session-token', 'content-type': 'application/json' };

const validPolicies = [
  { mode: 'full', expect: { policy: { mode: 'full' } } },
  { mode: 'fixed', amount: '0.01', expect: { policy: { mode: 'fixed', amount: '0.01' } } },
  { mode: 'fixed', amount: '5', expect: { policy: { mode: 'fixed', amount: '5' } } },
];
const badPolicies = [
  { mode: 'other' },
  { mode: 'fixed' },
  { mode: 'fixed', amount: '0' },
  { mode: 'fixed', amount: '-1' },
  { mode: 'fixed', amount: 'abc' },
  {},
];

function appWith() {
  return createAdminApp(
    fakeDeps({
      controlPlane: {
        settings: {
          billingReservation: {
            read: () => Promise.resolve({ policy: { mode: 'full' } }),
            update: ({ policy }: { policy: { mode: string; amount?: string } }) =>
              Promise.resolve({ policy }),
          },
          billingReservationLimit: {
            read: () => Promise.resolve({ limit: '1000' }),
            update: ({ limit }: { limit: string }) => Promise.resolve({ limit }),
          },
          platformCurrency: {
            read: () => Promise.resolve({ currency: 'CNY' }),
            update: ({ currency }: { currency: string }) => Promise.resolve({ currency }),
          },
        },
      },
    }),
  );
}

describe('GET/PUT /v1/settings/billing-reservation', () => {
  it('读 → 默认回落 full（表形状 {policy}）', async () => {
    const read = await appWith().request('/v1/settings/billing-reservation', { headers: json });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ policy: { mode: 'full' } });
  });

  it('写合法策略回显（表驱动）', async () => {
    for (const p of validPolicies) {
      const put = await appWith().request('/v1/settings/billing-reservation', {
        method: 'PUT',
        headers: json,
        body: JSON.stringify({
          mode: p.mode,
          ...(p.amount !== undefined ? { amount: p.amount } : {}),
        }),
      });
      expect(put.status).toBe(200);
      expect(await put.json()).toEqual(p.expect);
    }
  });

  it('非法策略 → 400（表驱动）', async () => {
    for (const policy of badPolicies) {
      const put = await appWith().request('/v1/settings/billing-reservation', {
        method: 'PUT',
        headers: json,
        body: JSON.stringify(policy),
      });
      expect(put.status).toBe(400);
    }
  });
});

describe('GET/PUT /v1/settings/billing-reservation-limit', () => {
  it('read fallback 1000; write valid echoes (table)', async () => {
    const read = await appWith().request('/v1/settings/billing-reservation-limit', {
      headers: json,
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ limit: '1000' });
    for (const limit of ['0.01', '100', '100000']) {
      const put = await appWith().request('/v1/settings/billing-reservation-limit', {
        method: 'PUT',
        headers: json,
        body: JSON.stringify({ limit }),
      });
      expect(put.status).toBe(200);
      expect(await put.json()).toEqual({ limit });
    }
  });

  it('zero/negative/garbage limit -> 400 (table)', async () => {
    for (const limit of ['0', '-1', 'abc', '']) {
      const put = await appWith().request('/v1/settings/billing-reservation-limit', {
        method: 'PUT',
        headers: json,
        body: JSON.stringify({ limit }),
      });
      expect(put.status).toBe(400);
    }
  });
});

describe('GET/PUT /v1/settings/platform-currency', () => {
  it('read fallback CNY; write echoes (table)', async () => {
    const read = await appWith().request('/v1/settings/platform-currency', { headers: json });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ currency: 'CNY' });
    for (const currency of ['USD', 'EUR']) {
      const put = await appWith().request('/v1/settings/platform-currency', {
        method: 'PUT',
        headers: json,
        body: JSON.stringify({ currency }),
      });
      expect(put.status).toBe(200);
      expect(await put.json()).toEqual({ currency });
    }
  });

  it('invalid currency -> 400 (table)', async () => {
    for (const currency of ['cny', 'CN', 'CNY1', '', '人民币']) {
      const put = await appWith().request('/v1/settings/platform-currency', {
        method: 'PUT',
        headers: json,
        body: JSON.stringify({ currency }),
      });
      expect(put.status).toBe(400);
    }
  });
});
