/**
 * 用户旅程 E2E（老仓 e2e-user-journey 迁移+扩展，总纲 §3 归根 e2e/client-journey）：
 * 注册两步制 → 资料 → Key 生命周期 → 只读面 → 兑换（失败+成功）→ epay 充值
 * （签名回调 + 幂等重放 + 金额篡改拒绝）→ 订阅购买 → 钱包对账（余额分文不差）→
 * 登出吊销 → 两级登录 → 改密全网下线 → 复登。真实 PG/Redis/HTTP。
 * 旅程步骤拆为模块级阶段函数（.e2e.ts 不在 root override 的 *.test.ts 放宽集内——
 * 规模限制生效；断言逐字随迁，仅变量管道化）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Decimal } from '@tillgate/billing';
import {
  apiClient,
  bootHarness,
  cleanupSeeds,
  cleanupUsers,
  infraReady,
  reservePort,
  seedPlan,
  seedRedeemCode,
  sendEpayNotify,
  walletBalance,
  type E2eHarness,
} from './harness.js';

const context = describe.skipIf(!(await infraReady()));

/** 用户面 API 客户端形状（阶段函数入参） */
type Api = ReturnType<typeof apiClient>;

let h: E2eHarness;
let api: Api;
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

// ---------------------------------------------------------------------------
// 旅程阶段（模块级——it 体保持线性编排，断言与原实现逐字等价）
// ---------------------------------------------------------------------------

/** 注册会话（两步制产物——后续阶段的入参） */
interface Session {
  token: string;
  userId: number;
}

/** ── 注册两步制（含挑战单次消费）── */
async function registerTwoStep(
  client: Api,
  harness: E2eHarness,
  input: { email: string; password: string },
): Promise<Session> {
  expect((await client('/healthz')).status).toBe(200);
  const caps = (await (await client('/v1/auth/capabilities')).json()) as {
    registerEnabled: boolean;
    emailCodeRequired: boolean;
  };
  expect(caps).toEqual({ registerEnabled: true, captchaSiteKey: null, emailCodeRequired: true });

  const reg = await client('/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email: input.email, password: input.password }),
  });
  const regBody = (await reg.json()) as { kind: string; challengeId: string };
  expect(regBody.kind).toBe('code_required');
  const ver = await client('/v1/auth/register/verify', {
    method: 'POST',
    body: JSON.stringify({
      challengeId: regBody.challengeId,
      code: harness.mailer.lastCodeOf(input.email),
    }),
  });
  expect(ver.status).toBe(201);
  const verBody = (await ver.json()) as { token: string; userId: number; email: string };
  expect(verBody.email).toBe(input.email);

  // 挑战单次消费（重放 400）
  expect(
    (
      await client('/v1/auth/register/verify', {
        method: 'POST',
        body: JSON.stringify({
          challengeId: regBody.challengeId,
          code: harness.mailer.lastCodeOf(input.email),
        }),
      })
    ).status,
  ).toBe(400);
  return { token: verBody.token, userId: verBody.userId };
}

/** ── 资料与 Key 生命周期 ── */
async function profileAndKeyLifecycle(client: Api, session: Session): Promise<void> {
  const { token, userId: uid } = session;
  expect(((await (await client('/v1/me', { token })).json()) as { id: number }).id).toBe(uid);
  expect(
    await (
      await client('/v1/me/display-name', {
        method: 'PATCH',
        token,
        body: JSON.stringify({ displayName: 'Journey User' }),
      })
    ).json(),
  ).toEqual({ displayName: 'Journey User' });

  const keyCreated = (await (
    await client('/v1/keys', {
      method: 'POST',
      token,
      body: JSON.stringify({ name: 'journey-key', rpmLimit: 10, dailySpendLimit: '5' }),
    })
  ).json()) as { id: number; plaintext: string };
  expect(keyCreated.plaintext.startsWith('sk_')).toBe(true);
  const rotated = (await (
    await client(`/v1/keys/${keyCreated.id}/rotate`, { method: 'POST', token })
  ).json()) as { id: number; plaintext: string };
  const deleted = (await (
    await client(`/v1/keys/${rotated.id}`, { method: 'DELETE', token })
  ).json()) as { id: number };
  expect(deleted).toEqual({ id: rotated.id });
}

/** 资金面基线与兑换产出（后续对账的锚点余额） */
interface RedeemOutcome {
  afterGift: Decimal;
  afterRedeem: Decimal;
}

/** ── 资金面：基线余额（建号赠送可能为 0——按增量对账）+ 兑换（失败+成功）── */
async function redeemFlow(
  client: Api,
  token: string,
  input: { redeemCode: string },
): Promise<RedeemOutcome> {
  const afterGift = new Decimal(await walletBalance(client, token));

  // 兑换失败语义（未知码 404）
  expect(
    (
      await client('/v1/redeem', {
        method: 'POST',
        token,
        body: JSON.stringify({ code: 'NO-SUCH' }),
      })
    ).status,
  ).toBe(404);

  // 兑换成功：余额 +5，回执金额与余额一致
  const redeemRes = await client('/v1/redeem', {
    method: 'POST',
    token,
    body: JSON.stringify({ code: input.redeemCode }),
  });
  expect(redeemRes.status).toBe(200);
  const redeemBody = (await redeemRes.json()) as { amount: string; balanceAfter: string };
  const afterRedeem = new Decimal(await walletBalance(client, token));
  expect(afterRedeem.minus(afterGift).toString()).toBe('5');
  expect(redeemBody.amount).toBe('5');
  expect(redeemBody.balanceAfter).toBe(afterRedeem.toString());
  return { afterGift, afterRedeem };
}

/** ── epay 充值：下单（payUrl 带签名参数）→ 签名回调入账 → 重复回调幂等 → 金额篡改拒绝 ── */
async function epayTopupFlow(
  client: Api,
  harness: E2eHarness,
  input: { token: string; afterRedeem: Decimal },
): Promise<{ afterTopup: Decimal }> {
  const { token } = input;
  const channels = (await (await client('/v1/payments/channels', { token })).json()) as {
    channels: Array<{ id: string }>;
  };
  expect(channels.channels.map((c) => c.id)).toEqual(['epay']);

  const order = (await (
    await client('/v1/payments/orders', {
      method: 'POST',
      token,
      body: JSON.stringify({ amount: '10', provider: 'epay' }),
    })
  ).json()) as { orderId: string; payUrl: string; creditAmount: string };
  expect(order.creditAmount).toBe('10');
  expect(order.payUrl).toContain('pid=e2e-pid');
  expect(order.payUrl).toContain('sign=');

  const notify1 = await sendEpayNotify(client, {
    epay: harness.epay,
    orderId: order.orderId,
    money: '10',
  });
  expect(notify1.text).toBe('success');
  const detail = (await (
    await client(`/v1/payments/orders/${order.orderId}`, { token })
  ).json()) as { status: number; creditAmount: string };
  expect(detail.status).toBe(2); // 已入账
  const afterTopup = new Decimal(await walletBalance(client, token));
  expect(afterTopup.minus(input.afterRedeem).toString()).toBe('10');

  await assertEpayReplayAndTamper(client, harness, {
    token,
    orderId: order.orderId,
    afterTopup,
  });
  return { afterTopup };
}

/** epay 回调幂等与防篡改：重复回调不重复入账；金额篡改验签失败不入账 */
async function assertEpayReplayAndTamper(
  client: Api,
  harness: E2eHarness,
  input: { token: string; orderId: string; afterTopup: Decimal },
): Promise<void> {
  // 重复回调幂等（status=2 → 直接 success，不重复入账）
  const notify2 = await sendEpayNotify(client, {
    epay: harness.epay,
    orderId: input.orderId,
    money: '10',
  });
  expect(notify2.text).toBe('success');
  expect(new Decimal(await walletBalance(client, input.token)).toString()).toBe(
    input.afterTopup.toString(),
  );

  // 金额篡改：验签基于原参数——money 改动后签名不匹配 → fail，不入账
  const tampered = await sendEpayNotify(client, {
    epay: harness.epay,
    orderId: input.orderId,
    money: '999',
  });
  expect(tampered.text).toBe('fail');
  expect(new Decimal(await walletBalance(client, input.token)).toString()).toBe(
    input.afterTopup.toString(),
  );
}

/** ── 订阅购买（余额扣款，幂等重放）与我的订阅视图 ── */
async function subscriptionFlow(
  client: Api,
  input: { token: string; planId: number; runTag: string; afterTopup: Decimal },
): Promise<void> {
  const { token } = input;
  const purchase = await client('/v1/subscriptions', {
    method: 'POST',
    headers: { 'idempotency-key': `e2e-buy-${input.runTag}` },
    token,
    body: JSON.stringify({ planId: input.planId }),
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
  const replayBuy = await client('/v1/subscriptions', {
    method: 'POST',
    headers: { 'idempotency-key': `e2e-buy-${input.runTag}` },
    token,
    body: JSON.stringify({ planId: input.planId }),
  });
  expect(((await replayBuy.json()) as { replayed: boolean }).replayed).toBe(true);

  const afterBuy = new Decimal(await walletBalance(client, token));
  expect(afterBuy.plus('1').toString()).toBe(input.afterTopup.toString());

  const subs = (await (await client('/v1/subscriptions', { token })).json()) as {
    rows: Array<{ quotaAmount: string; remainingAmount: string; renewPrice: string }>;
  };
  // 存储层 numeric 全精度串（v1 同形）——按 Decimal 归一后比较
  expect(new Decimal(subs.rows[0]?.quotaAmount ?? 'x').toString()).toBe('10');
  expect(new Decimal(subs.rows[0]?.remainingAmount ?? 'x').toString()).toBe('10');
  expect(new Decimal(subs.rows[0]?.renewPrice ?? 'x').toString()).toBe('1');
}

/** ── 钱包对账：流水含 gift?/redeem/topup/subscription 四域腿 + 余额分文不差 ── */
async function walletReconciliation(
  client: Api,
  input: { token: string; afterGift: Decimal },
): Promise<void> {
  const { token } = input;
  const statement = (await (await client('/v1/wallet/statement?limit=50', { token })).json()) as {
    rows: Array<{ refType: string }>;
  };
  const refTypes = new Set(statement.rows.map((r) => r.refType));
  expect(refTypes.has('redeem')).toBe(true);
  expect(refTypes.has('topup')).toBe(true);
  expect(refTypes.has('subscription')).toBe(true);
  expect(new Decimal(await walletBalance(client, token)).toString()).toBe(
    input.afterGift.plus('5').plus('10').minus('1').toString(),
  );
}

/** ── 会话安全：登出吊销 → 两级登录 → 改密全网下线 → 复登 ── */
async function sessionSecurity(
  client: Api,
  harness: E2eHarness,
  input: { token: string; email: string; password: string },
): Promise<void> {
  const { token } = input;
  expect(await (await client('/v1/auth/logout', { method: 'POST', token })).json()).toEqual({
    ok: true,
  });
  expect((await client('/v1/me', { token })).status).toBe(401);

  const wrong = await client('/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: input.email, password: 'wrong-password-1' }),
  });
  expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe(
    'identity.invalid_credentials',
  );

  // 两级登录（原密码）→ 新会话 token
  const challengeId = await startLoginChallenge(client, input.email, input.password);
  const sessionToken = await verifyLoginChallenge(client, {
    harness,
    loginEmail: input.email,
    challengeId,
  });

  // 改密全网下线：旧会话 401、改密响应的新 token 200
  const changed = (await (
    await client('/v1/auth/password', {
      method: 'POST',
      token: sessionToken,
      body: JSON.stringify({ oldPassword: input.password, newPassword: 'journey-password-456' }),
    })
  ).json()) as { token: string };
  expect((await client('/v1/me', { token: sessionToken })).status).toBe(401);
  expect((await client('/v1/me', { token: changed.token })).status).toBe(200);

  // 复登（新密码）
  const reloginChallengeId = await startLoginChallenge(client, input.email, 'journey-password-456');
  const reVerify = await client('/v1/auth/login/verify', {
    method: 'POST',
    body: JSON.stringify({
      challengeId: reloginChallengeId,
      code: harness.mailer.lastCodeOf(input.email),
    }),
  });
  expect(reVerify.status).toBe(200);
}

/** 两级登录第一步：邮箱+密码 → 挑战单（kind=code_required）→ 返回 challengeId */
async function startLoginChallenge(
  client: Api,
  loginEmail: string,
  loginPassword: string,
): Promise<string> {
  const login = (await (
    await client('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: loginEmail, password: loginPassword }),
    })
  ).json()) as { kind: string; challengeId: string };
  expect(login.kind).toBe('code_required');
  return login.challengeId;
}

/** 两级登录第二步：挑战单 + 邮箱验证码 → 会话 token */
async function verifyLoginChallenge(
  client: Api,
  ctx: { harness: E2eHarness; loginEmail: string; challengeId: string },
): Promise<string> {
  const { token } = (await (
    await client('/v1/auth/login/verify', {
      method: 'POST',
      body: JSON.stringify({
        challengeId: ctx.challengeId,
        code: ctx.harness.mailer.lastCodeOf(ctx.loginEmail),
      }),
    })
  ).json()) as { token: string };
  return token;
}

context('用户旅程（老仓 e2e-user-journey 全链核销）', () => {
  it('注册 → 生命周期 → 资金面（兑换/充值/订阅/对账）→ 会话安全', async () => {
    const account = await registerTwoStep(api, h, { email, password });
    ({ userId } = account);
    const { token } = account;
    await profileAndKeyLifecycle(api, account);
    const { afterGift, afterRedeem } = await redeemFlow(api, token, { redeemCode });
    const { afterTopup } = await epayTopupFlow(api, h, { token, afterRedeem });
    await subscriptionFlow(api, { token, planId, runTag, afterTopup });
    await walletReconciliation(api, { token, afterGift });
    await sessionSecurity(api, h, { token, email, password });
  }, 180_000);
});
