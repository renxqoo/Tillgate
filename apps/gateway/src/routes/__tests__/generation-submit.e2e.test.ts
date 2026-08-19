import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { billingRequests, generationTasks } from '@ai-gateway/db/schema';
import { Decimal } from '@ai-gateway/wallet/metering';
import {
  loadEnvFileIntoProcess,
  ensureTestSecrets,
  createTestDb,
  createTestRedis,
  isBackendAvailable,
  createTestUser,
  createTestApiKey,
  setupTestModel,
  cleanupTestData,
  buildTestApp,
  makeMockAi,
  type TestModelIds,
} from '../../testing/helpers.js';

/**
 * 异步生成任务提交 e2e（video/music，任务框架的网关侧）：
 *   - video：上游提交（mock Ai 规范形）→ 201 + generation_tasks 落库（收据模板/
 *     单位快照/TTL）+ billing in_flight（upstream.started 带 TTL 租约）
 *   - 按次 vs 按秒：units 快照（1 vs duration）与预留金额分毫核对
 *   - GET /v1/videos/:id：归属校验（他人任务 404）
 *   - music：不调上游（chat mock 断言零调用）→ 任务登记 queued
 * 终态结算/释放/超时在 worker 侧 generation-poller.test.ts 覆盖。
 */

loadEnvFileIntoProcess();
ensureTestSecrets();

const db = createTestDb();
const redis = createTestRedis();

let connected = false;
beforeAll(async () => {
  await redis.connect().catch(() => {});
  connected = await isBackendAvailable(db, redis);
});
afterAll(async () => {
  await redis.quit().catch(() => {});
  await db.$client.end().catch(() => {});
});

/** video 提交 mock（任务操作面同型）：提交成功返回 task_id */
function generationSubmitAi() {
  return makeMockAi({
    chat: vi.fn(async () => ({
      status: 'success' as const,
      usage: undefined,
      body: { base_resp: { status_code: 0, status_msg: 'success' }, task_id: 'mm-task-1', status: 'Queueing' },
      durationMs: 30,
    })),
    parseGenerationResponse: vi.fn(() => ({ kind: 'task_submitted' as const, taskId: 'mm-task-1' })),
  });
}

function musicAi() {
  return makeMockAi({
    chat: vi.fn(async () => ({ status: 'success' as const, durationMs: 1 })),
    parseGenerationResponse: vi.fn(() => ({
      kind: 'task_completed' as const,
      artifact: { url: 'https://cdn/m.mp3' },
    })),
  });
}

async function latestBill(userId: number) {
  const [row] = await db
    .select()
    .from(billingRequests)
    .where(eq(billingRequests.userId, userId))
    .orderBy(desc(billingRequests.createdAt))
    .limit(1);
  return row;
}

describe('生成任务提交 e2e', () => {
  it('video 按次：201 + 任务行（收据模板/units=1/TTL）+ billing in_flight', async (t) => {
    if (!connected) return t.skip('no DB');
    const userId = await createTestUser(db, '10', 'genv');
    const { token, keyHash } = await createTestApiKey(db, userId);
    const ids: TestModelIds = await setupTestModel(db, process.env.ENCRYPTION_KEY!, {
      inputPrice: '0',
      outputPrice: '0',
      cacheInputPrice: '0',
      pricingUnit: 'request',
      unitPrice: '0.5',
    });
    const app = buildTestApp(db, redis, generationSubmitAi());
    try {
      const res = await app.request('/v1/video/generations', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: ids.externalModel, prompt: '一只猫在花园散步', duration: 6 }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; task_id: string; status: string };
      expect(body.task_id).toBe('mm-task-1');
      expect(body.status).toBe('queued');

      const bill = await latestBill(userId);
      expect(bill?.status).toBe('in_flight');
      // 预留 = unitPrice 0.5 × 1（按次）
      expect(new Decimal(bill?.reservedAmount ?? '0').eq(0.5)).toBe(true);
      // TTL 租约（默认 1800s + 30s 宽限 > 普通请求租约）
      expect(bill?.leaseExpiresAt).toBeDefined();

      const task = await db.query.generationTasks.findFirst({
        where: eq(generationTasks.id, body.id),
      });
      expect(task?.status).toBe('queued');
      expect(task?.kind).toBe('video');
      expect(task?.upstreamTaskId).toBe('mm-task-1');
      expect(task?.unitsSnapshot).toBe('1.000000000000000000');
      const template = task?.receiptTemplate as Record<string, unknown>;
      expect(new Decimal(template.unitPrice as string).eq(0.5)).toBe(true);
      expect((template.usage as Record<string, unknown>).units).toBe(0); // 模板 units=0，worker 终态填
      expect(new Date(task!.expiresAt).getTime()).toBeGreaterThan(Date.now());

      // 任务查询：本人 200 / 他人 404
      const mine = await app.request(`/v1/videos/${body.id}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(mine.status).toBe(200);
      const mineBody = (await mine.json()) as { status: string; video_url: string | null };
      expect(mineBody.status).toBe('queued');
      expect(mineBody.video_url).toBeNull();

      const other = await createTestUser(db, '0', 'geno');
      const { token: otherToken, keyHash: otherHash } = await createTestApiKey(db, other);
      const denied = await app.request(`/v1/videos/${body.id}`, {
        headers: { authorization: `Bearer ${otherToken}` },
      });
      expect(denied.status).toBe(404);
      await cleanupTestData(db, redis, other, otherHash, null);
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });

  it('video 按秒：duration=8 → units 快照 8 + 预留 0.5×8', async (t) => {
    if (!connected) return t.skip('no DB');
    const userId = await createTestUser(db, '10', 'gens');
    const { token, keyHash } = await createTestApiKey(db, userId);
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!, {
      inputPrice: '0',
      outputPrice: '0',
      cacheInputPrice: '0',
      pricingUnit: 'second',
      unitPrice: '0.5',
    });
    const app = buildTestApp(db, redis, generationSubmitAi());
    try {
      const res = await app.request('/v1/video/generations', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: ids.externalModel, prompt: '写首诗', duration: 8 }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string };
      const task = await db.query.generationTasks.findFirst({
        where: eq(generationTasks.id, body.id),
      });
      expect(task?.unitsSnapshot).toBe('8.000000000000000000');
      const bill = await latestBill(userId);
      expect(new Decimal(bill?.reservedAmount ?? '0').eq(4)).toBe(true); // 0.5 × 8s
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });

  it('music：不调上游，任务登记 queued（无 upstream_task_id）', async (t) => {
    if (!connected) return t.skip('no DB');
    const userId = await createTestUser(db, '10', 'genm');
    const { token, keyHash } = await createTestApiKey(db, userId);
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!, {
      inputPrice: '0',
      outputPrice: '0',
      cacheInputPrice: '0',
      pricingUnit: 'request',
      unitPrice: '0.3',
    });
    const ai = musicAi();
    const app = buildTestApp(db, redis, ai);
    try {
      const res = await app.request('/v1/music/generations', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: ids.externalModel, prompt: '爵士乐', lyrics: '[verse]la' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; status: string; task_id?: string };
      expect(body.status).toBe('queued');
      expect(body.task_id).toBeUndefined();
      // 网关不调上游（music 由 worker 代执行）
      expect(ai.chat).not.toHaveBeenCalled();
      const task = await db.query.generationTasks.findFirst({
        where: and(eq(generationTasks.id, body.id), eq(generationTasks.kind, 'music')),
      });
      expect(task?.upstreamTaskId).toBeNull();
      expect(task?.status).toBe('queued');
      const bill = await latestBill(userId);
      expect(bill?.status).toBe('in_flight');
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });
});
