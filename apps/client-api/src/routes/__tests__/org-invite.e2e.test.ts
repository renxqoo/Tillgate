import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import {
  apiKeys,
  organizations,
  orgMembers,
  plans as plansTable,
  userSubscriptions,
  usageLogs,
  users,
} from '@ai-gateway/db/schema';
import { createSettlementProcessor } from '@ai-gateway/ledger/settlement';
import { createWallet } from '@ai-gateway/wallet';
import { createSubscriptionDomain } from '@ai-gateway/ledger/subscription';
import { createPromotions } from '../../services/promotions.js';
import { errorHandler, type Redis } from '@ai-gateway/http';
import type { ClientEnv } from '@ai-gateway/identity';
import type { ClientServices } from '../../services/index.js';
import { subscriptionRoutes } from '../subscriptions.js';
import { keyRoutes } from '../keys.js';
import { orgRoutes } from '../orgs.js';
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
 * 组织/成员端到端（HTTP 级，真实 DB/Redis，mock 上游）：
 *   企业购买团队套餐 → 建组织 + owner 占 1 席 → 邀请成员（email）
 *   → 成员登录接受 → 成员建 Key 绑定组织订阅 → 网关调用扣组织额度、用量归成员。
 *
 * 数据以 `e2e_org_` 前缀落库并【保留留档】不清理（与 subscription-flow 同纪律），可在 DB 复查。
 */

loadEnvFileIntoProcess();
ensureTestSecrets();

const db = createTestDb();
const redis = createTestRedis();

let connected = false;
let model: TestModelIds;
const runTag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`;

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

function noopLogger() {
  return { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
}

const testWallet = createWallet(db, { accounts: [], refTypes: ['topup', 'subscription', 'pack', 'payment', 'promo'], currencies: ['CNY'] });
const services: ClientServices = {
  db,
  redis: redis as unknown as Redis,
  wallet: testWallet,
  subscription: createSubscriptionDomain({ db, wallet: testWallet }),
  promotions: createPromotions(db, testWallet),
  logger: noopLogger() as unknown as ClientServices['logger'],
  mailer: null,
  captcha: null,
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
  api.route('/orgs', orgRoutes(services));
  app.route('/api', api);
  return app;
}

async function clientJson(
  app: Hono,
  path: string,
  init: { method: string; body?: unknown },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(path, {
    method: init.method,
    headers: { 'content-type': 'application/json' },
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

async function createUser(email: string, enterprise: boolean): Promise<{ id: number; email: string }> {
  const [u] = await db
    .insert(users)
    .values({
      issuer: 'local',
      subject: `e2e_org_${runTag}_${randomUUID().slice(0, 8)}`,
      identityProvider: 'local',
      email,
      displayName: email,
      isEnterprise: enterprise,
    })
    .returning({ id: users.id, email: users.email });
  return { id: u!.id, email: u!.email ?? email };
}

async function topUp(userId: number, amount: string) {
  return testWallet.credit({
    userId,
    amount,
    refType: 'topup',
    refId: `e2e-org-gift-${runTag}-${userId}-${amount}`,
  });
}

async function createTeamPlan() {
  const [p] = await db
    .insert(plansTable)
    .values({
      name: `e2e_org_team_${runTag}`.slice(0, 32),
      kind: 'subscription',
      sortOrder: 2,
      price: '30',
      periodDays: 30,
      quotaAmount: '10',
      allowSeats: true,
      status: 0,
    })
    .returning({ id: plansTable.id });
  return p!;
}

describe('组织/成员端到端（企业套餐 → 邀请 → 成员 Key 扣组织额度）', () => {
  it('企业购买团队套餐建组织，邀请成员，成员用组织 Key 调用扣组织额度', async () => {
    if (!connected) return it.skip('no DB');

    const owner = await createUser(`owner-${runTag}@e2e.local`, true);
    const member = await createUser(`member-${runTag}@e2e.local`, false);
    await topUp(owner.id, '200');
    const plan = await createTeamPlan();
    const ownerApp = makeClientApp(owner.id);

    // 1. 企业购买团队套餐（quantity=3）→ 建组织 + org 订阅 + owner 占 1 席
    const purchase = await clientJson(ownerApp, '/api/subscriptions', {
      method: 'POST',
      body: { planId: plan.id, quantity: 3 },
    });
    expect(purchase.status).toBe(201);
    const subscriptionId = Number(purchase.body.subscriptionId);

    const org = await db.query.organizations.findFirst({
      where: eq(organizations.ownerUserId, owner.id),
    });
    expect(org).toBeTruthy();
    const sub = await db.query.userSubscriptions.findFirst({
      where: eq(userSubscriptions.id, subscriptionId),
    });
    expect(sub!.orgId).toBe(org!.id);
    const ownerMember = await db.query.orgMembers.findFirst({
      where: eq(orgMembers.orgId, org!.id),
    });
    expect(ownerMember!.userId).toBe(owner.id);
    expect(ownerMember!.role).toBe('owner');

    // 2. owner 邀请成员
    const invite = await clientJson(ownerApp, `/api/orgs/${org!.id}/invitations`, {
      method: 'POST',
      body: { email: member.email },
    });
    expect(invite.status).toBe(201);
    const token = (invite.body.invitation as { token: string }).token;
    expect(token).toBeTruthy();

    // 3. 成员登录接受邀请
    const memberApp = makeClientApp(member.id);
    const accept = await clientJson(memberApp, '/api/orgs/invitations/accept', {
      method: 'POST',
      body: { token },
    });
    expect(accept.status).toBe(200);
    const memberRow = await db.query.orgMembers.findFirst({
      where: eq(orgMembers.userId, member.id),
    });
    expect(memberRow!.orgId).toBe(org!.id);
    expect(memberRow!.status).toBe(0);

    // 4. 成员建 Key 绑定组织订阅（切到企业套餐）
    const keyRes = await clientJson(memberApp, '/api/keys', {
      method: 'POST',
      body: { name: 'e2e-org-member-key', subscriptionId },
    });
    expect(keyRes.status).toBe(201);
    const apiKey = String(keyRes.body.key);
    const keyRow = await db.query.apiKeys.findFirst({
      where: eq(apiKeys.userId, member.id),
    });
    expect(keyRow!.subscriptionId).toBe(subscriptionId);

    // 5. 成员用组织 Key 调用 → 扣组织额度、用量归成员
    const ai = makeMockAi({
      chat: vi.fn(async () => ({
        status: 'success' as const,
        usage: {
          inputTokens: 50,
          cachedInputTokens: 0,
          outputTokens: 20,
          estimated: false,
          raw: { prompt_tokens: 50, completion_tokens: 20 },
        },
        body: { id: 'e2e-org-mock', object: 'chat.completion', choices: [] },
        durationMs: 5,
      })),
    });
    const gw = buildTestApp(db, redis, ai);
    const chat = await gw.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: model.externalModel,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
      }),
    });
    expect(chat.status).toBe(200);
    const requestId = chat.headers.get('x-request-id')!;
    await createSettlementProcessor({
      db,
      wallet: testWallet,
      options: {
        ownerId: `e2e-org-`,
        batchSize: 5,
        claimLeaseMs: 60_000,
        retryBaseMs: 10,
        retryMaxMs: 100,
        maxAttempts: 3,
      },
    }).runOnce([requestId]);

    // 结算竞态容忍：真实 worker 与本测试 processor 都可能 claim 本账单（共享 Redis 队列），
    // 谁先 claim 谁结算——轮询等待 usage 落库，而不是假设 runOnce 必然是结算方。
    let usage: typeof usageLogs.$inferSelect | undefined;
    for (let i = 0; i < 50 && !usage; i++) {
      usage = await db.query.usageLogs.findFirst({
        where: eq(usageLogs.requestId, requestId),
      });
      if (!usage) await new Promise((r) => setTimeout(r, 100));
    }
    expect(usage!.userId).toBe(member.id); // 用量归成员
    expect(usage!.subscriptionId).toBe(subscriptionId); // 扣组织订阅
    expect(usage!.billedBy).toBe('plan');
  });
});

describe('席位上限（成员数 ≤ quantity）', () => {
  it('席位满后 owner 邀请 → 409 SEATS_FULL；已有待接受邀请在席位满后接受 → 409 SEATS_FULL', async () => {
    if (!connected) return it.skip('no DB');

    const owner = await createUser(`seats-owner-${runTag}@e2e.local`, true);
    const m1 = await createUser(`seats-m1-${runTag}@e2e.local`, false);
    const m2 = await createUser(`seats-m2-${runTag}@e2e.local`, false);
    const m3 = await createUser(`seats-m3-${runTag}@e2e.local`, false);
    await topUp(owner.id, '200');
    const plan = await createTeamPlan();
    const ownerApp = makeClientApp(owner.id);

    // 买 3 席（owner 占 1 席 → 剩 2 席）
    const purchase = await clientJson(ownerApp, '/api/subscriptions', {
      method: 'POST',
      body: { planId: plan.id, quantity: 3 },
    });
    expect(purchase.status).toBe(201);
    const org = (await db.query.organizations.findFirst({
      where: eq(organizations.ownerUserId, owner.id),
    }))!;

    // m1 接受（2 席占）→ m2 接受（3 席满）
    const invite1 = await clientJson(ownerApp, `/api/orgs/${org.id}/invitations`, {
      method: 'POST',
      body: { email: m1.email },
    });
    const invite2 = await clientJson(ownerApp, `/api/orgs/${org.id}/invitations`, {
      method: 'POST',
      body: { email: m2.email },
    });
    expect(invite1.status).toBe(201);
    expect(invite2.status).toBe(201);
    await clientJson(makeClientApp(m1.id), '/api/orgs/invitations/accept', {
      method: 'POST',
      body: { token: (invite1.body.invitation as { token: string }).token },
    });
    await clientJson(makeClientApp(m2.id), '/api/orgs/invitations/accept', {
      method: 'POST',
      body: { token: (invite2.body.invitation as { token: string }).token },
    });

    // 席位已满（owner+m1+m2=3）：再邀请 → 409
    const inviteFull = await clientJson(ownerApp, `/api/orgs/${org.id}/invitations`, {
      method: 'POST',
      body: { email: m3.email },
    });
    expect(inviteFull.status).toBe(409);
    expect((inviteFull.body.error as { code: string }).code).toBe('SEATS_FULL');
  });
});

describe('接受时席位满（FOR UPDATE 串行化兜底）', () => {
  it('邀请发出后席位被占满，接受者再接受 → 409 SEATS_FULL', async () => {
    if (!connected) return it.skip('no DB');

    const owner = await createUser(`race-owner-${runTag}@e2e.local`, true);
    const a = await createUser(`race-a-${runTag}@e2e.local`, false);
    const b = await createUser(`race-b-${runTag}@e2e.local`, false);
    await topUp(owner.id, '200');
    const plan = await createTeamPlan();
    const ownerApp = makeClientApp(owner.id);

    // 买 2 席（owner 占 1 席 → 剩 1 席）
    const purchase = await clientJson(ownerApp, '/api/subscriptions', {
      method: 'POST',
      body: { planId: plan.id, quantity: 2 },
    });
    expect(purchase.status).toBe(201);
    const org = (await db.query.organizations.findFirst({
      where: eq(organizations.ownerUserId, owner.id),
    }))!;

    // 同时发出 a、b 两份邀请（此时还有 1 席空）
    const inviteA = await clientJson(ownerApp, `/api/orgs/${org.id}/invitations`, {
      method: 'POST',
      body: { email: a.email },
    });
    const inviteB = await clientJson(ownerApp, `/api/orgs/${org.id}/invitations`, {
      method: 'POST',
      body: { email: b.email },
    });
    expect(inviteA.status).toBe(201);
    expect(inviteB.status).toBe(201);

    // a 接受 → 占满 2 席
    const acceptA = await clientJson(makeClientApp(a.id), '/api/orgs/invitations/accept', {
      method: 'POST',
      body: { token: (inviteA.body.invitation as { token: string }).token },
    });
    expect(acceptA.status).toBe(200);

    // b 接受 → 席位已满 → 409（FOR UPDATE 串行化兜底）
    const acceptB = await clientJson(makeClientApp(b.id), '/api/orgs/invitations/accept', {
      method: 'POST',
      body: { token: (inviteB.body.invitation as { token: string }).token },
    });
    expect(acceptB.status).toBe(409);
    expect((acceptB.body.error as { code: string }).code).toBe('SEATS_FULL');
  });
});
