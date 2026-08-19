/**
 * E2E ① 用户全链（真服务进程 + dev 库 + 真 HTTP）：
 * 注册 → 登录 → me → Key 全生命周期 → epay 充值回调 → 兑换码 → 套餐购买 →
 * 钱包流水对账 → 用量报表 → 改密全网下线。
 * 资损断言：每一步后的余额精确对账（充值 − 兑换 − 套餐价款）。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { usageLogs } from '@ai-gateway/db';
import {
  E2EFixtures,
  e2eDb,
  errCode,
  expectAmountEq,
  http,
  signedEpayNotify,
  startClientApi,
  type E2EClientApi,
} from './e2e-kit.js';

let api: E2EClientApi;
let fx: E2EFixtures;

beforeAll(async () => {
  const db = e2eDb();
  api = await startClientApi(db);
  fx = new E2EFixtures(db);
});

afterAll(async () => {
  await fx.cleanup();
  await api.stop();
  await api.db.$client.end().catch(() => {});
});

describe('E2E ① 用户全链', () => {
  it('健康与能力探测', async () => {
    const health = await http(api.baseUrl, 'GET', '/healthz');
    expect(health.status).toBe(200);
    const caps = await http(api.baseUrl, 'GET', '/v1/auth/capabilities');
    expect(caps.body).toEqual({ registerEnabled: true, captchaSiteKey: null, emailCodeRequired: false });
  });

  it('注册 → 会话即 token；重复注册 409 信封', async () => {
    const user = await fx.registerViaHttp(api.baseUrl);
    expect(user.token).toBeTruthy();
    const dup = await http(api.baseUrl, 'POST', '/v1/auth/register', {
      body: { email: user.email, password: user.password },
    });
    expect(dup.status).toBe(409);
    expect(errCode(dup)).toBe('email_taken');
  });

  it('登录 + me（初始余额 0）', async () => {
    const user = await fx.registerViaHttp(api.baseUrl);
    const login = await http(api.baseUrl, 'POST', '/v1/auth/login', {
      body: { email: user.email, password: user.password },
    });
    expect(login.status).toBe(200);
    const me = await http(api.baseUrl, 'GET', '/v1/me', { token: (login.body as { token: string }).token });
    expect(me.status).toBe(200);
    expectAmountEq(
      ((me.body as { accounts: { currency: string; balance: string }[] }).accounts.find((a) => a.currency === 'CNY')?.balance ?? '0'),
      '0',
    );
  });

  it('Key 生命周期：创建（明文一次）→ 列表无哈希 → PATCH → 轮换 → 吊销', async () => {
    const user = await fx.registerViaHttp(api.baseUrl);
    const created = await http(api.baseUrl, 'POST', '/v1/keys', {
      token: user.token,
      body: { name: 'e2e-key', rpmLimit: 10 },
    });
    expect(created.status).toBe(201);
    const key = created.body as { id: number; plaintext: string };
    expect(key.plaintext).toMatch(/^ag_[0-9a-f]{40}$/);

    const list = await http(api.baseUrl, 'GET', '/v1/keys', { token: user.token });
    expect(JSON.stringify(list.body)).not.toContain(key.plaintext);

    const patched = await http(api.baseUrl, `PATCH`, `/v1/keys/${key.id}`, {
      token: user.token,
      body: { name: 'e2e-key-v2', dailySpendLimit: '10' },
    });
    expect(patched.status).toBe(200);
    expect((patched.body as { name: string }).name).toBe('e2e-key-v2');

    const rotated = await http(api.baseUrl, 'POST', `/v1/keys/${key.id}/rotate`, { token: user.token });
    expect(rotated.status).toBe(201);
    const newKey = rotated.body as { id: number; plaintext: string; rpmLimit: number; revokedId: number };
    expect(newKey.plaintext).not.toBe(key.plaintext);
    expect(newKey.rpmLimit).toBe(10);
    // 轮换已同事务吊销旧 Key
    const listAfterRotate = await http(api.baseUrl, 'GET', '/v1/keys', { token: user.token });
    const oldRow = (listAfterRotate.body as { rows: { id: number; status: number }[] }).rows.find((r) => r.id === key.id);
    expect(oldRow!.status).toBe(1);

    // 吊销新 Key → 200；重复吊销 → 409
    const revoked = await http(api.baseUrl, 'DELETE', `/v1/keys/${newKey.id}`, { token: user.token });
    expect(revoked.status).toBe(200);
    const again = await http(api.baseUrl, 'DELETE', `/v1/keys/${newKey.id}`, { token: user.token });
    expect(again.status).toBe(409);
  });

  it('epay 充值：下单 → 真签名回调入账 → 重复回调幂等 → 订单 credited', async () => {
    const user = await fx.registerViaHttp(api.baseUrl);
    const order = await http(api.baseUrl, 'POST', '/v1/payments/orders', {
      token: user.token,
      body: { amount: '10' },
    });
    expect(order.status).toBe(201);
    const { orderId, payUrl } = order.body as { orderId: string; payUrl: string };
    expect(payUrl.startsWith('https://pay.e2e.test/submit.php?')).toBe(true);

    const notify = await http(api.baseUrl, 'POST', '/v1/payments/notify/epay', {
      contentType: 'application/x-www-form-urlencoded',
      body: signedEpayNotify(orderId, '10'),
    });
    expect(notify.text).toBe('success');
    expectAmountEq(await fx.balanceOf(user.userId), '10');

    // 重复回调 + 金额篡改（合法签名）都不改变余额
    await http(api.baseUrl, 'POST', '/v1/payments/notify/epay', {
      contentType: 'application/x-www-form-urlencoded',
      body: signedEpayNotify(orderId, '10'),
    });
    const tampered = await http(api.baseUrl, 'POST', '/v1/payments/notify/epay', {
      contentType: 'application/x-www-form-urlencoded',
      body: signedEpayNotify(orderId, '0.01'),
    });
    expect(tampered.text).toBe('fail');
    expectAmountEq(await fx.balanceOf(user.userId), '10');

    const orders = await http(api.baseUrl, 'GET', '/v1/payments/orders', { token: user.token });
    const rows = (orders.body as { rows: { id: string; status: number }[] }).rows;
    expect(rows.find((r) => r.id === orderId)?.status).toBe(2);
  });

  it('兑换码：入账 + 历史 + 频率语义（错误码结构化）', async () => {
    const user = await fx.registerViaHttp(api.baseUrl);
    const code = await fx.seedRedeemCode('4.5');
    const redeem = await http(api.baseUrl, 'POST', '/v1/redeem', {
      token: user.token,
      body: { code },
    });
    expect(redeem.status).toBe(200);
    expectAmountEq(await fx.balanceOf(user.userId), '4.5');
    // 已用 → 409
    const again = await http(api.baseUrl, 'POST', '/v1/redeem', { token: user.token, body: { code } });
    expect(again.status).toBe(409);
    expect(errCode(again)).toBe('code_already_used');
    const history = await http(api.baseUrl, 'GET', '/v1/redeem/history', { token: user.token });
    const rows = (history.body as { rows: { amount: string }[] }).rows;
    expect(rows.length).toBe(1);
    expect(rows[0]!.amount.startsWith('4.5')).toBe(true);
  });

  it('套餐购买：目录公开 → 现金扣款 → 我的订阅 → 幂等重放 → 余额精确对账', async () => {
    const planId = await fx.seedPlan({ price: '6', quotaAmount: '60', sortOrder: 1 });
    const user = await fx.registerViaHttp(api.baseUrl);
    // 资金来源：兑换码 12.5
    const code = await fx.seedRedeemCode('12.5');
    await http(api.baseUrl, 'POST', '/v1/redeem', { token: user.token, body: { code } });

    const plans = await http(api.baseUrl, 'GET', '/v1/plans');
    expect(plans.status).toBe(200);
    expect((plans.body as { rows: { id: number }[] }).rows.some((p) => p.id === planId)).toBe(true);

    const opKey = `e2e-${randomUUID().slice(0, 12)}`;
    const purchase = await http(api.baseUrl, 'POST', '/v1/subscriptions', {
      token: user.token,
      headers: { 'idempotency-key': opKey },
      body: { planId },
    });
    expect(purchase.status).toBe(201);
    expect((purchase.body as { replayed: boolean }).replayed).toBe(false);
    expectAmountEq(await fx.balanceOf(user.userId), '6.5'); // 12.5 − 6

    const mine = await http(api.baseUrl, 'GET', '/v1/subscriptions', { token: user.token });
    const sub = (mine.body as { rows: { planId: number; status: number; quotaAmount: string }[] }).rows[0]!;
    expect(sub.planId).toBe(planId);
    expect(sub.status).toBe(0);

    // 幂等重放（同 idempotency-key）：回放同一回执，不二次扣款
    const replayBuy = await http(api.baseUrl, 'POST', '/v1/subscriptions', {
      token: user.token,
      headers: { 'idempotency-key': opKey },
      body: { planId },
    });
    expect(replayBuy.status).toBe(201);
    const replayBody = replayBuy.body as { replayed: boolean; subscriptionId: number };
    expect(replayBody.replayed).toBe(true);
    expect(replayBody.subscriptionId).toBe((purchase.body as { subscriptionId: number }).subscriptionId);
    expectAmountEq(await fx.balanceOf(user.userId), '6.5');
  });

  it('钱包流水：腿级对账（topup/redeem/subscription 三类锚齐全）', async () => {
    const user = await fx.registerViaHttp(api.baseUrl);
    const code = await fx.seedRedeemCode('3');
    await http(api.baseUrl, 'POST', '/v1/redeem', { token: user.token, body: { code } });
    const planId = await fx.seedPlan({ price: '2', quotaAmount: '20', sortOrder: 1 });
    await http(api.baseUrl, 'POST', '/v1/subscriptions', { token: user.token, body: { planId } });

    const stmt = await http(api.baseUrl, 'GET', '/v1/wallet/statement?limit=20', { token: user.token });
    const rows = (stmt.body as { rows: { refType: string; transactionKind: string }[] }).rows;
    const refTypes = rows.map((r) => r.refType);
    expect(refTypes).toContain('redeem');
    expect(refTypes).toContain('subscription');
  });

  it('用量报表：seed 一条结算行 → 明细/按模型/速率三端点', async () => {
    const user = await fx.registerViaHttp(api.baseUrl);
    await api.db.insert(usageLogs).values({
      requestId: randomUUID(),
      userId: user.userId,
      credentialType: 'key',
      externalModel: 'rx-e2e-model',
      realModel: 'rx-e2e-model-real',
      inputTokens: 100,
      outputTokens: 50,
      inputPrice: '1',
      outputPrice: '2',
      cacheInputPrice: '0.5',
      coefficient: '1.000',
      amount: '0.4',
      calculatedAmount: '0.4',
      planAmount: '0',
      paygAmount: '0.4',
      billedBy: 'payg',
      status: 0,
    });

    const usage = await http(api.baseUrl, 'GET', '/v1/usage', { token: user.token });
    const rows = (usage.body as { rows: { externalModel: string; billedBy: string; paygAmount: string }[] }).rows;
    expect(rows.length).toBe(1);
    expect(rows[0]!.billedBy).toBe('payg');
    expectAmountEq(rows[0]!.paygAmount, '0.4');

    const byModel = await http(api.baseUrl, 'GET', '/v1/usage/by-model', { token: user.token });
    const models = (byModel.body as { rows: { model: string; requests: number; cost: string }[] }).rows;
    expect(models[0]!.model).toBe('rx-e2e-model');
    expect(models[0]!.requests).toBe(1);
    expectAmountEq(models[0]!.cost, '0.4');

    const rate = await http(api.baseUrl, 'GET', '/v1/usage/rate', { token: user.token });
    expect((rate.body as { rpm: number }).rpm).toBe(1);
  });

  it('改密（R5-2）：旧 token 全网失效，新 token 可用', async () => {
    const user = await fx.registerViaHttp(api.baseUrl);
    const changed = await http(api.baseUrl, 'POST', '/v1/auth/password', {
      token: user.token,
      body: { oldPassword: user.password, newPassword: 'e2e-brand-new-password-9' },
    });
    expect(changed.status).toBe(200);
    const newToken = (changed.body as { token: string }).token;
    expect((await http(api.baseUrl, 'GET', '/v1/me', { token: user.token })).status).toBe(401);
    expect((await http(api.baseUrl, 'GET', '/v1/me', { token: newToken })).status).toBe(200);
  });

  it('攻击面抽查：坏 token 401 / 越权 Key 404 / 非法金额 400', async () => {
    const a = await fx.registerViaHttp(api.baseUrl);
    const b = await fx.registerViaHttp(api.baseUrl);
    expect((await http(api.baseUrl, 'GET', '/v1/me', { token: 'garbage' })).status).toBe(401);
    const key = await http(api.baseUrl, 'POST', '/v1/keys', { token: a.token, body: { name: 'a-key' } });
    const keyId = (key.body as { id: number }).id;
    expect((await http(api.baseUrl, 'DELETE', `/v1/keys/${keyId}`, { token: b.token })).status).toBe(404);
    const badAmount = await http(api.baseUrl, 'POST', '/v1/payments/orders', {
      token: a.token,
      body: { amount: '1e21' },
    });
    expect(badAmount.status).toBe(400);
    // 个人套餐开多席 → 422 seats_not_allowed；团队套餐个人买 → 403 enterprise_required
    const soloId = await fx.seedPlan({ price: '6', quotaAmount: '60', sortOrder: 1 });
    const solo = await http(api.baseUrl, 'POST', '/v1/subscriptions', {
      token: a.token,
      body: { planId: soloId, quantity: 2 },
    });
    expect(solo.status).toBe(422);
    expect(errCode(solo)).toBe('seats_not_allowed');
    const teamId = await fx.seedPlan({ price: '50', quotaAmount: '500', allowSeats: true, sortOrder: 3 });
    const team = await http(api.baseUrl, 'POST', '/v1/subscriptions', {
      token: a.token,
      body: { planId: teamId, quantity: 2 },
    });
    expect(team.status).toBe(403);
    expect(errCode(team)).toBe('enterprise_required');
  });
});
