import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { Decimal } from '@ai-gateway/money';
import { computeAmounts } from '@ai-gateway/ledger';
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
  waitForBillingStatus,
  BILLING_SETTLE_STATES,
} from '../../testing/helpers.js';
import { billingRequests, rateCardCoefficients, rateCards, users } from '@ai-gateway/db/schema';
import type { UsageReceipt } from '@ai-gateway/ledger';
import { rateCardCoefficientsCache } from '@ai-gateway/http';

/**
 * 系数解析（model>group>global）+ 单位计费 的端到端回归。
 *
 * 断言落点（不依赖环境 worker——durable 收据即结算输入，金额用结算单一真相
 * computeAmounts 对收据复算；usage_logs 落库由 ledger 侧测试覆盖）：
 *   billing_requests.receipt.coefficient / usage.units / unitPrice
 *   billing_requests.quote.candidates[].coefficient / unitUpperBound
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

/** 建卡 + 系数行；返回卡 id（createdCards 收集供清理） */
const createdCards: number[] = [];
async function createCard(
  rows: Array<{
    scope: 'global' | 'model' | 'group';
    coefficient: string;
    modelMappingId?: number;
    groupKey?: string;
  }>,
  status = 0,
): Promise<number> {
  const [card] = await db
    .insert(rateCards)
    .values({ name: `e2ecoeff-${Date.now()}-${createdCards.length}`, status })
    .returning({ id: rateCards.id });
  const cardId = card!.id;
  createdCards.push(cardId);
  await db.insert(rateCardCoefficients).values(
    rows.map((r) => ({
      rateCardId: cardId,
      scope: r.scope,
      coefficient: r.coefficient,
      modelMappingId: r.modelMappingId ?? null,
      groupKey: r.groupKey ?? null,
    })),
  );
  return cardId;
}

async function bindCard(userId: number, cardId: number): Promise<void> {
  await db.update(users).set({ rateCardId: cardId }).where(eq(users.id, userId));
}

async function cleanupCards(): Promise<void> {
  for (const cardId of createdCards) {
    await db.delete(rateCardCoefficients).where(eq(rateCardCoefficients.rateCardId, cardId));
    await db.delete(rateCards).where(eq(rateCards.id, cardId));
    await redis.del(rateCardCoefficientsCache(cardId)).catch(() => {});
  }
}

function mockAiWithUsage(usage: Record<string, number>) {
  return makeMockAi({
    chat: vi.fn(async () => ({
      status: 'success' as const,
      usage: {
        inputTokens: usage.inputTokens ?? 0,
        cachedInputTokens: usage.cachedInputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        units: usage.units ?? 0,
        estimated: false,
        raw: {},
      },
      body: { id: 'mock', object: 'chat.completion', choices: [] },
      durationMs: 5,
    })),
  });
}

interface ReceiptRow {
  quote: unknown;
  receipt: unknown;
}

/** 跑一次非流式 chat，返回 durable 账单快照（receipt 已提交） */
async function runChatAndFetchReceipt(
  app: ReturnType<typeof buildTestApp>,
  token: string,
  externalModel: string,
  userId: number,
): Promise<ReceiptRow> {
  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: externalModel, messages: [{ role: 'user', content: 'hi' }] }),
  });
  expect(res.status).toBe(200);
  await waitForBillingStatus(db, userId, BILLING_SETTLE_STATES, 5000);
  const row = await db.query.billingRequests.findFirst({
    where: eq(billingRequests.userId, userId),
    columns: { quote: true, receipt: true },
  });
  expect(row?.receipt).toBeTruthy();
  return row as unknown as ReceiptRow;
}

describe('费率卡系数端到端（model > group > global）', () => {
  it('model 覆盖行 → 收据 coefficient=0.500，quote 候选带 0.500，结算金额 500 元', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '100000', 'coefm');
    const { token, keyHash } = await createTestApiKey(db, userId, 'coefm');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    const cardId = await createCard([
      { scope: 'global', coefficient: '2.000' },
      { scope: 'model', coefficient: '0.500', modelMappingId: ids.mappingId },
    ]);
    await bindCard(userId, cardId);
    try {
      const app = buildTestApp(db, redis, mockAiWithUsage({ inputTokens: 1_000_000 }));
      const row = await runChatAndFetchReceipt(app, token, ids.externalModel, userId);
      expect((row.receipt as Record<string, any>).coefficient).toBe('0.500');
      expect(((row.quote as Record<string, any>).candidates ?? [])[0]?.coefficient).toBe('0.500');
      // 结算单一真相复算：官方输入价 1000 元/百万 × 1M token × 0.5 = 500 元
      expect(new Decimal(computeAmounts(row.receipt as unknown as UsageReceipt).calculatedAmount).eq(500)).toBe(true);
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });

  it('group 覆盖行（pricingGroup 匹配）→ 0.800；无匹配回退 global 2.000', async () => {
    if (!connected) return it.skip('no DB');
    const cardId = await createCard([
      { scope: 'global', coefficient: '2.000' },
      { scope: 'group', coefficient: '0.800', groupKey: 'e2e-grp' },
    ]);
    const userA = await createTestUser(db, '100000', 'coefg');
    const keyA = await createTestApiKey(db, userA, 'coefg');
    const idsA = await setupTestModel(db, process.env.ENCRYPTION_KEY!, { pricingGroup: 'e2e-grp' });
    await bindCard(userA, cardId);
    const userB = await createTestUser(db, '100000', 'coefp');
    const keyB = await createTestApiKey(db, userB, 'coefp');
    const idsB = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    await bindCard(userB, cardId);
    try {
      const app = buildTestApp(db, redis, mockAiWithUsage({ inputTokens: 1_000_000 }));
      const rowA = await runChatAndFetchReceipt(app, keyA.token, idsA.externalModel, userA);
      expect((rowA.receipt as Record<string, any>).coefficient).toBe('0.800');
      expect(new Decimal(computeAmounts(rowA.receipt as unknown as UsageReceipt).calculatedAmount).eq(800)).toBe(true);
      const rowB = await runChatAndFetchReceipt(app, keyB.token, idsB.externalModel, userB);
      expect((rowB.receipt as Record<string, any>).coefficient).toBe('2.000');
      expect(new Decimal(computeAmounts(rowB.receipt as unknown as UsageReceipt).calculatedAmount).eq(2000)).toBe(true);
    } finally {
      await cleanupTestData(db, redis, userA, keyA.keyHash, idsA);
      await cleanupTestData(db, redis, userB, keyB.keyHash, idsB);
    }
  });

  it('停用卡 → 403 rate_card_disabled', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '100000', 'coefd');
    const { token, keyHash } = await createTestApiKey(db, userId, 'coefd');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    const cardId = await createCard([{ scope: 'global', coefficient: '1.000' }], 1);
    await bindCard(userId, cardId);
    try {
      const app = buildTestApp(db, redis, mockAiWithUsage({ inputTokens: 10 }));
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: ids.externalModel, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('rate_card_disabled');
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });
});

describe('单位计费端到端（units × unitPrice × 系数）', () => {
  it('按张计费：3 张 × 0.05 元 × 0.5 → 收据 units=3/unitPrice=0.05，quote 候选 unitUpperBound=1（未传 n），复算 0.075 元', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '100000', 'unitm');
    const { token, keyHash } = await createTestApiKey(db, userId, 'unitm');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!, {
      pricingUnit: 'image',
      unitPrice: '0.05',
      inputPrice: '0',
      outputPrice: '0',
      cacheInputPrice: '0',
    });
    const cardId = await createCard([{ scope: 'global', coefficient: '0.500' }]);
    await bindCard(userId, cardId);
    try {
      const app = buildTestApp(db, redis, mockAiWithUsage({ units: 3 }));
      const row = await runChatAndFetchReceipt(app, token, ids.externalModel, userId);
      expect(((row.receipt as Record<string, any>).usage ?? {}).units).toBe(3);
      expect(new Decimal(String((row.receipt as Record<string, any>).unitPrice ?? '0')).eq('0.05')).toBe(true);
      expect(((row.quote as Record<string, any>).candidates ?? [])[0]?.unitUpperBound).toBe(1);
      expect(new Decimal(computeAmounts(row.receipt as unknown as UsageReceipt).calculatedAmount).eq('0.075')).toBe(true);
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });

  it("token 模型：收据单位字段 0 与 '0'（行为不变护栏）", async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '100000', 'unitt');
    const { token, keyHash } = await createTestApiKey(db, userId, 'unitt');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    try {
      const app = buildTestApp(db, redis, mockAiWithUsage({ inputTokens: 100, outputTokens: 50 }));
      const row = await runChatAndFetchReceipt(app, token, ids.externalModel, userId);
      expect(((row.receipt as Record<string, any>).usage ?? {}).units ?? 0).toBe(0);
      expect(new Decimal(String((row.receipt as Record<string, any>).unitPrice ?? '0')).eq(0)).toBe(true);
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });
});

afterAll(async () => {
  await cleanupCards();
});
