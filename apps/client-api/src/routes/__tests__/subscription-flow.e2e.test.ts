import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import {
  billingRequests,
  transactions,
  usageLogs,
  users,
  plans as plansTable,
  userSubscriptions,
} from '@ai-gateway/db/schema';
import { createBillingProcessor, createLedger } from '@ai-gateway/ledger';
import { errorHandler, type Redis } from '@ai-gateway/http';
import type { ClientEnv } from '@ai-gateway/identity';
import { subscriptionRoutes } from '../subscriptions.js';
import { keyRoutes } from '../keys.js';
import { meRoutes } from '../me.js';
import type { ClientServices } from '../../services/index.js';
import {
  loadEnvFileIntoProcess,
  ensureTestSecrets,
  createTestDb,
  createTestRedis,
  isBackendAvailable,
  setupTestModel,
  buildTestApp,
  makeMockAi,
  type TestModelIds,
} from '../../../../gateway/src/testing/helpers.js';

/**
 * 套餐完整流程端到端验证（HTTP 级，真实 DB/Redis，mock 上游 Ai）：
 *
 *   创建用户 → 充值 → 购买套餐（个人/企业）→ 建 Key → 网关调用按套餐额度扣费
 *   → 结算（worker 同款 processor）→ 到期/额度尽 402 → 续费恢复
 *
 * 本文件【不清理】任何测试数据（业务要求保留），所有数据以 `e2e_sub_` 前缀落库，
 * 可在 users / plans / user_subscriptions / api_keys / usage_logs / transactions 中复查。
 *
 * 链路组合了两个真实应用：
 *   - client-api（本包真实路由 + createLedger）：会话中间件换成 stub 注入 userId
 *     （与 src/test/helpers.ts 同构；会话鉴权由 identity 包测试覆盖）
 *   - gateway（buildTestApp：真实管线 + 真实 billing authorize/settle）
 */

loadEnvFileIntoProcess();
ensureTestSecrets();

const db = createTestDb();
const redis = createTestRedis();

let connected = false;
let model: TestModelIds;
// 短标签：plans.name 为 varchar(32)，前缀 + 名称 + 标签须留有余量
const runTag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`;

/** numeric(38,18) 字符串的数值比较（测试金额量级在 double 精度内） */
function numEq(a: string | null | undefined, b: string): boolean {
  return Number(a ?? 'NaN') === Number(b);
}

beforeAll(async () => {
  await redis.connect().catch(() => {});
  connected = await isBackendAvailable(db, redis);
  if (connected) {
    model = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
  }
});
afterAll(async () => {
  await redis.quit().catch(() => {});
  await db.$client.end().catch(() => {});
});

// ---------- client-api 测试组装（stub 会话 + 真实路由 + 真实 ledger） ----------

function noopLogger() {
  return { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
}

const services: ClientServices = {
  db,
  redis: redis as unknown as Redis,
  ledger: createLedger({ db }),
  logger: noopLogger() as unknown as ClientServices['logger'],
};

function makeClientApp(userId: number): Hono {
  const app = new Hono();
  app.onError(errorHandler(noopLogger() as never));
  const api = new Hono<ClientEnv>();
  api.use('*', async (c: Context<ClientEnv>, next: Next) => {
    c.set('session', { userId });
    await next();
  });
  api.route('/subscriptions', subscriptionRoutes(services));
  api.route('/keys', keyRoutes(services));
  api.route('/me', meRoutes(services));
  app.route('/api', api);
  return app;
}

async function clientJson(
  app: Hono,
  path: string,
  init: { method: string; body?: unknown; idempotencyKey?: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;
  const res = await app.request(path, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

// ---------- 数据工厂（全部保留，不清理） ----------

async function createE2eUser(opts: { enterprise?: boolean } = {}) {
  const subject = `e2e_sub_${opts.enterprise ? 'ent' : 'per'}_${runTag}_${randomUUID().slice(0, 8)}`;
  const [u] = await db
    .insert(users)
    .values({
      issuer: 'local',
      subject,
      identityProvider: 'local',
      displayName: subject,
      balance: '0',
      isEnterprise: opts.enterprise ?? false,
    })
    .returning({ id: users.id });
  return u!;
}

async function topUp(userId: number, amount: string) {
  return services.ledger.adminGift({
    operationId: `e2e-sub-gift-${runTag}-${userId}`,
    userId,
    amount,
    adminId: null,
    remark: 'e2e 套餐流程测试充值',
  });
}

async function createE2ePlan(opts: {
  name: string;
  price: string;
  quotaAmount: string;
  periodDays?: number;
  allowSeats?: boolean;
  sortOrder?: number | null;
}) {
    const [p] = await db
    .insert(plansTable)
    .values({
      name: `e2e_${opts.name}_${runTag}`,
      kind: 'subscription',
      sortOrder: opts.sortOrder ?? null,
      price: opts.price,
      periodDays: opts.periodDays ?? 30,
      quotaAmount: opts.quotaAmount,
      allowSeats: opts.allowSeats ?? false,
      status: 0,
    })
    .returning({ id: plansTable.id, name: plansTable.name });
  return p!;
}

type GatewayApp = ReturnType<typeof buildTestApp>;

async function gatewayChat(app: GatewayApp, token: string, maxTokens = 100) {
  return app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: model.externalModel,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: maxTokens,
    }),
  });
}

/** mock 上游：固定可信 usage（50 in / 20 out / 0 cached → 0.09 元，系数 1） */
function successAi() {
  return makeMockAi({
    chat: vi.fn(async () => ({
      status: 'success' as const,
      usage: {
        inputTokens: 50,
        cachedInputTokens: 0,
        outputTokens: 20,
        estimated: false,
        raw: { prompt_tokens: 50, completion_tokens: 20 },
      },
      body: { id: 'e2e-mock', object: 'chat.completion', choices: [] },
      durationMs: 5,
    })),
  });
}

/** 用 worker 同款 processor 结算指定请求并等待 settled */
async function settleAndWait(requestId: string) {
  await createBillingProcessor({
    db,
    options: {
      ownerId: `e2e-sub-${runTag}`,
      batchSize: 5,
      claimLeaseMs: 60_000,
      retryBaseMs: 10,
      retryMaxMs: 100,
      maxAttempts: 3,
    },
  }).runOnce([requestId]);
  await vi.waitFor(
    async () => {
      const row = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.requestId, requestId),
      });
      expect(row?.status).toBe('settled');
    },
    { timeout: 3_000, interval: 25 },
  );
}

async function getBalance(userId: number): Promise<string> {
  const u = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { balance: true },
  });
  return u!.balance;
}

// ---------- 用例 ----------

describe('套餐完整流程 E2E（个人）', () => {
  it('创建用户 → 充值 → 购买套餐 → 建 Key → 调用扣套餐额度 → 结算对账', async () => {
    if (!connected) return it.skip('no DB');

    // 1. 创建用户（余额 0）+ 管理员充值 100 元
    const user = await createE2eUser();
    await topUp(user.id, '100');
    expect(numEq(await getBalance(user.id), '100')).toBe(true);

    // 2. 个人套餐：20 元 / 30 天 / 额度 5 元 / 不支持席位
    const plan = await createE2ePlan({ name: 'lite', price: '20', quotaAmount: '5', sortOrder: 1 });
    const client = makeClientApp(user.id);

    // 3. 购买（幂等键）
    const idem = `e2e-purchase-${runTag}`;
    const purchase = await clientJson(client, '/api/subscriptions', {
      method: 'POST',
      body: { planId: plan.id },
      idempotencyKey: idem,
    });
    expect(purchase.status).toBe(201);
    expect(purchase.body.replayed).toBe(false);
    expect(numEq(String(purchase.body.price), '20')).toBe(true);
    expect(numEq(String(purchase.body.quotaAmount), '5')).toBe(true);
    expect(purchase.body.quantity).toBe(1);
    const subscriptionId = Number(purchase.body.subscriptionId);
    expect(subscriptionId).toBeGreaterThan(0);
    // 余额 100 - 20 = 80
    expect(numEq(await getBalance(user.id), '80')).toBe(true);
    // 流水：type=subscribe，金额 -20
    const tx = await db.query.transactions.findFirst({
      where: and(eq(transactions.userId, user.id), eq(transactions.type, 'subscribe')),
    });
    expect(numEq(tx!.amount, '-20')).toBe(true);

    // 3b. 同幂等键重放：不重复扣款
    const replay = await clientJson(client, '/api/subscriptions', {
      method: 'POST',
      body: { planId: plan.id },
      idempotencyKey: idem,
    });
    expect(replay.status).toBe(201);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.subscriptionId).toBe(subscriptionId);
    expect(numEq(await getBalance(user.id), '80')).toBe(true);

    // 3c. 已有有效订阅再购 → 409
    const again = await clientJson(client, '/api/subscriptions', {
      method: 'POST',
      body: { planId: plan.id },
      idempotencyKey: `e2e-again-${runTag}`,
    });
    expect(again.status).toBe(409);
    expect((again.body.error as { code: string }).code).toBe('ALREADY_SUBSCRIBED');

    // 4. 建 Key（个人 1 席）
    const keyRes = await clientJson(client, '/api/keys', {
      method: 'POST',
      body: { name: 'e2e-sub-key' },
    });
    expect(keyRes.status).toBe(201);
    const apiKey = String(keyRes.body.key);
    expect(apiKey.startsWith('ag_')).toBe(true);
    const keyId = Number(keyRes.body.id);

    // 5. 网关调用 → 预占套餐额度（在途）
    const ai = successAi();
    const gw = buildTestApp(db, redis, ai);
    const chat = await gatewayChat(gw, apiKey);
    expect(chat.status).toBe(200);
    const requestId = chat.headers.get('x-request-id')!;
    expect(requestId).toBeTruthy();
    // billing_requests 落库：预扣记在套餐上，等待结算
    // （本机若同时运行真实 worker，可能已抢先 claim/结算，故接受在途→已结算全程）
    const row = await db.query.billingRequests.findFirst({
      where: eq(billingRequests.requestId, requestId),
    });
    expect(['settlement_pending', 'processing', 'settled']).toContain(row?.status);
    expect(row?.subscriptionId).toBe(subscriptionId);
    expect(Number(row?.planReservedAmount ?? '0')).toBeGreaterThan(0);
    // 套餐在途敞口 = 预扣金额（结算前未释放）
    let subRow = await db.query.userSubscriptions.findFirst({
      where: eq(userSubscriptions.id, subscriptionId),
    });
    expect(Number(subRow!.reservedAmount)).toBeGreaterThan(0);

    // 6. 结算（worker 同款 processor）：扣套餐额度、不动余额
    await settleAndWait(requestId);
    subRow = await db.query.userSubscriptions.findFirst({
      where: eq(userSubscriptions.id, subscriptionId),
    });
    expect(numEq(subRow!.reservedAmount, '0')).toBe(true);
    // usage = (50×1000 + 20×2000)/1M = 0.09 元
    expect(numEq(subRow!.usedAmount, '0.09')).toBe(true);
    // 余额不动（纯额度模型）
    expect(numEq(await getBalance(user.id), '80')).toBe(true);
    const usage = await db.query.usageLogs.findFirst({
      where: eq(usageLogs.requestId, requestId),
    });
    expect(usage?.billedBy).toBe('plan');
    expect(numEq(usage!.planAmount, '0.09')).toBe(true);
    expect(numEq(usage!.paygAmount, '0')).toBe(true);

    // 7. me/subscription 展示剩余额度 = 5 - 0.09（与网关授权同口径：含在途）
    const meSub = await clientJson(client, '/api/me/subscription', { method: 'GET' });
    expect(meSub.status).toBe(200);
    expect(numEq(String(meSub.body.remainingAmount), '4.91')).toBe(true);

    // 8. 吊销 Key → 网关调用 401（鉴权缓存已清，立即生效）
    const revoke = await clientJson(client, `/api/keys/${keyId}`, { method: 'DELETE' });
    expect(revoke.status).toBe(200);
    const revokedChat = await gatewayChat(buildTestApp(db, redis, successAi()), apiKey);
    expect(revokedChat.status).toBe(401);
  });

  it('额度尽 → 402 subscription_quota_exhausted，不落授权、不调上游', async () => {
    if (!connected) return it.skip('no DB');

    const user = await createE2eUser();
    await topUp(user.id, '10');
    // 额度 0.001 元 < 单次预估（max_tokens=100 → ≥0.2 元）
    const plan = await createE2ePlan({ name: 'tiny', price: '1', quotaAmount: '0.001', sortOrder: 1 });
    const client = makeClientApp(user.id);
    const purchase = await clientJson(client, '/api/subscriptions', {
      method: 'POST',
      body: { planId: plan.id },
      idempotencyKey: `e2e-tiny-${runTag}`,
    });
    expect(purchase.status).toBe(201);

    const keyRes = await clientJson(client, '/api/keys', {
      method: 'POST',
      body: { name: 'e2e-tiny-key' },
    });
    expect(keyRes.status).toBe(201);

    const ai = successAi();
    const gw = buildTestApp(db, redis, ai);
    const chat = await gatewayChat(gw, String(keyRes.body.key));
    expect(chat.status).toBe(402);
    const body = (await chat.json()) as { error: { code: string } };
    expect(body.error.code).toBe('subscription_quota_exhausted');
    // 未调上游、未落 billing_requests、套餐未扣
    expect(ai.chat).not.toHaveBeenCalled();
    const reqs = await db.query.billingRequests.findMany({
      where: eq(billingRequests.userId, user.id),
    });
    expect(reqs).toHaveLength(0);
    const sub = await db.query.userSubscriptions.findFirst({
      where: eq(userSubscriptions.id, Number(purchase.body.subscriptionId)),
    });
    expect(numEq(sub!.usedAmount, '0')).toBe(true);
    expect(numEq(sub!.reservedAmount, '0')).toBe(true);
  });
});

describe('套餐到期与续费 E2E', () => {
  it('到期 → 402 subscription_required（调用与建 Key 双闸）→ 续费恢复', async () => {
    if (!connected) return it.skip('no DB');

    const user = await createE2eUser();
    await topUp(user.id, '50');
    const plan = await createE2ePlan({ name: 'expire', price: '5', quotaAmount: '5', sortOrder: 1 });
    const client = makeClientApp(user.id);
    const purchase = await clientJson(client, '/api/subscriptions', {
      method: 'POST',
      body: { planId: plan.id },
      idempotencyKey: `e2e-exp-${runTag}`,
    });
    expect(purchase.status).toBe(201);
    const subscriptionId = Number(purchase.body.subscriptionId);
    const keyRes = await clientJson(client, '/api/keys', {
      method: 'POST',
      body: { name: 'e2e-exp-key' },
    });
    expect(keyRes.status).toBe(201);
    const apiKey = String(keyRes.body.key);

    // 有效期内正常调用并结算
    const okChat = await gatewayChat(buildTestApp(db, redis, successAi()), apiKey);
    expect(okChat.status).toBe(200);
    await settleAndWait(okChat.headers.get('x-request-id')!);

    // 模拟时间流逝：endAt 置为过去（等价到期；生产为惰性判定 endAt <= now）
    await db
      .update(userSubscriptions)
      .set({ endAt: new Date(Date.now() - 60_000) })
      .where(eq(userSubscriptions.id, subscriptionId));

    // 到期后：调用 → 402 subscription_required
    const expChat = await gatewayChat(buildTestApp(db, redis, successAi()), apiKey);
    expect(expChat.status).toBe(402);
    const expBody = (await expChat.json()) as { error: { code: string } };
    expect(expBody.error.code).toBe('subscription_required');

    // 到期后：建 Key → 402 SUBSCRIPTION_REQUIRED（席位闸门）
    const key402 = await clientJson(client, '/api/keys', {
      method: 'POST',
      body: { name: 'e2e-exp-key-2' },
    });
    expect(key402.status).toBe(402);
    expect((key402.body.error as { code: string }).code).toBe('SUBSCRIPTION_REQUIRED');

    // me/subscription → null
    const meSub = await clientJson(client, '/api/me/subscription', { method: 'GET' });
    expect(meSub.status).toBe(200);
    expect(meSub.body).toBeNull();

    // 续费恢复：旧订阅转到期(status=1)，新订阅顺延，再扣 5 元
    const renew = await clientJson(client, `/api/subscriptions/${subscriptionId}/renew`, {
      method: 'POST',
      idempotencyKey: `e2e-renew-${runTag}`,
    });
    expect(renew.status).toBe(200);
    expect(Number(renew.body.subscriptionId)).not.toBe(subscriptionId);
    const oldSub = await db.query.userSubscriptions.findFirst({
      where: eq(userSubscriptions.id, subscriptionId),
    });
    expect(oldSub!.status).toBe(1);
    expect(numEq(await getBalance(user.id), '40')).toBe(true); // 50 - 5 - 5
    // 续费后可再调用
    const renewedChat = await gatewayChat(buildTestApp(db, redis, successAi()), apiKey);
    expect(renewedChat.status).toBe(200);
    await settleAndWait(renewedChat.headers.get('x-request-id')!);
  });
});

describe('企业 / 个人席位规则 E2E', () => {
  it('个人不能买团队套餐（403）；个人套餐加席（400）；余额不足（402）', async () => {
    if (!connected) return it.skip('no DB');

    const user = await createE2eUser();
    await topUp(user.id, '200');
    const teamPlan = await createE2ePlan({
      name: 'team',
      price: '30',
      quotaAmount: '10',
      allowSeats: true,
      sortOrder: 2,
    });
    const client = makeClientApp(user.id);

    // 个人买团队套餐（哪怕 1 席）→ 403 ENTERPRISE_REQUIRED
    const buy1 = await clientJson(client, '/api/subscriptions', {
      method: 'POST',
      body: { planId: teamPlan.id, quantity: 1 },
      idempotencyKey: `e2e-team-1-${runTag}`,
    });
    expect(buy1.status).toBe(403);
    expect((buy1.body.error as { code: string }).code).toBe('ENTERPRISE_REQUIRED');

    // 个人套餐 quantity=2 → 400 SEATS_NOT_ALLOWED
    const personalPlan = await createE2ePlan({
      name: 'lite2',
      price: '20',
      quotaAmount: '5',
      sortOrder: 1,
    });
    const buy2 = await clientJson(client, '/api/subscriptions', {
      method: 'POST',
      body: { planId: personalPlan.id, quantity: 2 },
      idempotencyKey: `e2e-seat-2-${runTag}`,
    });
    expect(buy2.status).toBe(400);
    expect((buy2.body.error as { code: string }).code).toBe('SEATS_NOT_ALLOWED');

    // 余额不足 → 402 INSUFFICIENT_BALANCE
    const poorUser = await createE2eUser();
    await topUp(poorUser.id, '1');
    const poorClient = makeClientApp(poorUser.id);
    const buy3 = await clientJson(poorClient, '/api/subscriptions', {
      method: 'POST',
      body: { planId: personalPlan.id },
      idempotencyKey: `e2e-poor-${runTag}`,
    });
    expect(buy3.status).toBe(402);
    expect((buy3.body.error as { code: string }).code).toBe('INSUFFICIENT_BALANCE');
  });

  it('企业 3 席团队套餐：额度×3，Key 席位=3，第 4 把 409，吊销释放席位', async () => {
    if (!connected) return it.skip('no DB');

    const user = await createE2eUser({ enterprise: true });
    await topUp(user.id, '200');
    const teamPlan = await createE2ePlan({
      name: 'team3',
      price: '30',
      quotaAmount: '10',
      allowSeats: true,
      sortOrder: 2,
    });
    const client = makeClientApp(user.id);

    const purchase = await clientJson(client, '/api/subscriptions', {
      method: 'POST',
      body: { planId: teamPlan.id, quantity: 3 },
      idempotencyKey: `e2e-team3-${runTag}`,
    });
    expect(purchase.status).toBe(201);
    expect(numEq(String(purchase.body.quotaAmount), '30')).toBe(true); // 10×3
    expect(numEq(String(purchase.body.price), '90')).toBe(true); // 30×3
    expect(numEq(await getBalance(user.id), '110')).toBe(true); // 200-90

    // 3 把 Key 都能建（席位=数量）
    const keyIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await clientJson(client, '/api/keys', {
        method: 'POST',
        body: { name: `e2e-team3-key-${i}` },
      });
      expect(res.status).toBe(201);
      keyIds.push(Number(res.body.id));
    }
    // 第 4 把 → 409 SEATS_FULL
    const full = await clientJson(client, '/api/keys', {
      method: 'POST',
      body: { name: 'e2e-team3-key-4' },
    });
    expect(full.status).toBe(409);
    expect((full.body.error as { code: string }).code).toBe('SEATS_FULL');

    // 共享额度池：席位已满时先 409，吊销一把释放席位后建调用 Key → 正常扣费
    const chatKeyBlocked = await clientJson(client, '/api/keys', {
      method: 'POST',
      body: { name: 'e2e-team3-key-chat' },
    });
    expect(chatKeyBlocked.status).toBe(409);
    const del = await clientJson(client, `/api/keys/${keyIds[2]}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const chatKey = await clientJson(client, '/api/keys', {
      method: 'POST',
      body: { name: 'e2e-team3-key-chat' },
    });
    expect(chatKey.status).toBe(201);
    const chat = await gatewayChat(buildTestApp(db, redis, successAi()), String(chatKey.body.key));
    expect(chat.status).toBe(200);
    await settleAndWait(chat.headers.get('x-request-id')!);
    const sub = await db.query.userSubscriptions.findFirst({
      where: eq(userSubscriptions.id, Number(purchase.body.subscriptionId)),
    });
    expect(numEq(sub!.usedAmount, '0.09')).toBe(true);

    // 吊销后席位释放，可再建（当前活跃 = keyIds[0..1] + chatKey，共 3 席满）
    const del2 = await clientJson(client, `/api/keys/${keyIds[1]}`, { method: 'DELETE' });
    expect(del2.status).toBe(200);
    const recreate = await clientJson(client, '/api/keys', {
      method: 'POST',
      body: { name: 'e2e-team3-key-5' },
    });
    expect(recreate.status).toBe(201);
  });
});
