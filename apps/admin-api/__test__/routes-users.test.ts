import { describe, expect, it, vi } from 'vitest';
import { createAdminApp } from '../src/app';
import { authHeader, fakeDeps } from './helpers';

/**
 * 用户/Key 域契约（v1 users.test.ts + keys.test.ts 行为规格）:列表钱包富化口径 /
 * 资料 / PATCH 封禁语义与 creditLimit 拆分 / 调账赠送幂等与同事务审计 / 流水信封。
 */

const userRow = {
  id: 42,
  issuer: 'https://github.com',
  subject: 'user-42',
  identityProvider: 'github',
  email: 'u@test.dev',
  displayName: 'U',
  rateCardId: null,
  dailySpendLimit: null,
  status: 0,
  isEnterprise: false,
  freezeReason: null,
  rpmLimit: null,
  tpmLimit: null,
  lastLoginAt: new Date('2026-08-01T00:00:00Z'),
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

const snapshot = {
  id: 'u42',
  kind: 'user',
  code: null,
  currency: 'CNY',
  balance: '10',
  inFlight: '2',
  creditLimit: '5',
  status: 'active',
};

describe('GET /v1/users', () => {
  it('列表信封 + 钱包富化(available = balance + creditLimit − inFlight)', async () => {
    const app = createAdminApp(
      fakeDeps({
        accounts: {
          adminListUsers: async () => ({ rows: [userRow], total: 1 }),
        },
        wallet: { accounts: async () => [snapshot] },
      }),
    );
    const res = await app.request('/v1/users?sort_by=subject&order=asc', {
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<Record<string, unknown>>;
      total: number;
      page: number;
      pageSize: number;
    };
    expect(body).toMatchObject({
      rows: [
        { id: 42, balance: '10', reservedBalance: '2', creditLimit: '5', availableBalance: '13' },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    expect(body.rows[0]?.passwordHash).toBeUndefined();
    expect(body.rows[0]?.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('sort_by 白名单外 → 400 admin.invalid_sort_field;分页参数非法值容错不 400', async () => {
    const app = createAdminApp(fakeDeps({}));
    const bad = await app.request('/v1/users?sort_by=passwordHash', { headers: authHeader() });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: 'admin.invalid_sort_field' } });
    const tolerant = await app.request('/v1/users?page=abc&page_size=9999', {
      headers: authHeader(),
    });
    expect(tolerant.status).toBe(200);
    expect(await tolerant.json()).toMatchObject({ page: 1, pageSize: 100 });
  });

  it('enterprise 过滤透传(0/1)', async () => {
    const adminListUsers = vi.fn(async () => ({ rows: [], total: 0 }));
    const app = createAdminApp(fakeDeps({ accounts: { adminListUsers } }));
    await app.request('/v1/users?enterprise=1', { headers: authHeader() });
    expect(adminListUsers).toHaveBeenCalledWith(expect.objectContaining({ enterprise: true }));
  });
});

describe('GET /v1/users/:id 与 PATCH', () => {
  it('资料含 rateCardName;PATCH 封禁缺省理由由 accounts 注入', async () => {
    const adminPatchUser = vi.fn(async () => userRow);
    const app = createAdminApp(
      fakeDeps({
        accounts: {
          adminGetUser: async () => ({ ...userRow, rateCardName: '标准' }),
          adminPatchUser,
        },
        wallet: { accounts: async () => [] },
      }),
    );
    const profile = await app.request('/v1/users/42', { headers: authHeader() });
    expect(await profile.json()).toMatchObject({ id: 42, rateCardName: '标准', balance: '0' });

    const patched = await app.request('/v1/users/42', {
      method: 'PATCH',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ status: 1, freezeReason: '风控' }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({ id: 42 });
    expect(adminPatchUser).toHaveBeenCalledWith({
      userId: 42,
      patch: { status: 1, freezeReason: '风控' },
      adminId: 7,
    });
  });

  it('freezeReason 不随封禁 → 400 validation_failed;creditLimit 拆给 wallet.setCreditLimit', async () => {
    const setCreditLimit = vi.fn(async () => ({ ok: true }) as never);
    const app = createAdminApp(
      fakeDeps({
        wallet: { setCreditLimit },
        accounts: { adminPatchUser: async () => userRow },
      }),
    );
    const refuse = await app.request('/v1/users/42', {
      method: 'PATCH',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ freezeReason: 'x' }),
    });
    expect(refuse.status).toBe(400);
    expect(await refuse.json()).toMatchObject({ error: { code: 'http.validation_failed' } });

    await app.request('/v1/users/42', {
      method: 'PATCH',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ creditLimit: '100.5' }),
    });
    expect(setCreditLimit).toHaveBeenCalledWith({ userId: 42, amount: '100.5' });
  });
});

function fundsDeps() {
  const seen: Array<{ operationId: string; kind: string; payload: Record<string, unknown> }> = [];
  const deps = fakeDeps({
    accounts: { userExists: async (id: number) => id === 42 },
    wallet: {
      credit: async (input: { amount: string }) => ({
        transactionId: 1,
        amount: input.amount,
        balanceAfter: '110',
        replayed: false,
      }),
      transfer: async () => ({
        transactionId: 2,
        fromBalanceAfter: '90',
        toBalanceAfter: '0',
        replayed: false,
      }),
      statement: async () => [
        {
          legId: 9,
          transactionKind: 'admin.gift',
          refType: 'admin',
          refId: 'op-1',
          amount: '10',
          balanceAfter: '110',
          memo: '管理员赠送',
          createdAt: new Date('2026-08-01T00:00:00Z'),
        },
      ],
    },
    operations: {
      run: async (input: {
        operationId: string;
        kind: string;
        payload: Record<string, unknown>;
        execute: (tx: unknown) => Promise<Record<string, unknown>>;
      }) => {
        seen.push({ operationId: input.operationId, kind: input.kind, payload: input.payload });
        const receipt = await input.execute({} as never);
        return { receipt, replayed: false };
      },
    },
  });
  return { deps, seen };
}

describe('用户资金动词', () => {
  it('赠送:幂等档案 + credit + 同事务审计 + v1 回执形状', async () => {
    const { deps, seen } = fundsDeps();
    const writeAudit = vi.fn(async () => undefined);
    deps.writeAudit = writeAudit;
    const app = createAdminApp(deps);
    const res = await app.request('/v1/users/42/gift', {
      method: 'POST',
      headers: { ...authHeader(), 'content-type': 'application/json', 'idempotency-key': 'gift-1' },
      body: JSON.stringify({ amount: '10' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      balanceBefore: '100',
      balanceAfter: '110',
      replayed: false,
    });
    expect(seen[0]).toMatchObject({ operationId: 'gift-1', kind: 'admin.gift' });
    expect(writeAudit).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ action: 'admin.gift', actor: 'admin', adminId: 7, targetId: '42' }),
    );
  });

  it('调账负数 = transfer 到外部世界镜像(allowCredit:true)', async () => {
    const { deps, seen } = fundsDeps();
    const app = createAdminApp(deps);
    const res = await app.request('/v1/users/42/adjust', {
      method: 'POST',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ amount: '-10' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      balanceBefore: '100',
      balanceAfter: '90',
      replayed: false,
    });
    expect(seen[0]).toMatchObject({ kind: 'admin.adjust' });
  });

  it('属主不存在 → 404 accounts.user_not_found', async () => {
    const app = createAdminApp(fundsDeps().deps);
    const res = await app.request('/v1/users/999/gift', {
      method: 'POST',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ amount: '10' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'accounts.user_not_found' } });
  });

  it('金额非法(IEEE-754/超限/零)→ 400;流水信封 rows/total', async () => {
    const app = createAdminApp(fundsDeps().deps);
    const bad = await app.request('/v1/users/42/adjust', {
      method: 'POST',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ amount: '0' }),
    });
    expect(bad.status).toBe(400);
    const tx = await app.request('/v1/users/42/transactions?page_size=50', {
      headers: authHeader(),
    });
    expect(await tx.json()).toEqual({
      rows: [
        {
          id: 9,
          userId: 42,
          type: 'admin.gift',
          amount: '10',
          balanceAfter: '110',
          refType: 'admin',
          refId: 'op-1',
          remark: '管理员赠送',
          createdAt: '2026-08-01T00:00:00.000Z',
          createdBy: null,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 50,
    });
  });

  it('用户审计:listByTarget 信封', async () => {
    const app = createAdminApp(
      fakeDeps({
        observability: {
          audit: {
            listByTarget: async () => [
              {
                id: 3,
                adminId: 7,
                actor: 'admin',
                action: 'user.update',
                targetType: 'user',
                targetId: '42',
                detail: null,
                createdAt: new Date('2026-08-01T00:00:00Z'),
              },
            ],
          },
        },
      }),
    );
    const res = await app.request('/v1/users/42/audit-logs', { headers: authHeader() });
    expect(await res.json()).toMatchObject({ rows: [{ id: 3, adminSubject: null }], total: 1 });
  });
});

describe('GET|PATCH /v1/admin-keys', () => {
  it('列表信封(keyPreview 脱敏,无明文);PATCH 透传 adminId', async () => {
    const keyRow = {
      id: 5,
      keyPreview: 'ag_****abcd',
      name: 'k',
      remark: null,
      subscriptionId: null,
      userId: 42,
      rpmLimit: null,
      tpmLimit: null,
      dailySpendLimit: null,
      status: 0,
      lastUsedAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    };
    const adminPatchKey = vi.fn(async () => keyRow);
    const app = createAdminApp(
      fakeDeps({
        accounts: {
          adminListKeys: async () => ({ rows: [keyRow], total: 1 }),
          adminPatchKey,
        },
      }),
    );
    const list = await app.request('/v1/admin-keys?status=0', { headers: authHeader() });
    const body = (await list.json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows[0]).toMatchObject({
      id: 5,
      keyPreview: 'ag_****abcd',
      userEmail: null,
      userDisplayName: null,
    });
    expect(JSON.stringify(body)).not.toContain('sk-');

    const badStatus = await app.request('/v1/admin-keys/5', {
      method: 'PATCH',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ status: 99 }),
    });
    expect(badStatus.status).toBe(400);
    await app.request('/v1/admin-keys/5', {
      method: 'PATCH',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ status: 1 }),
    });
    expect(adminPatchKey).toHaveBeenCalledWith({ keyId: 5, patch: { status: 1 }, adminId: 7 });
  });
});
