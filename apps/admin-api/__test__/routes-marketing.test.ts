/**
 * 契约测试：营销配置 GET/PUT（金额/费率正则拒收）+ 邀请关系列表信封/q 透传 +
 * 封禁/恢复动词（patch+adminId）+ 三类返利流水（kind 词表外 400、分页信封）。
 * 业务语义本体在 accounts/billing 包测试;此处锁定 wire 形状与编排透传。
 */
import { describe, expect, it, vi } from 'vitest';
import { createAdminApp } from '../src/app';
import { ADMIN_ID, authHeader, fakeDeps } from './helpers';

const json = { ...authHeader(), 'content-type': 'application/json' };

const SETTINGS = {
  signupGiftAmount: '1',
  referralSignupBonus: '2',
  referralCommissionRate: '0.1',
  updatedBy: 1,
  // JSON 序列化后 Date → ISO 字符串（wire 断言口径）
  updatedAt: '1970-01-01T00:00:00.000Z',
};

describe('marketing', () => {
  it('settings:GET 透传;PUT 走 accounts 用例（patch + adminId）;负数金额 400', async () => {
    const update = vi.fn(async () => SETTINGS);
    const app = createAdminApp(
      fakeDeps({
        accounts: {
          getMarketingSettings: async () => SETTINGS,
          updateMarketingSettings: update,
        },
      }),
    );
    const got = await app.request('/v1/marketing/settings', { headers: authHeader() });
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual(SETTINGS);

    const put = await app.request('/v1/marketing/settings', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({
        signupGiftAmount: '1.5',
        referralSignupBonus: '2',
        referralCommissionRate: '0.5',
      }),
    });
    expect(put.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      patch: {
        signupGiftAmount: '1.5',
        referralSignupBonus: '2',
        referralCommissionRate: '0.5',
      },
      adminId: ADMIN_ID,
    });

    // 正则边界:负数/超 18 位小数/费率 >1 一律拒收
    for (const bad of [
      { signupGiftAmount: '-1', referralSignupBonus: '2', referralCommissionRate: '0.5' },
      {
        signupGiftAmount: '1.1234567890123456789',
        referralSignupBonus: '2',
        referralCommissionRate: '0.5',
      },
      { signupGiftAmount: '1', referralSignupBonus: '2', referralCommissionRate: '1.5' },
    ]) {
      const res = await app.request('/v1/marketing/settings', {
        method: 'PUT',
        headers: json,
        body: JSON.stringify(bad),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'http.validation_failed' } });
    }
  });
});

describe('referrals', () => {
  it('relations:列表信封 + q 透传;PATCH 走 setReferralRelationStatus', async () => {
    const list = vi.fn(async () => ({
      rows: [{ id: 3, inviterEmail: 'a@x', inviteeEmail: 'b@x', status: 1 }],
      total: 1,
    }));
    const setStatus = vi.fn(async () => ({ ok: true }));
    const app = createAdminApp(
      fakeDeps({
        accounts: { listReferralRelations: list, setReferralRelationStatus: setStatus },
      }),
    );
    const rows = await app.request('/v1/referrals/relations?q=a@x&page=2', {
      headers: authHeader(),
    });
    expect(rows.status).toBe(200);
    expect(await rows.json()).toEqual({
      rows: [{ id: 3, inviterEmail: 'a@x', inviteeEmail: 'b@x', status: 1 }],
      total: 1,
      page: 2,
      pageSize: 20,
    });
    expect(list).toHaveBeenCalledWith({ q: 'a@x', page: 2, limit: 20 });

    const patched = await app.request('/v1/referrals/relations/3', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ status: 0 }),
    });
    expect(patched.status).toBe(200);
    expect(setStatus).toHaveBeenCalledWith({ relationId: 3, status: 0, adminId: ADMIN_ID });

    // status 词表外 / 非法 id 一律 400
    const badStatus = await app.request('/v1/referrals/relations/3', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ status: 2 }),
    });
    expect(badStatus.status).toBe(400);
    const badId = await app.request('/v1/referrals/relations/abc', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ status: 0 }),
    });
    expect(badId.status).toBe(400);
  });

  it('payouts:kind 词表内 200 信封（page/pageSize）;词表外/缺失 400 invalid_param', async () => {
    const payouts = vi.fn(async () => ({
      rows: [
        {
          id: 9,
          kind: 'credit',
          refType: 'referral',
          refId: 'referral-commission:7:20260823',
          memo: null,
          createdAt: '2026-08-23T00:00:00.000Z',
        },
      ],
      total: 1,
    }));
    const app = createAdminApp(
      fakeDeps({
        wallet: { referralPayouts: payouts },
      }),
    );
    const ok = await app.request('/v1/referrals/payouts?kind=commission&page=1', {
      headers: authHeader(),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      rows: unknown[];
      total: number;
      page: number;
      pageSize: number;
    };
    expect(body).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(body.rows).toHaveLength(1);
    expect(payouts).toHaveBeenCalledWith({ kind: 'commission', limit: 20, offset: 0 });

    for (const qs of ['kind=unknown', ''] as const) {
      const res = await app.request(`/v1/referrals/payouts${qs ? `?${qs}` : ''}`, {
        headers: authHeader(),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'admin.invalid_param' } });
    }
  });
});
