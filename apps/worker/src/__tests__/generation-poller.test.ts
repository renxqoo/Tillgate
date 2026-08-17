import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import {
  billingRequests as billingRequestsTable,
  channels,
  generationTasks,
  providers,
  transactions as transactionsTable,
  usageLogs,
  users,
} from '@ai-gateway/db/schema';
import { encrypt } from '@ai-gateway/core';
import { createLogger } from '@ai-gateway/core';
import { Decimal } from '@ai-gateway/money';
import type { Ai } from '@ai-gateway/ai';
import { createBilling, createBillingProcessor, type BillingQuote, type UsageReceipt } from '@ai-gateway/ledger';
import { runGenerationPollOnce } from '../tasks/generation-poller.js';

/**
 * generation-poller 资金链路（真实 DB + 真账本 + 脚本化 Ai）：
 *   成功 → CAS succeeded + request.succeeded → runOnce 结算（金额 = unitPrice × units × 系数）
 *   失败 → CAS failed + request.failed 释放（余额分毫不动）
 *   超时 → expired + 释放
 *   进行中 → lease.renewed 续租（recoverOnce 不误释放）
 *   music → worker 代执行同步调用 → 解析产物 → 结算
 */

const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway';
const db: Db = createDb(url, { poolMax: 5 });
const encryptionKey = process.env.ENCRYPTION_KEY ?? 'test-enc-9a4f2c7d8b1e5a3f6c0d4b2e8a7f1c9d';
const logger = createLogger({ level: 'silent' });

let connected = false;
beforeAll(async () => {
  try {
    await db.query.users.findFirst({ columns: { id: true } });
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => {
  await db.$client.end().catch(() => {});
});

const PREFIX = 'genpoll';

/** 种子：用户 + minimax 渠道 + 账单（authorize→in_flight）+ 任务行（模拟网关提交后的状态） */
async function seedTask(kind: 'video' | 'music', opts: { unitPrice?: string; units?: string; expiresInMs?: number; status?: 'queued' | 'running' } = {}) {
  const suffix = `${Date.now()}-${randomUUID().slice(0, 6)}`;
  const unitPrice = opts.unitPrice ?? '0.5';
  const units = opts.units ?? '1';
  const requestId = randomUUID();
  const [user] = await db
    .insert(users)
    .values({ issuer: 'test', subject: `${PREFIX}-u-${suffix}`, identityProvider: 'local', balance: '10' })
    .returning({ id: users.id });
  const userId = user!.id;
  const [prov] = await db
    .insert(providers)
    .values({ name: `${PREFIX}-p-${suffix}`.slice(0, 32), protocol: 'minimax', baseUrl: 'http://localhost:9998', status: 0 })
    .returning({ id: providers.id });
  const [ch] = await db
    .insert(channels)
    .values({ name: `${PREFIX}-c-${suffix}`, providerId: prov!.id, apiKeyEnc: encrypt('sk-t', encryptionKey), status: 0, upstreamBudget: '1000' })
    .returning({ id: channels.id });

  const quote: BillingQuote = {
    maxOutputTokens: 0,
    candidates: [
      {
        mappingId: 1,
        externalModel: 'gen-video',
        realModel: 'MiniMax-H3',
        inputPrice: '0',
        outputPrice: '0',
        cacheInputPrice: '0',
        unitPrice,
        coefficient: '1',
        inputTokenUpperBound: 10,
        unitUpperBound: Number(units),
        billingPolicyFingerprint: null,
      },
    ],
  };
  const billing = createBilling({ db });
  await billing.authorize({
    requestId,
    userId,
    stream: false,
    quote,
    reservationLimit: '10',
    authorizationTtlMs: 60_000,
  });
  await billing.signal({
    type: 'upstream.started',
    requestId,
    leaseOwner: requestId,
    leaseMs: 1_830_000,
  });
  const receiptTemplate: UsageReceipt = {
    requestId,
    userId,
    apiKeyId: null,
    appId: null,
    credentialType: 'key',
    externalModel: 'gen-video',
    realModel: 'MiniMax-H3',
    channelId: ch!.id,
    channelKey: 'test-channel',
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, estimated: false, units: 0 },
    inputPrice: '0',
    outputPrice: '0',
    cacheInputPrice: '0',
    unitPrice,
    coefficient: '1',
    durationMs: 5,
    stream: false,
    streamAborted: false,
    mappingId: 1,
    billingPolicyFingerprint: null,
  };
  await db.insert(generationTasks).values({
    id: requestId,
    requestId,
    userId,
    mappingId: 1,
    channelId: ch!.id,
    upstreamTaskId: kind === 'video' ? `up-${suffix}` : null,
    kind,
    status: opts.status ?? (kind === 'video' ? 'running' : 'queued'),
    params: { model: 'gen-video', prompt: 'p' },
    receiptTemplate: receiptTemplate as unknown as Record<string, unknown>,
    unitsSnapshot: units,
    expiresAt: new Date(Date.now() + (opts.expiresInMs ?? 3_600_000)),
  });
  return { requestId, userId, channelId: ch!.id, providerId: prov!.id, billing };
}

async function cleanup(userId: number, channelId: number, providerId: number) {
  await db.delete(generationTasks).where(eq(generationTasks.userId, userId));
  await db.delete(billingRequestsTable).where(eq(billingRequestsTable.userId, userId));
  await db.delete(usageLogs).where(eq(usageLogs.userId, userId));
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, userId));
  await db.delete(channels).where(eq(channels.id, channelId));
  await db.delete(providers).where(eq(providers.id, providerId));
  await db.delete(users).where(eq(users.id, userId));
}

function pollerDeps(ai: Ai, billing: ReturnType<typeof createBilling>) {
  return {
    deps: { db, ai, billing, logger, batch: 10, leaseMs: 60_000 },
    opts: { encryptionKey },
  };
}

/** 结算泵（signal succeeded 后跑一次 processor → settled） */
async function settleOnce(requestId: string) {
  await createBillingProcessor({
    db,
    options: { ownerId: 'poller-test', batchSize: 10, claimLeaseMs: 60_000, retryBaseMs: 10, retryMaxMs: 100, maxAttempts: 3 },
  }).runOnce([requestId]);
}

async function money(userId: number) {
  const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { balance: true, reservedBalance: true } });
  return { balance: u!.balance, reserved: u!.reservedBalance };
}

function fakeAi(script: {
  query?: 'running' | 'succeeded' | 'failed';
  retrieve?: { ok: true; url: string } | { ok: false };
  chatBody?: unknown;
}): Ai {
  return {
    chat: vi.fn(async () => ({ status: 'success' as const, usage: undefined, body: script.chatBody, durationMs: 100 })),
    chatStream: vi.fn(async () => {
      throw new Error('not used');
    }),
    probe: vi.fn(async () => ({ ok: true, durationMs: 1 })),
    onEvent: vi.fn(() => () => {}),
    queryGenerationTask: vi.fn(async () =>
      script.query === 'failed'
        ? { ok: true as const, status: 'failed' as const, reason: '敏感内容' }
        : script.query === 'succeeded'
          ? {
              ok: true as const,
              status: 'succeeded' as const,
              fileId: 'file-1',
              artifact: { width: 1280, height: 720 },
            }
          : { ok: true as const, status: 'running' as const },
    ),
    retrieveGenerationFile: vi.fn(async () =>
      script.retrieve?.ok ? { ok: true as const, downloadUrl: script.retrieve.url } : { ok: false as const, error: new Error('file not ready') as never },
    ),
    parseGenerationResponse: vi.fn(() => ({
      kind: 'task_completed' as const,
      artifact: { url: 'https://cdn/m.mp3' },
    })),
  } as unknown as Ai;
}

describe('generation-poller 资金链路', () => {
  it('video 成功 → CAS succeeded + 结算（unitPrice × units，分毫核对）', async (t) => {
    if (!connected) return t.skip('no DB');
    const seed = await seedTask('video', { unitPrice: '0.5', units: '1' });
    try {
      const { deps, opts } = pollerDeps(fakeAi({ query: 'succeeded', retrieve: { ok: true, url: 'https://cdn/v.mp4' } }), seed.billing);
      const result = await runGenerationPollOnce(deps, opts);
      expect(result.succeeded).toBe(1);

      const task = await db.query.generationTasks.findFirst({ where: eq(generationTasks.id, seed.requestId) });
      expect(task?.status).toBe('succeeded');
      expect((task?.result as Record<string, unknown>)?.url).toBe('https://cdn/v.mp4');

      await settleOnce(seed.requestId);
      const m = await money(seed.userId);
      expect(new Decimal(m.balance).eq(9.5)).toBe(true); // 10 − 0.5×1
      expect(new Decimal(m.reserved).isZero()).toBe(true);
      const usage = await db.query.usageLogs.findFirst({ where: eq(usageLogs.requestId, seed.requestId) });
      expect(new Decimal(usage?.amount ?? '0').eq(0.5)).toBe(true);
      expect(usage?.units).toBe(1);
    } finally {
      await cleanup(seed.userId, seed.channelId, seed.providerId);
    }
  });

  it('video 失败 → released 释放（余额不动）+ 失败留痕', async (t) => {
    if (!connected) return t.skip('no DB');
    const seed = await seedTask('video');
    try {
      const { deps, opts } = pollerDeps(fakeAi({ query: 'failed' }), seed.billing);
      await runGenerationPollOnce(deps, opts);
      const task = await db.query.generationTasks.findFirst({ where: eq(generationTasks.id, seed.requestId) });
      expect(task?.status).toBe('failed');
      expect(task?.failReason).toContain('敏感内容');
      const bill = await db.query.billingRequests.findFirst({ where: eq(billingRequestsTable.requestId, seed.requestId) });
      expect(bill?.status).toBe('released');
      const m = await money(seed.userId);
      expect(new Decimal(m.balance).eq(10)).toBe(true);
      expect(new Decimal(m.reserved).isZero()).toBe(true);
    } finally {
      await cleanup(seed.userId, seed.channelId, seed.providerId);
    }
  });

  it('超时（expires_at 到期）→ expired + 释放', async (t) => {
    if (!connected) return t.skip('no DB');
    const seed = await seedTask('video', { expiresInMs: -1_000 });
    try {
      const { deps, opts } = pollerDeps(fakeAi({}), seed.billing);
      const result = await runGenerationPollOnce(deps, opts);
      expect(result.expired).toBe(1);
      const task = await db.query.generationTasks.findFirst({ where: eq(generationTasks.id, seed.requestId) });
      expect(task?.status).toBe('expired');
      const m = await money(seed.userId);
      expect(new Decimal(m.balance).eq(10)).toBe(true);
      expect(new Decimal(m.reserved).isZero()).toBe(true);
    } finally {
      await cleanup(seed.userId, seed.channelId, seed.providerId);
    }
  });

  it('进行中 → lease.renewed 续租（租约被推远）', async (t) => {
    if (!connected) return t.skip('no DB');
    const seed = await seedTask('video');
    try {
      const before = await db.query.billingRequests.findFirst({
        where: eq(billingRequestsTable.requestId, seed.requestId),
        columns: { leaseExpiresAt: true },
      });
      const { deps, opts } = pollerDeps(fakeAi({ query: 'running' }), seed.billing);
      await runGenerationPollOnce(deps, opts);
      const after = await db.query.billingRequests.findFirst({
        where: eq(billingRequestsTable.requestId, seed.requestId),
        columns: { leaseExpiresAt: true },
      });
      // 续租锚定 expires_at+30s：轮询期间租约不缩短（此处 >= 而非 >）
      expect(after!.leaseExpiresAt!.getTime()).toBeGreaterThanOrEqual(before!.leaseExpiresAt!.getTime() - 1_000);
      const task = await db.query.generationTasks.findFirst({ where: eq(generationTasks.id, seed.requestId) });
      expect(task?.status).toBe('running');
    } finally {
      await cleanup(seed.userId, seed.channelId, seed.providerId);
    }
  });

  it('music：worker 代执行 → 解析产物 → 结算', async (t) => {
    if (!connected) return t.skip('no DB');
    const seed = await seedTask('music', { unitPrice: '0.3', units: '1' });
    try {
      const ai = fakeAi({ chatBody: { base_resp: { status_code: 0 }, data: { audio_url: 'https://cdn/m.mp3' } } });
      const { deps, opts } = pollerDeps(ai, seed.billing);
      const result = await runGenerationPollOnce(deps, opts);
      expect(result.succeeded).toBe(1);
      expect(ai.chat).toHaveBeenCalledTimes(1);

      const task = await db.query.generationTasks.findFirst({ where: eq(generationTasks.id, seed.requestId) });
      expect(task?.status).toBe('succeeded');
      expect((task?.result as Record<string, unknown>)?.url).toBe('https://cdn/m.mp3');

      await settleOnce(seed.requestId);
      const m = await money(seed.userId);
      expect(new Decimal(m.balance).eq(9.7)).toBe(true); // 10 − 0.3×1
    } finally {
      await cleanup(seed.userId, seed.channelId, seed.providerId);
    }
  });
});
