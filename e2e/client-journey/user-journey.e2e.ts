/**
 * 用户旅程 E2E（老仓 e2e-user-journey 迁移+扩展，总纲 §3 归根 e2e/client-journey）：
 * 注册两步制 → 资料 → Key 生命周期 → 只读面 → 兑换（失败+成功）→ epay 充值
 * （签名回调 + 幂等重放 + 金额篡改拒绝）→ 订阅购买 → 钱包对账（余额分文不差）→
 * 登出吊销 → 两级登录 → 改密全网下线 → 复登。真实 PG/Redis/HTTP。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Decimal } from '@tillgate/billing';
import {
  apiClient,
  bootHarness,
  cleanupSeeds,
  cleanupUsers,
  infraReady,
  registerUser,
  reservePort,
  seedPlan,
  seedRedeemCode,
  sendEpayNotify,
  walletBalance,
  type E2eHarness,
} from './harness.js';

const context = describe.skipIf(!(await infraReady()));

let h: E2eHarness;
let api: ReturnType<typeof apiClient>;
const runTag = `e2e-uj-${Date.now().toString(36)}`;
const email = `${runTag}@example.com`;
const password = 'journey-password-123';
const redeemCode = `E2E-REDEEM-${runTag}`;
let userId = 0;
let planId = 0;

beforeAll(async () => {
  const port = await reservePort();
  h = await bootHarness({ appPort: port });
  api = apiClient(h.baseUrl);
  await seedRedeemCode(h.assembly.db, redeemCode, '5');
  planId = await seedPlan(h.assembly.db, 'e2e-personal', false);
});

afterAll(async () => {
  if (userId !== 0) await cleanupUsers(h.assembly.db, [{ id: userId, email }]);
  await cleanupSeeds(h.assembly.db);
  await h.teardown();
});

context('用户旅程（老仓 e2e-user-journey 全链核销）', () => {
  it('注册 → 生命周期 → 资金面（兑换/充值/订阅/对账）→ 会话安全', async () => {
    // ── 注册两步制 ──
    expect((await api('/healthz')).status).toBe(200);
    const caps = (await (await api('/v1/auth/capabilities')).json()) as {
      registerEnabled: boolean;
      emailCodeRequired: boolean;
    };
    expect(caps).toEqual({ registerEnabled: true, captchaSiteKey: null, emailCodeRequired: true });

    const reg = await api('/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    const regBody = (await reg.json()) as { kind: string; challengeId: string };
    expect(regBody.kind).toBe('code_required');
    const ver = await api('/v1/auth/register/verify', {
      method: 'POST',
      body: JSON.stringify({
        challengeId: regBody.challengeId,
        code: h.mailer.lastCodeOf(email),
      }),
    });
    expect(ver.status).toBe(201);
    const verBody = (await ver.json()) as { token: string; userId: number; email: string };
    expect(verBody.email).toBe(email);
    userId = verBody.userId;
    let token = verBody.token;

    // 挑战单次消费（重放 400）
    expect(
      (
        await api('/v1/auth/register/verify', {
          method: 'POST',
          body: JSON.stringify({
            challengeId: regBody.challengeId,
            code: h.mailer.lastCodeOf(email),
          }),
        })
      ).status,
    ).toBe(400);

    // ── 资料与 Key 生命周期 ──
    expect(((await (await api('/v1/me', { token })).json()) as { id: number }).id).toBe(userId);
    expect(
      await (
        await api('/v1/me/display-name', {
          method: 'PATCH',
          token,
          body: JSON.stringify({ displayName: 'Journey User' }),
        })
      ).json(),
    ).toEqual({ displayName: 'Journey User' });

    const keyCreated = (await (
      await api('/v1/keys', {
        method: 'POST',
        token,
        body: JSON.stringify({ name: 'journey-key', rpmLimit: 10, dailySpendLimit: '5' }),
      })
    ).json()) as { id: number; plaintext: string };
    expect(keyCreated.plaintext.startsWith('sk_')).toBe(true);
    const rotated = (await (
      await api(`/v1/keys/${keyCreated.id}/rotate`, { method: 'POST', token })
    ).json()) as { id: number; plaintext: string };
    const deleted = (await (
      await api(`/v1/keys/${rotated.id}`, { method: 'DELETE', token })
    ).json()) as { id: number };
    expect(deleted).toEqual({ id: rotated.id });

    // ── 资金面：基线余额（建号赠送可能为 0——按增量对账） ──
    const afterGift = new Decimal(await walletBalance(api, token));

    // 兑换失败语义（未知码 404）
    expect(
      (
        await api('/v1/redeem', {
          method: 'POST',
          token,
          body: JSON.stringify({ code: 'NO-SUCH' }),
        })
      ).status,
    ).toBe(404);

    // 兑换成功：余额 +5，回执金额与余额一致
    const redeemRes = await api('/v1/redeem', {
      method: 'POST',
      token,
      body: JSON.stringify({ code: redeemCode }),
    });
    expect(redeemRes.status).toBe(200);
    const redeemBody = (await redeemRes.json()) as { amount: string; balanceAfter: string };
    const afterRedeem = new Decimal(await walletBalance(api, token));
    expect(afterRedeem.minus(afterGift).toString()).toBe('5');
    expect(redeemBody.amount).toBe('5');
    expect(redeemBody.balanceAfter).toBe(afterRedeem.toString());

    // epay 充值：下单（payUrl 带签名参数）→ 签名回调入账 → 重复回调幂等 → 金额篡改拒绝
    const channels = (await (await api('/v1/payments/channels', { token })).json()) as {
      channels: Array<{ id: string }>;
    };
    expect(channels.channels.map((c) => c.id)).toEqual(['epay']);

    const order = (await (
      await api('/v1/payments/orders', {
        method: 'POST',
        token,
        body: JSON.stringify({ amount: '10', provider: 'epay' }),
      })
    ).json()) as { orderId: string; payUrl: string; creditAmount: string };
    expect(order.creditAmount).toBe('10');
    expect(order.payUrl).toContain('pid=e2e-pid');
    expect(order.payUrl).toContain('sign=');

    const notify1 = await sendEpayNotify(api, h.baseUrl, h.epay, order.orderId, '10');
    expect(notify1.text).toBe('success');
    const detail = (await (
      await api(`/v1/payments/orders/${order.orderId}`, { token })
    ).json()) as { status: number; creditAmount: string };
    expect(detail.status).toBe(2); // 已入账
    const afterTopup = new Decimal(await walletBalance(api, token));
    expect(afterTopup.minus(afterRedeem).toString()).toBe('10');

    // 重复回调幂等（status=2 → 直接 success，不重复入账）
    const notify2 = await sendEpayNotify(api, h.baseUrl, h.epay, order.orderId, '10');
    expect(notify2.text).toBe('success');
    expect(new Decimal(await walletBalance(api, token)).toString()).toBe(afterTopup.toString());

    // 金额篡改：验签基于原参数——money 改动后签名不匹配 → fail，不入账
    const tampered = await sendEpayNotify(api, h.baseUrl, h.epay, order.orderId, '999');
    expect(tampered.text).toBe('fail');
    expect(new Decimal(await walletBalance(api, token)).toString()).toBe(afterTopup.toString());

    // ── 订阅购买（余额扣款）与我的订阅视图 ──
    const purchase = await api('/v1/subscriptions', {
      method: 'POST',
      headers: { 'idempotency-key': `e2e-buy-${runTag}` },
      token,
      body: JSON.stringify({ planId }),
    });
    expect(purchase.status).toBe(201);
    const purchaseBody = (await purchase.json()) as {
      subscriptionId: number;
      price: string;
      balanceAfter: string;
      replayed: boolean;
    };
    expect(purchaseBody.replayed).toBe(false);
    expect(purchaseBody.price).toBe('1');

    // 幂等重放：同 idempotency-key → replayed=true、余额不再扣
    const replayBuy = await api('/v1/subscriptions', {
      method: 'POST',
      headers: { 'idempotency-key': `e2e-buy-${runTag}` },
      token,
      body: JSON.stringify({ planId }),
    });
    expect(((await replayBuy.json()) as { replayed: boolean }).replayed).toBe(true);

    const afterBuy = new Decimal(await walletBalance(api, token));
    expect(afterBuy.plus('1').toString()).toBe(afterTopup.toString());

    const subs = (await (await api('/v1/subscriptions', { token })).json()) as {
      rows: Array<{ quotaAmount: string; remainingAmount: string; renewPrice: string }>;
    };
    // 存储层 numeric 全精度串（v1 同形）——按 Decimal 归一后比较
    expect(new Decimal(subs.rows[0]?.quotaAmount ?? 'x').toString()).toBe('10');
    expect(new Decimal(subs.rows[0]?.remainingAmount ?? 'x').toString()).toBe('10');
    expect(new Decimal(subs.rows[0]?.renewPrice ?? 'x').toString()).toBe('1');

    // 钱包对账：流水含 gift?/redeem/topup/subscription 四域腿 + 余额分文不差
    const statement = (await (await api('/v1/wallet/statement?limit=50', { token })).json()) as {
      rows: Array<{ refType: string }>;
    };
    const refTypes = new Set(statement.rows.map((r) => r.refType));
    expect(refTypes.has('redeem')).toBe(true);
    expect(refTypes.has('topup')).toBe(true);
    expect(refTypes.has('subscription')).toBe(true);
    expect(new Decimal(await walletBalance(api, token)).toString()).toBe(
      afterGift.plus('5').plus('10').minus('1').toString(),
    );

    // ── 会话安全 ──
    expect(await (await api('/v1/auth/logout', { method: 'POST', token })).json()).toEqual({
      ok: true,
    });
    expect((await api('/v1/me', { token })).status).toBe(401);

    const wrong = await api('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'wrong-password-1' }),
    });
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe(
      'identity.invalid_credentials',
    );

    const login = (await (
      await api('/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      })
    ).json()) as { kind: string; challengeId: string };
    expect(login.kind).toBe('code_required');
    token = (
      (await (
        await api('/v1/auth/login/verify', {
          method: 'POST',
          body: JSON.stringify({
            challengeId: login.challengeId,
            code: h.mailer.lastCodeOf(email),
          }),
        })
      ).json()) as { token: string }
    ).token;

    const changed = (await (
      await api('/v1/auth/password', {
        method: 'POST',
        token,
        body: JSON.stringify({ oldPassword: password, newPassword: 'journey-password-456' }),
      })
    ).json()) as { token: string };
    expect((await api('/v1/me', { token })).status).toBe(401);
    expect((await api('/v1/me', { token: changed.token })).status).toBe(200);

    const relogin = (await (
      await api('/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password: 'journey-password-456' }),
      })
    ).json()) as { challengeId: string };
    const reVerify = await api('/v1/auth/login/verify', {
      method: 'POST',
      body: JSON.stringify({
        challengeId: relogin.challengeId,
        code: h.mailer.lastCodeOf(email),
      }),
    });
    expect(reVerify.status).toBe(200);
  }, 180_000);
});
