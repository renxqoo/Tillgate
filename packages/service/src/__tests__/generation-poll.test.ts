/**
 * 生成任务轮询集成测试（真实 PG + stub 任务端口）：任务生命周期的资金下半生——
 * 超时扫描释放 / running 续租 / succeeded 收据结算（经 settlement 实扣验证）/
 * failed 释放 / music 代执行。幂等：CAS 0 行命中（他副本已终态化）不发信号。
 * 数据纪律：v2g 前缀；清理顺序 = 任务 → 明细 → usage → 账单 → 渠道 → 映射 → provider → key → user。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@ai-gateway/db';
import { apiKeys, channels, modelChannels, modelMappings, providers, users } from '@ai-gateway/db';
import type { Db, Repositories } from '@ai-gateway/repository';
import { createRepositories } from '@ai-gateway/repository';
import { systemContext, type RunContext } from '../context.js';
import { createBillingDomain } from '../billing/index.js';
import { createSettlementDomain } from '../settlement/index.js';
import { createGenerationPollUseCase } from '../generation/poll.js';
import type { GenerationTaskPort, TaskQueryResult } from '../generation/port.js';
import { createWallet } from '../wallet/wallet.js';
import { Decimal, type BillingQuote, type UsageReceipt } from '@ai-gateway/domain';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const tag = () => `v2g-${randomUUID().slice(0, 8)}`;
const repos: Repositories = createRepositories();
const billing = createBillingDomain({ db, currency: 'CNY' });
const settlement = createSettlementDomain({
  db, currency: 'CNY', policy: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 200 },
});
const wallet = createWallet({
  db, currency: 'CNY',
  guards: { refTypes: ['billing', 'topup'], currencies: ['CNY'], internalAccounts: ['platform_revenue', 'outside'] },
});
const pollCtx = (): RunContext => systemContext(randomUUID());

/** 任务族报价：second 单价 0.5 × duration 6 秒（单位轴承载全部金额） */
const quote = (): BillingQuote => ({
  maxOutputTokens: 0,
  candidates: [{
    mappingId: 0, externalModel: 'vid', realModel: 'vid-real',
    inputPrice: '0', outputPrice: '0', cacheInputPrice: '0', unitPrice: '0.5',
    coefficient: '1', inputTokenUpperBound: 0, pricingUnit: 'second', unitUpperBound: 6,
    billingPolicyFingerprint: null,
  }],
});

function receiptTemplate(userId: number, requestId: string): UsageReceipt {
  return {
    requestId, userId, apiKeyId: null, appId: null, credentialType: 'key',
    externalModel: 'vid', realModel: 'vid-real', channelId: 1, channelKey: 'ch',
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, estimated: false, units: 6 },
    inputPrice: '0', outputPrice: '0', cacheInputPrice: '0', unitPrice: '0.5', coefficient: '1',
    durationMs: 0, stream: false, streamAborted: false,
    mappingId: 0, billingPolicyFingerprint: null,
  };
}

/** 落一套真实外键行（user/key/mapping/provider/channel）+ 账单授权 + 任务行 */
async function seedTask(input: { kind: 'video' | 'music'; expiresAt?: Date; upstreamTaskId?: string | null; amount?: string }): Promise<{
  requestId: string; userId: number; taskId: string; upstreamTaskId: string;
}> {
  const [user] = await db.insert(users).values({ issuer: 'v2g', subject: tag(), identityProvider: 'local' }).returning({ id: users.id });
  createdUsers.push(user!.id);
  const [key] = await db.insert(apiKeys).values({ keyHash: tag(), keyPreview: 'ag_****', userId: user!.id, name: 'v2g' }).returning({ id: apiKeys.id });
  createdKeys.push(key!.id);
  const [provider] = await db.insert(providers).values({ name: tag(), baseUrl: 'https://v2g.test', protocol: 'openai-compatible', status: 0 }).returning({ id: providers.id });
  createdProviders.push(provider!.id);
  const [mapping] = await db.insert(modelMappings).values({ externalName: tag(), realModel: `real-${tag()}`, status: 0, inputPrice: '0', outputPrice: '0', cacheInputPrice: '0' }).returning({ id: modelMappings.id });
  createdMappings.push(mapping!.id);
  const [channel] = await db.insert(channels).values({ providerId: provider!.id, name: tag(), apiKeyEnc: 'enc', status: 0, upstreamBudget: '1000' }).returning({ id: channels.id });
  createdChannels.push(channel!.id);
  await db.insert(modelChannels).values({ mappingId: mapping!.id, channelId: channel!.id, priority: 1, weight: 1 });

  await wallet.credit(pollCtx(), { userId: user!.id, amount: input.amount ?? '100', refType: 'topup', refId: tag() });
  const requestId = randomUUID();
  const upstreamTaskId = input.upstreamTaskId ?? `up-${tag()}`;
  const q = quote();
  q.candidates[0]!.mappingId = mapping!.id;
  await billing.authorize(pollCtx(), {
    requestId, userId: user!.id, apiKeyId: key!.id, appId: null, stream: false,
    quote: q, reservationLimit: '1000', authorizationTtlMs: 300_000,
  });
  const template = receiptTemplate(user!.id, requestId);
  template.mappingId = mapping!.id;
  template.channelId = channel!.id;
  await repos.generationTask.insert({ ...pollCtx(), db }, {
    id: requestId, requestId, userId: user!.id, apiKeyId: key!.id,
    mappingId: mapping!.id, channelId: channel!.id,
    upstreamTaskId, kind: input.kind,
    params: { model: 'vid', prompt: 'p' },
    receiptTemplate: template as unknown as Record<string, unknown>,
    unitsSnapshot: '6',
    expiresAt: input.expiresAt ?? new Date(Date.now() + 3_600_000),
    now: new Date(),
  });
  createdRequests.push(requestId);
  return { requestId, userId: user!.id, taskId: requestId, upstreamTaskId: upstreamTaskId ?? '' };
}

/** stub 任务端口：查询剧本按上游任务号键控 */
function stubPort(plan: Record<string, (() => TaskQueryResult) | { artifact?: Record<string, unknown> }>): GenerationTaskPort {
  return {
    async submitTask() { return { ok: true, upstreamTaskId: 'up-new' }; },
    async executeTask(_channel, request) {
      const spec = plan[request.taskId];
      if (spec && 'artifact' in spec) return { ok: true, artifact: spec.artifact ?? { url: 'https://cdn/audio.mp3' } };
      return { ok: false, error: { code: 'upstream_error', message: 'execute failed' } };
    },
    async queryTask(_channel, upstreamTaskId) {
      const spec = plan[upstreamTaskId];
      if (spec === undefined) return { ok: true, status: 'running' };
      if (typeof spec === 'function') return (spec as () => TaskQueryResult)();
      return { ok: true, status: 'succeeded', artifact: spec.artifact ?? {} };
    },
  };
}

const poller = (port: GenerationTaskPort) => createGenerationPollUseCase({
  db, repos, taskPort: port,
  signal: (c, event) => billing.signal(c, event),
  config: { batch: 50, leaseMs: 30_000, expireReason: '任务超时（TTL 到期）' },
});

async function billingStatus(requestId: string): Promise<string | null> {
  const row = await db.$client.query<{ status: string }>('select status from billing_requests where request_id = $1', [requestId]);
  return row.rows[0]?.status ?? null;
}

async function walletOf(userId: number): Promise<{ balance: string; inFlight: string }> {
  const rows = await wallet.accounts(pollCtx(), userId);
  return { balance: rows[0]!.balance, inFlight: rows[0]!.inFlight };
}

const createdUsers: number[] = [];
const createdKeys: number[] = [];
const createdChannels: number[] = [];
const createdMappings: number[] = [];
const createdProviders: number[] = [];
const createdRequests: string[] = [];

afterAll(async () => {
  const ids = createdRequests;
  if (ids.length) await db.$client.query('delete from generation_tasks where request_id = any($1::uuid[])', [ids]);
  if (ids.length) await db.$client.query('delete from billing_reservations where billing_request_id = any($1::uuid[])', [ids]);
  if (ids.length) await db.$client.query('delete from usage_logs where request_id = any($1::uuid[])', [ids]);
  if (ids.length) await db.$client.query('delete from billing_requests where request_id = any($1::uuid[])', [ids]);
  if (createdChannels.length) {
    await db.$client.query('delete from model_channels where channel_id = any($1)', [createdChannels]);
    await db.$client.query('delete from channels where id = any($1)', [createdChannels]);
  }
  if (createdMappings.length) await db.$client.query('delete from model_mappings where id = any($1)', [createdMappings]);
  if (createdProviders.length) await db.$client.query('delete from providers where id = any($1)', [createdProviders]);
  if (createdKeys.length) await db.$client.query('delete from api_keys where id = any($1)', [createdKeys]);
  if (createdUsers.length) await db.$client.query('delete from users where id = any($1)', [createdUsers]);
  await db.$client.query('delete from generation_tasks where id like $1', ['v2g-%']).catch(() => {});
  await db.$client.end().catch(() => {});
});

describe('生成任务轮询 · 先信号后终态（收费不被吞）', () => {
  it('succeeded 信号瞬时失败 → 任务不终态化（下轮重试）；信号恢复 → 终态 + 实扣', async () => {
    const seeded = await seedTask({ kind: 'video' });
    // 第一次 poll：request.succeeded 信号抛错（模拟结算入口瞬时 DB 抖动）
    let failSignal = true;
    const failingPoller = createGenerationPollUseCase({
      db, repos, taskPort: stubPort({ [seeded.upstreamTaskId]: { artifact: { video_url: 'https://cdn/v.mp4' } } }),
      signal: async (c, event) => {
        if (event.type === 'request.succeeded' && failSignal) {
          throw new Error('signal transient failure');
        }
        return billing.signal(c, event);
      },
      config: { batch: 50, leaseMs: 30_000, expireReason: '任务超时（TTL 到期）' },
      onError: () => undefined, // 静音注入错误（断言走状态而非日志）
    });
    const first = await failingPoller(pollCtx());
    expect(first.succeeded).toBe(0); // 未终态化——旧序（先终态后信号）在这里就永久免费交付了

    const stillActive = await db.$client.query<{ status: string }>(
      'select status from generation_tasks where id = $1', [seeded.taskId],
    );
    expect(stillActive.rows[0]!.status).not.toBe('succeeded');

    // 第二次 poll：信号恢复 → 终态 + settlement_pending（收费落定）
    failSignal = false;
    const second = await failingPoller(pollCtx());
    expect(second.succeeded).toBe(1);
    expect(await billingStatus(seeded.requestId)).toBe('settlement_pending');

    const terminal = await db.$client.query<{ status: string }>(
      'select status from generation_tasks where id = $1', [seeded.taskId],
    );
    expect(terminal.rows[0]!.status).toBe('succeeded');

    // 结算收尾：6 秒 × 0.5 = 3 元实扣
    for (let i = 0; i < 10; i++) {
      if (await billingStatus(seeded.requestId) === 'settled') break;
      const claims = await settlement.claim(pollCtx(), {
        ownerId: `v2g-${randomUUID().slice(0, 6)}`, batchSize: 10, claimLeaseMs: 60_000,
        requestIds: [seeded.requestId],
      });
      for (const claim of claims) await settlement.processClaim(pollCtx(), claim);
    }
    expect(await billingStatus(seeded.requestId)).toBe('settled');
    const w = await walletOf(seeded.userId);
    expect(w.balance).toBe('97');
    expect(w.inFlight).toBe('0');
  });

  it('信号已落地但终态 CAS 输给崩溃窗口 → 重轮询自愈（跳过信号直接终态化）', async () => {
    const seeded = await seedTask({ kind: 'video' });
    // 第一次 poll 正常完成信号，但模拟 casTerminal 前崩溃：手工只置 billing 不终态化
    const taskRow = await db.$client.query<{ receipt_template: Record<string, unknown> }>(
      'select receipt_template from generation_tasks where id = $1', [seeded.taskId],
    );
    await billing.signal(pollCtx(), {
      type: 'request.succeeded',
      requestId: seeded.requestId,
      receipt: { ...taskRow.rows[0]!.receipt_template, requestId: seeded.requestId } as never,
    });
    // 直接用真 poller 驱动（信号已 settlement_pending → 跳过信号直接终态）
    const result = await poller(stubPort({ [seeded.upstreamTaskId]: { artifact: { video_url: 'https://cdn/v2.mp4' } } }))(pollCtx());
    expect(result.succeeded).toBe(1);
    const terminal = await db.$client.query<{ status: string }>(
      'select status from generation_tasks where id = $1', [seeded.taskId],
    );
    expect(terminal.rows[0]!.status).toBe('succeeded');
  });
});

describe('生成任务轮询（资金下半生）', () => {
  it('video succeeded：CAS 终态 → settlement_pending → settlement 实扣 6s×0.5=3 元', async () => {
    const { requestId, userId, upstreamTaskId } = await seedTask({ kind: 'video' });

    const result = await poller(stubPort({ [upstreamTaskId]: { artifact: { url: 'https://cdn/v.mp4', width: 1280, height: 720 } } }))(pollCtx());
    expect(result.succeeded).toBe(1);

    expect(await billingStatus(requestId)).toBe('settlement_pending');
    const task = await db.$client.query<{ status: string; result: Record<string, unknown> }>('select status, result from generation_tasks where id = $1', [requestId]);
    expect(task.rows[0]!.status).toBe('succeeded');
    expect(task.rows[0]!.result).toMatchObject({ url: 'https://cdn/v.mp4' });

    // 结算消费（worker 下半场）：定向认领 → 实扣 3 元、在途清零
    const claims = await settlement.claim(pollCtx(), { ownerId: tag(), batchSize: 5, claimLeaseMs: 60_000, requestIds: [requestId] });
    expect(claims).toHaveLength(1);
    expect(await settlement.processClaim(pollCtx(), claims[0]!)).toBe('settled');
    const walletState = await walletOf(userId);
    expect(new Decimal(walletState.balance).eq('97')).toBe(true);
    expect(new Decimal(walletState.inFlight).eq('0')).toBe(true);
  });

  it('双副本并发轮询同一任务：CAS 单赢家，只结算一次（防双扣）', async () => {
    const { requestId, userId, upstreamTaskId } = await seedTask({ kind: 'video' });

    // 两把 poller 同剧本（都看到 succeeded）并发 poll——casTerminal 单条 UPDATE
    // 只有一个副本命中 RETURNING，另一个 0 行跳过 → signal 只发一次
    const [a, b] = await Promise.all([
      poller(stubPort({ [upstreamTaskId]: { artifact: { url: 'https://cdn/v.mp4' } } }))(pollCtx()),
      poller(stubPort({ [upstreamTaskId]: { artifact: { url: 'https://cdn/v.mp4' } } }))(pollCtx()),
    ]);
    expect(a.succeeded + b.succeeded).toBe(1); // 恰一赢家

    expect(await billingStatus(requestId)).toBe('settlement_pending');
    // 结算消费一次后，第二个 settlement claim 不会再认领到该请求（已 settled）
    const claims = await settlement.claim(pollCtx(), { ownerId: tag(), batchSize: 5, claimLeaseMs: 60_000, requestIds: [requestId] });
    if (claims.length > 0) {
      expect(await settlement.processClaim(pollCtx(), claims[0]!)).toBe('settled');
    }
    const walletState = await walletOf(userId);
    expect(new Decimal(walletState.balance).eq('97')).toBe(true); // 6s×0.5 只扣一次
  });

  it('video running：markRunning + 续租（账单保持 in_flight，不结算）', async () => {
    const { requestId, upstreamTaskId } = await seedTask({ kind: 'video' });

    const result = await poller(stubPort({ [upstreamTaskId]: () => ({ ok: true, status: 'running' }) }))(pollCtx());
    expect(result.succeeded).toBe(0);
    const task = await db.$client.query<{ status: string }>('select status from generation_tasks where id = $1', [requestId]);
    expect(task.rows[0]!.status).toBe('running');
  });

  it('video failed：CAS 终态 + request.failed 三路归还（在途归零、余额不动）', async () => {
    const { requestId, userId, upstreamTaskId } = await seedTask({ kind: 'video' });

    const result = await poller(stubPort({ [upstreamTaskId]: () => ({ ok: true, status: 'failed', reason: 'content policy' }) }))(pollCtx());
    expect(result.failed).toBe(1);
    expect(await billingStatus(requestId)).toBe('released');
    const walletState = await walletOf(userId);
    expect(walletState.balance).toBe('100');
    expect(new Decimal(walletState.inFlight).eq('0')).toBe(true);
  });

  it('music 代执行：worker 执行上游 → 成功结算（任务族同步阻塞形态）', async () => {
    const { requestId, userId } = await seedTask({ kind: 'music', upstreamTaskId: null });

    const result = await poller(stubPort({ [requestId]: { artifact: { url: 'https://cdn/a.mp3' } } }))(pollCtx());
    expect(result.executed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(await billingStatus(requestId)).toBe('settlement_pending');

    const claims = await settlement.claim(pollCtx(), { ownerId: tag(), batchSize: 5, claimLeaseMs: 60_000, requestIds: [requestId] });
    expect(await settlement.processClaim(pollCtx(), claims[0]!)).toBe('settled');
    const walletState = await walletOf(userId);
    expect(new Decimal(walletState.balance).eq('97')).toBe(true);
  });

  it('超时扫描：TTL 到期 → expired + 释放（不扣）', async () => {
    const { requestId, userId } = await seedTask({ kind: 'video', expiresAt: new Date(Date.now() - 1_000) });

    const result = await poller(stubPort({}))(pollCtx());
    expect(result.expired).toBe(1);
    expect(await billingStatus(requestId)).toBe('released');
    const walletState = await walletOf(userId);
    expect(new Decimal(walletState.inFlight).eq('0')).toBe(true);
    expect(walletState.balance).toBe('100');
  });

  it('查询瞬时错误：只续租不终态化（下轮再查）', async () => {
    const { requestId, upstreamTaskId } = await seedTask({ kind: 'video' });

    const result = await poller(stubPort({ [upstreamTaskId]: () => ({ ok: false, error: { code: 'timeout' } }) }))(pollCtx());
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
    const task = await db.$client.query<{ status: string }>('select status from generation_tasks where id = $1', [requestId]);
    expect(['queued', 'running']).toContain(task.rows[0]!.status);
    expect(await billingStatus(requestId)).toBe('authorized');
  });
});

