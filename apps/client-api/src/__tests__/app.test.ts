/**
 * 全链 HTTP 套件（真 PG + app.fetch）：注册→登录→me→Key→兑换→充值→回调→流水
 * 的用户闭环 + 会话中间件安全语义（失效线/封禁/类型隔离）+ 协议信封（400/404/healthz）。
 */
import { describe, expect, it } from 'vitest';
import { Decimal } from '@ai-gateway/domain';
import { eq } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import { users } from '@ai-gateway/db';
import { signSession } from '@ai-gateway/identity';
import { assembleClientApi } from '../assembly.js';
import { createApp } from '../app.js';
import type { ClientApiConfig } from '../config.js';
import { waitForRedisReady } from '@ai-gateway/core';
import { epaySign } from '../domain/epay.js';
import {
  balanceOf,
  db,
  email,
  expectAmountEq,
  newRedeemCode,
  newUser,
  password,
} from './helpers.js';

const JWT_SECRET = 'app-test-secret-0123456789abcdef';
const EPAY = {
  pid: '1001',
  key: 'test-epay-key',
  gatewayUrl: 'https://pay.example.com/submit.php',
  notifyUrl: 'https://api.example.com/v1/payments/notify/epay',
  returnUrl: 'https://console.example.com/wallet',
};

function buildConfig(overrides: Partial<ClientApiConfig> = {}): ClientApiConfig {
  return {
    DATABASE_URL: 'postgres://unused',
    REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
    PORT: 0,
    DB_POOL_MAX: 5,
    CLIENT_CURRENCY: 'CNY',
    JWT_SECRET,
    SESSION_TTL_SECONDS: 3_600,
    REGISTER_ENABLED: true,
    GIFT_AMOUNT: '0',
    MAX_KEYS_PER_USER: 20,
    REGISTER_IP_LIMIT_PER_HOUR: 5,
    LOGIN_FAILURE_THRESHOLD: 5,
    LOGIN_FAILURE_WINDOW_S: 600,
    LOGIN_LOCK_S: 600,
    LOGIN_IP_FAILURE_LIMIT: 50,
    LOGIN_IP_FAILURE_WINDOW_S: 300,
    TRUSTED_PROXY_HOPS: 0,
    CORS_ORIGINS: '',
    BODY_LIMIT_BYTES: 65_536,
    TOPUP_MIN: '1',
    TOPUP_MAX: '10000',
    TOPUP_EXCHANGE_RATE: '1',
    PAYMENT_ORDER_TTL_MS: 1_800_000,
    REFERRAL_SIGNUP_BONUS: '0',
    REFERRAL_COMMISSION_RATE: '0',
    EPAY_PID: EPAY.pid,
    EPAY_KEY: EPAY.key,
    EPAY_GATEWAY_URL: EPAY.gatewayUrl,
    EPAY_NOTIFY_URL: EPAY.notifyUrl,
    EPAY_RETURN_URL: EPAY.returnUrl,
    CLIENT_SHUTDOWN_GRACE_MS: 1_000,
    OTEL_TRACES_MODE: 'off',
    OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
    ...overrides,
  } as ClientApiConfig;
}

async function buildApp(config = buildConfig()) {
  const assembly = assembleClientApi(config, db);
  // 冷连接预热（offline queue 关闭：healthz 探针前的首个 ping 会因未就绪被拒）
  await waitForRedisReady(assembly.redis);
  return {
    app: createApp({
      db,
      assembly,
      revocationStore: assembly.revocationStore,
      jwtSecret: config.JWT_SECRET,
      trustedProxyHops: config.TRUSTED_PROXY_HOPS,
      corsOrigins: [],
      bodyLimitBytes: config.BODY_LIMIT_BYTES,
    }),
    assembly,
  };
}

const json = (res: Response) => res.json() as Promise<Record<string, unknown>>;
const authed = (token: string) => ({ authorization: `Bearer ${token}` });

describe('用户闭环（HTTP 全链）', () => {
  it('注册 fail-closed（无 SMTP → 503）→ 登录→me→Key→兑换→充值→回调→流水', async () => {
    const { app } = await buildApp();
    const account = await newUser();
    const mail = account.email;

    // 注册恒两步（邮箱所有权验证）：本装配无 SMTP → 503 绝不单步建号
    const regRes = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email(), password: password() }),
    });
    expect(regRes.status).toBe(503);

    // 单步登录（EMAIL_CODE_REQUIRED=off 测试形态）拿会话
    const loginRes = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: mail, password: 'correct-horse-battery' }),
    });
    expect(loginRes.status).toBe(200);
    const reg = (await json(loginRes)) as { token: string; userId: number };
    expect(reg.token).toBeTruthy();

    // me（余额 0 起步）
    const meRes = await app.request('/v1/me', { headers: authed(reg.token) });
    expect(meRes.status).toBe(200);
    const me = (await json(meRes)) as { email: string; accounts: { currency: string; available: string }[] };
    expect(me.email).toBe(mail);

    // Key：创建（明文一次出库）→ 列表无哈希
    const keyRes = await app.request('/v1/keys', {
      method: 'POST',
      headers: { ...authed(reg.token), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'e2e' }),
    });
    expect(keyRes.status).toBe(201);
    const key = (await json(keyRes)) as { id: number; plaintext: string };
    const listRes = await app.request('/v1/keys', { headers: authed(reg.token) });
    const listBody = await json(listRes);
    expect(JSON.stringify(listBody)).not.toContain(key.plaintext);

    // 兑换码入账
    const code = await newRedeemCode({ amount: '4.5' });
    const redeemRes = await app.request('/v1/redeem', {
      method: 'POST',
      headers: { ...authed(reg.token), 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.plaintext }),
    });
    expect(redeemRes.status).toBe(200);
    expectAmountEq(await balanceOf(reg.userId), '4.5');

    // 充值下单 → 渠道回调（form-encoded）→ 入账
    const orderRes = await app.request('/v1/payments/orders', {
      method: 'POST',
      headers: { ...authed(reg.token), 'content-type': 'application/json' },
      body: JSON.stringify({ amount: '10' }),
    });
    expect(orderRes.status).toBe(201);
    const order = (await json(orderRes)) as { orderId: string };
    const notifyParams: Record<string, string> = {
      pid: EPAY.pid,
      out_trade_no: order.orderId,
      trade_status: 'TRADE_SUCCESS',
      money: '10',
    };
    notifyParams.sign = epaySign(notifyParams, EPAY.key);
    notifyParams.sign_type = 'MD5';
    const notifyRes = await app.request('/v1/payments/notify/epay', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(notifyParams).toString(),
    });
    expect(await notifyRes.text()).toBe('success');
    expectAmountEq(await balanceOf(reg.userId), '14.5');

    // 流水（腿级，能看到两笔 credit）
    const stmtRes = await app.request('/v1/wallet/statement?limit=10', { headers: authed(reg.token) });
    expect(stmtRes.status).toBe(200);
    const stmt = (await json(stmtRes)) as { rows: { refType: string }[] };
    const refTypes = stmt.rows.map((r) => r.refType);
    expect(refTypes).toContain('redeem');
    expect(refTypes).toContain('topup');

    // 订单列表只含本人
    const ordersRes = await app.request('/v1/payments/orders', { headers: authed(reg.token) });
    const orders = (await json(ordersRes)) as { rows: { id: string; status: number }[] };
    expect(orders.rows.length).toBe(1);
    expect(orders.rows[0]!.status).toBe(2);
  });
});

describe('支付多渠道（Stripe 路由层）', () => {
  const STRIPE_GROUP = {
    STRIPE_SECRET_KEY: 'sk_test_app',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_app',
    STRIPE_SUCCESS_URL: 'https://console.example.com/billing?ok=1',
    STRIPE_CANCEL_URL: 'https://console.example.com/billing?cancel=1',
  };
  const EPAY_OFF = {
    EPAY_PID: undefined,
    EPAY_KEY: undefined,
    EPAY_GATEWAY_URL: undefined,
    EPAY_NOTIFY_URL: undefined,
    EPAY_RETURN_URL: undefined,
  };

  async function tokenOf(userId: number): Promise<string> {
    return signSession({ type: 'user', id: userId }, JWT_SECRET);
  }

  it('双渠道：channels 端点齐全；下单未指定渠道 503（须显式选择）', async () => {
    const { app } = await buildApp(buildConfig(STRIPE_GROUP));
    const account = await newUser();
    const token = await tokenOf(account.id);

    const chRes = await app.request('/v1/payments/channels', { headers: authed(token) });
    expect(chRes.status).toBe(200);
    expect(await json(chRes)).toEqual({
      channels: [
        { id: 'epay', label: '在线支付（支付宝/微信）' },
        { id: 'stripe', label: 'Stripe（国际卡）' },
      ],
    });

    const orderRes = await app.request('/v1/payments/orders', {
      method: 'POST',
      headers: { ...authed(token), 'content-type': 'application/json' },
      body: JSON.stringify({ amount: '10' }),
    });
    expect(orderRes.status).toBe(503);
    expect(((await json(orderRes)) as { error: { code: string } }).error.code).toBe('payment_unavailable');
  });

  it('渠道未启用：stripe 未配置时显式请求 → 503；channels 空；未登录 channels 401', async () => {
    const { app } = await buildApp(buildConfig(EPAY_OFF));
    const account = await newUser();
    const token = await tokenOf(account.id);

    const chRes = await app.request('/v1/payments/channels', { headers: authed(token) });
    expect(chRes.status).toBe(200);
    expect(await json(chRes)).toEqual({ channels: [] });

    expect(
      (await app.request('/v1/payments/channels')).status,
    ).toBe(401);

    const orderRes = await app.request('/v1/payments/orders', {
      method: 'POST',
      headers: { ...authed(token), 'content-type': 'application/json' },
      body: JSON.stringify({ amount: '10', provider: 'stripe' }),
    });
    expect(orderRes.status).toBe(503);
  });

  it('stripe webhook 路由：真签名但未知 session → 400 received:false；坏签名 → 400；未知渠道 → 404', async () => {
    const { app } = await buildApp(buildConfig(STRIPE_GROUP));
    const payload = JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_unknown', client_reference_id: '00000000-0000-0000-0000-000000000000', amount_total: 1000 } },
    });
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', STRIPE_GROUP.STRIPE_WEBHOOK_SECRET)
      .update(`${t}.${payload}`)
      .digest('hex');

    const badRes = await app.request('/v1/payments/notify/stripe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
      body: payload,
    });
    expect(badRes.status).toBe(400);
    expect(await json(badRes)).toEqual({ received: false });

    const goodRes = await app.request('/v1/payments/notify/stripe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${v1}` },
      body: payload,
    });
    expect(goodRes.status).toBe(400); // 验签通过但订单不存在——fail 应答

    expect(
      (await app.request('/v1/payments/notify/alipay', { method: 'POST', body: '' })).status,
    ).toBe(404);
  });
});

describe('邀请返利（注册归因全链 HTTP）', () => {
  it('aff 归因（建号后 apply）→ 双方奖励入账 → 邀请人概览可见被邀人', async () => {
    // HTTP 注册已恒两步（无 SMTP → 503）；aff 归因链路 = verifyRegistration 建号后
    // referral.apply（两步 HTTP 形态在 auth-code.test 全覆盖，此处钉归因与奖励闭环）
    const { app, assembly } = await buildApp(buildConfig({}));
    // 营销参数 DB 化：邀请奖励经 marketing_settings 注入（原 env 形态已删除）
    const { marketingSettings } = await import('@ai-gateway/db');
    const helpers = await import('./helpers.js');
    await helpers.db.update(marketingSettings).set({ referralSignupBonus: '5' }).where(eq(marketingSettings.id, 1));
    const inviter = await newUser();
    const invitee = await newUser();
    const aff = `u${inviter.id.toString(36)}`;

    await (assembly.referralService as unknown as {
      applyReferral: (ctx: unknown, input: { inviteeId: number; affCode: string }) => Promise<unknown>;
    }).applyReferral(
      { requestId: 'aff-e2e', actor: { kind: 'system' }, traceParent: null },
      { inviteeId: invitee.id, affCode: aff },
    );

    // 双方各得 5 元注册奖励
    expectAmountEq(await balanceOf(inviter.id), '5');
    expectAmountEq(await balanceOf(invitee.id), '5');

    // 邀请人登录拿会话 → 概览：名单含被邀人、邀请链接带自己的 aff 码
    const loginRes = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: inviter.email, password: 'correct-horse-battery' }),
    });
    const inviterReg = (await json(loginRes)) as { token: string };
    const overviewRes = await app.request('/v1/referrals', { headers: authed(inviterReg.token) });
    expect(overviewRes.status).toBe(200);
    const overview = (await json(overviewRes)) as {
      affCode: string;
      inviteUrl: string;
      signupBonus: number;
      invited: { inviteeId: number }[];
      totalCommission: string;
    };
    expect(overview.affCode).toBe(aff);
    expect(overview.inviteUrl).toContain(`/register?aff=${aff}`);
    expect(new Decimal(overview.signupBonus).eq('5')).toBe(true); // DB numeric 全精度串
    expect(overview.invited.map((r) => r.inviteeId)).toContain(invitee.id);
    expectAmountEq(overview.totalCommission, '0');

    // 未登录 401
    expect((await app.request('/v1/referrals')).status).toBe(401);
  });
});

describe('会话中间件安全语义', () => {
  it('无/坏/异型 token 一律 401', async () => {
    const { app } = await buildApp();
    const account = await newUser();
    expect((await app.request('/v1/me')).status).toBe(401);
    expect((await app.request('/v1/me', { headers: authed('garbage') })).status).toBe(401);
    // 管理面类型 token（同密钥签发）在用户面永远无效——物理隔离
    const adminToken = await signSession({ type: 'admin', id: 1 }, JWT_SECRET);
    expect((await app.request('/v1/me', { headers: authed(adminToken) })).status).toBe(401);
    // 异密钥签发的用户 token
    const foreignToken = await signSession({ type: 'user', id: account.id }, 'another-secret-1234567890');
    expect((await app.request('/v1/me', { headers: authed(foreignToken) })).status).toBe(401);
    void account;
  });

  it('封禁即时生效：status=1 → 401', async () => {
    const { app } = await buildApp();
    const account = await newUser();
    const token = await signSession({ type: 'user', id: account.id }, JWT_SECRET);
    expect((await app.request('/v1/me', { headers: authed(token) })).status).toBe(200);
    await db.update(users).set({ status: 1 }).where(eq(users.id, account.id));
    expect((await app.request('/v1/me', { headers: authed(token) })).status).toBe(401);
  });

  it('改密后旧 token 全网失效（R5-2），新 token 可用', async () => {
    const { app } = await buildApp();
    const account = await newUser();
    const oldToken = await signSession({ type: 'user', id: account.id }, JWT_SECRET);
    expect((await app.request('/v1/me', { headers: authed(oldToken) })).status).toBe(200);

    const res = await app.request('/v1/auth/password', {
      method: 'POST',
      headers: { ...authed(oldToken), 'content-type': 'application/json' },
      body: JSON.stringify({ oldPassword: password(), newPassword: 'brand-new-password-7' }),
    });
    expect(res.status).toBe(200);
    const { token: newToken } = (await json(res)) as { token: string };
    expect((await app.request('/v1/me', { headers: authed(oldToken) })).status).toBe(401);
    expect((await app.request('/v1/me', { headers: authed(newToken) })).status).toBe(200);
  });
});

describe('协议信封', () => {
  it('healthz ok；未知路径 404 信封；zod 拒绝 400 信封', async () => {
    const { app } = await buildApp();
    expect((await app.request('/healthz')).status).toBe(200);
    const notFound = await app.request('/v1/nope');
    expect(notFound.status).toBe(404);
    expect(((await json(notFound)).error as { code: string }).code).toBe('not_found');
    const bad = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: 'x' }),
    });
    expect(bad.status).toBe(400);
    expect(((await json(bad)).error as { code: string }).code).toBe('invalid_request');
  });

  it('超大请求体 413 提前拒绝', async () => {
    const { app } = await buildApp(buildConfig({ BODY_LIMIT_BYTES: 100 }));
    const res = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '5000' },
      body: 'x'.repeat(5000),
    });
    expect(res.status).toBe(413);
  });

  it('RED（v1 keys.numeric-limit 同类）：dailySpendLimit=1e21 → 400 信封，不是 500', async () => {
    const { app } = await buildApp();
    const account = await newUser();
    const token = await signSession({ type: 'user', id: account.id }, JWT_SECRET);
    const res = await app.request('/v1/keys', {
      method: 'POST',
      headers: { ...authed(token), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'attack', dailySpendLimit: '1e21' }),
    });
    expect(res.status).toBe(400);
    expect(((await json(res)).error as { code: string }).code).toBe('invalid_request');
  });

  it('CORS：白名单外 origin 不放行', async () => {
    const { app } = await buildApp(buildConfig({ CORS_ORIGINS: 'https://console.example.com' }));
    const denied = await app.request('/v1/me', {
      headers: { origin: 'https://evil.example.net' },
    });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('登出即时下线（jti 吊销表）', () => {
  it('login → logout → 同一 token 立即 401（不再活到 TTL）', async () => {
    const { app } = await buildApp(buildConfig({ EMAIL_CODE_REQUIRED: 'off' }));
    const account = await newUser();
    const login = (await json(
      await app.request('/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: account.email, password: 'correct-horse-battery' }),
      }),
    )) as { token: string };
    expect(login.token).toBeTruthy();

    // 登出前可用
    const before = await app.request('/v1/me', {
      headers: { authorization: `Bearer ${login.token}` },
    });
    expect(before.status).toBe(200);

    // 登出（吊销 jti）
    const logout = await app.request('/v1/auth/logout', {
      method: 'POST',
      headers: { authorization: `Bearer ${login.token}` },
    });
    expect(logout.status).toBe(200);

    // 登出后同一 token 401（Redis 键存活至令牌自然过期）
    const after = await app.request('/v1/me', {
      headers: { authorization: `Bearer ${login.token}` },
    });
    expect(after.status).toBe(401);
  }, 30_000);
});
