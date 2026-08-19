/**
 * E2E ②金钱计算链（真进程 ×2 + 真 DB 共库 + 真 wallet/幂等内核）：
 * 管理面进货（凭证+快照）→ 调账（含超扣守卫）→ 用户调账/赠送（幂等重放）→
 * 流水余额链 → 订阅金钱链（client 购买 → admin 续费 → admin 取消）→
 * 双 app 余额对账（同一数字）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Decimal } from '@ai-gateway/domain';
import {
  cleanupE2E,
  e2eDb,
  e2eUid,
  http,
  loginAdmin,
  seedAdmin,
  startAdminApi,
  trackE2E,
  type E2EAdminApi,
} from './e2e-kit.js';
import { startClientApi, type E2EClientApi } from '../../../client-api/src/__tests__/e2e-kit.js';

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let admin: E2EAdminApi;
let client: E2EClientApi;
let token: string;

beforeAll(async () => {
  const db = e2eDb();
  admin = await startAdminApi(db);
  client = await startClientApi(db);
  const { email, password } = await seedAdmin(db);
  token = await loginAdmin(admin.baseUrl, email, password);
});

afterAll(async () => {
  await admin.stop();
  await client.stop();
  await cleanupE2E(admin.db);
});

async function channelBudget(channelId: number): Promise<string> {
  const { channels: channelsTable } = await import('@ai-gateway/db');
  const { eq } = await import('drizzle-orm');
  const [row] = await admin.db
    .select({ budget: channelsTable.upstreamBudget })
    .from(channelsTable)
    .where(eq(channelsTable.id, channelId));
  return row!.budget;
}

describe('E2E 渠道资金链', () => {
  it('进货（凭证）→ 调账 → 超扣守卫 → 幂等重放 → 预算终值 70', async () => {
    // 建供应商 + 渠道
    const provider = await http(admin.baseUrl, '/v1/providers', {
      token,
      body: { name: e2eUid('prov'), baseUrl: 'https://money.e2e.test/v1' },
    });
    expect(provider.status).toBe(201);
    trackE2E.provider(provider.body.id as number);

    const channel = await http(admin.baseUrl, '/v1/channels', {
      token,
      body: { providerId: provider.body.id, name: e2eUid('ch'), apiKey: 'sk-money-e2e' },
    });
    expect(channel.status).toBe(201);
    const channelId = channel.body.id as number;
    trackE2E.channel(channelId);

    // 进货 100（带凭证 + 订单号）
    const recharge = await http(admin.baseUrl, '/v1/channel-funds/recharge', {
      token,
      body: { channelId, amount: 100, orderNo: `PAY-${e2eUid('x')}`, voucherDataUrl: PNG_DATA_URL, remark: 'E2E 进货' },
      headers: { 'idempotency-key': e2eUid('rc') },
    });
    expect(recharge.status).toBe(200);
    expect(new Decimal(recharge.body.balanceAfter as string).eq(100)).toBe(true);

    // 调账 -30 → 70（键捕获——重放用同一键）
    const adjKey = e2eUid('adj');
    const adjust = await http(admin.baseUrl, '/v1/channel-funds/adjust', {
      token,
      body: { channelId, amount: -30 },
      headers: { 'idempotency-key': adjKey },
    });
    expect(adjust.status).toBe(200);
    expect(new Decimal(adjust.body.balanceAfter as string).eq(70)).toBe(true);

    // 超扣 → 422
    const over = await http(admin.baseUrl, '/v1/channel-funds/adjust', {
      token,
      body: { channelId, amount: -999 },
      headers: { 'idempotency-key': e2eUid('adj') },
    });
    expect(over.status).toBe(422);

    // 幂等重放：同键同参 → replayed、预算不动
    const replay = await http(admin.baseUrl, '/v1/channel-funds/adjust', {
      token,
      body: { channelId, amount: -30 },
      headers: { 'idempotency-key': adjKey },
    });
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);

    // 终值 70（100 − 30 只扣一次）
    expect(new Decimal(await channelBudget(channelId)).eq(70)).toBe(true);

    // 流水两行 + 凭证键可回读
    const ledger = await http(admin.baseUrl, `/v1/channel-funds?channelId=${channelId}`, { token });
    expect(ledger.status).toBe(200);
    expect(ledger.body.total).toBe(2);
    const rechargeRow = (ledger.body.rows as Array<{ type: string; voucher: string | null }>).find(
      (r) => r.type === 'recharge',
    )!;
    const voucherKey = rechargeRow.voucher;
    expect(voucherKey).toBeTruthy();
    const voucher = await fetch(`${admin.baseUrl}/v1/vouchers/${voucherKey}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(voucher.status).toBe(200);
    expect(voucher.headers.get('content-type')).toBe('image/png');
  });
});

describe('E2E 用户资金 + 订阅金钱链（双 app 共库）', () => {
  it('client 注册 → admin 调账入金 → client 购订阅 → admin 续费 → admin 取消 → 双面余额对账', async () => {
    // 1) 用户在 client-api 注册（拿用户 token）
    const email = `${e2eUid('u')}@example.com`;
    const reg = await http(client.baseUrl, '/v1/auth/register', {
      body: { email, password: 'client-e2e-password-1' },
    });
    expect(reg.status).toBe(201);
    const userToken = reg.body.token as string;
    const userId = reg.body.userId as number;
    trackE2E.user(userId);

    // 2) 管理面建套餐（30 元 / 30 额度 / 30 天）
    const plan = await http(admin.baseUrl, '/v1/plans', {
      token,
      body: { name: e2eUid('plan'), price: 30, quotaAmount: 30, periodDays: 30 },
    });
    expect(plan.status).toBe(201);
    const planId = plan.body.id as number;
    trackE2E.plan(planId);

    // 3) admin 调账 +100（幂等键重放只动一次）
    const adjustKey = e2eUid('adj');
    const first = await http(admin.baseUrl, `/v1/users/${userId}/adjust`, {
      token,
      body: { amount: 100 },
      headers: { 'idempotency-key': adjustKey },
    });
    expect(first.status).toBe(200);
    const replay = await http(admin.baseUrl, `/v1/users/${userId}/adjust`, {
      token,
      body: { amount: 100 },
      headers: { 'idempotency-key': adjustKey },
    });
    expect(replay.body.replayed).toBe(true);

    // 4) 管理面赠送 +5 → 105
    const gift = await http(admin.baseUrl, `/v1/users/${userId}/gift`, {
      token,
      body: { amount: 5 },
      headers: { 'idempotency-key': e2eUid('gift') },
    });
    expect(gift.status).toBe(200);
    expect(new Decimal(gift.body.balanceAfter as string).eq(105)).toBe(true);

    // 5) client 购买订阅 → 余额 75
    const purchase = await http(client.baseUrl, '/v1/subscriptions', {
      token: userToken,
      body: { planId, quantity: 1 },
      headers: { 'idempotency-key': e2eUid('buy') },
    });
    expect(purchase.status).toBe(201);
    const subscriptionId = purchase.body.subscriptionId as number;

    // 6) admin 续费（管理面免属主）→ 再扣 30 → 45
    const renew = await http(admin.baseUrl, `/v1/subscriptions/${subscriptionId}/renew`, {
      method: 'POST',
      token,
      headers: { 'idempotency-key': e2eUid('renew') },
    });
    expect(renew.status).toBe(200);
    // 续费生成新订阅行（旧行转到期）；取消要打新行
    const renewedId = renew.body.subscriptionId as number;

    // 7) 管理面流水：余额链 newest-first（105 → 75 → 45）
    const txs = await http(admin.baseUrl, `/v1/users/${userId}/transactions?page_size=10`, { token });
    expect(txs.status).toBe(200);
    const balances = (txs.body.items as Array<{ balanceAfter: string }>).map((i) => new Decimal(i.balanceAfter));
    expect(balances[0]!.eq(45)).toBe(true);
    expect(balances[1]!.eq(75)).toBe(true);
    expect(balances[2]!.eq(105)).toBe(true);

    // 8) admin 取消（无资金变动）
    const cancel = await http(admin.baseUrl, `/v1/subscriptions/${renewedId}/cancel`, {
      method: 'POST',
      token,
      headers: { 'idempotency-key': e2eUid('cxl') },
    });
    expect(cancel.status).toBe(200);
    expect(new Decimal(await userBalance(userId)).eq(45)).toBe(true);

    // 9) 双 app 余额对账：admin 用户列表与 client 钱包同一数字
    const adminList = await http(admin.baseUrl, '/v1/users?page_size=100', { token });
    const adminRow = (adminList.body.rows as Array<{ id: number; balance: string }>).find((r) => r.id === userId);
    expect(adminRow).toBeTruthy();
    expect(new Decimal(adminRow!.balance).eq(45)).toBe(true);
    const clientWallet = await http(client.baseUrl, '/v1/wallet/accounts', { token: userToken });
    const cny = (clientWallet.body.accounts as Array<{ currency: string; balance: string }>).find(
      (a) => a.currency === 'CNY',
    );
    expect(new Decimal(cny!.balance).eq(45)).toBe(true);
  });
});

async function userBalance(userId: number): Promise<string> {
  const { users: usersTable } = await import('@ai-gateway/db');
  const { eq } = await import('drizzle-orm');
  const [row] = await admin.db
    .select({ subject: usersTable.subject })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  const list = await http(admin.baseUrl, `/v1/users?q=${row!.subject}`, { token });
  const mine = (list.body.rows as Array<{ subject: string; balance: string }>).find((r) => r.subject === row!.subject);
  return mine!.balance;
}
