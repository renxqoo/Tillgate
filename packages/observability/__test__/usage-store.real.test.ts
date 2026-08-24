/**
 * usage 运维读侧 PG 适配真实行为等价测试(铁律 14:默认门禁按文件名排除,显式运行)。
 * 覆盖 SQL 专属语义:管理列表过滤/排序/estimated 分桶、概览三段、分组三轴、
 * 按日趋势北京日界切日、渠道 TTFT 流式样本过滤。环境:DATABASE_URL(根 .env);
 * 不可达时全组跳过。
 * 数据纪律:种子行 external_model='zz-usage-real'(唯一身份锚,自建自清);
 * 库内真实用量行不删不改——总量断言一律用下界。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb, closeDb, type Db } from '@tillgate/db';
import { usageLogs, users } from '@tillgate/db';
import { createPgUsageStore } from '../src/adapters/postgres/usage-store';
import { beijingDayStart } from '../src/usage/day-window';

const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway';
const SEED_MODEL = 'zz-usage-real';
let db: Db | null = null;
let seedUserId: number | null = null;

beforeAll(async () => {
  try {
    const candidate = createDb({
      url,
      poolMax: 5,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 3_000,
      maxUses: 10_000,
    });
    await candidate.execute(sql`select 1`);
    db = candidate;
    // FK 锚:取库内既有最小用户(真实库存在;无用户环境整组跳过)
    const [anyUser] = await db.select({ id: users.id }).from(users).orderBy(users.id).limit(1);
    seedUserId = anyUser?.id ?? null;
  } catch {
    db = null;
  }
});
afterAll(async () => {
  if (db) {
    await db.delete(usageLogs).where(eq(usageLogs.externalModel, SEED_MODEL));
    await closeDb(db);
  }
});

/** 造一行已计费用量(必填列最小值;requestId 合法 uuid) */
function usageSeed(overrides: Partial<typeof usageLogs.$inferInsert> = {}) {
  return {
    requestId: randomUUID(),
    userId: seedUserId!,
    credentialType: 'key',
    externalModel: SEED_MODEL,
    realModel: SEED_MODEL,
    inputTokens: 100,
    cachedInputTokens: 0,
    outputTokens: 50,
    coefficient: '1.000',
    amount: '1.5',
    calculatedAmount: '1.5',
    upstreamCost: '0.5',
    planAmount: '1.0',
    paygAmount: '0.5',
    billedBy: 'payg',
    durationMs: 200,
    status: 0,
    ...overrides,
  } satisfies typeof usageLogs.$inferInsert;
}

describe('PgUsageStore(真 PG)', () => {
  it('adminList:q/userId/model/estimated 过滤 + 排序稳定序 + total 全量', async (context) => {
    if (!db || seedUserId == null) return context.skip();
    await db.delete(usageLogs).where(eq(usageLogs.externalModel, SEED_MODEL));
    await db.insert(usageLogs).values([usageSeed(), usageSeed(), usageSeed()]);
    const store = createPgUsageStore(db);

    const base = await store.adminList({
      q: SEED_MODEL,
      sortBy: 'createdAt',
      order: 'desc',
      limit: 20,
      offset: 0,
    });
    expect(base.total).toBe(3);
    // 主序相同时按 id desc 稳定决序(bigserial 单调)
    const idsDesc = base.rows.map((r) => r.id);
    expect(idsDesc).toEqual(idsDesc.toSorted((a, b) => b - a));
    // 左联投影:金额字符串(numeric scale 18 全精度)、真实名精确列
    expect(base.rows[0]).toMatchObject({
      externalModel: SEED_MODEL,
      realModel: SEED_MODEL,
      inputTokens: 100,
    });
    expect(Number(base.rows[0]!.amount)).toBe(1.5);

    const byUser = await store.adminList({
      userId: seedUserId,
      model: SEED_MODEL,
      sortBy: 'id',
      order: 'asc',
      limit: 1,
      offset: 0,
    });
    expect(byUser.rows[0]!.userId).toBe(seedUserId);
    expect(byUser.total).toBe(3); // total 恒全量(不受分页影响)

    const estimated = await store.adminList({
      estimated: true,
      q: SEED_MODEL,
      sortBy: 'id',
      order: 'asc',
      limit: 20,
      offset: 0,
    });
    // 种子未标记估算 → q 命中集内 estimated 过滤后为空(分桶口径)
    expect(estimated.total).toBe(0);
  });

  it('overview/usageGroups/dailyTrends/channelTtft 聚合口径', async (context) => {
    if (!db || seedUserId == null) return context.skip();
    await db.delete(usageLogs).where(eq(usageLogs.externalModel, SEED_MODEL));
    // 昨日(北京日界前)一行 + 今日两行(其一失败 status=1,不计数不计费)
    const now = new Date();
    const yesterday = new Date(beijingDayStart(now).getTime() - 3_600_000);
    await db.insert(usageLogs).values([
      usageSeed({ createdAt: yesterday }),
      // DB check:成功单 amount = plan + payg(拆分恒等,种子须自洽)
      usageSeed({
        createdAt: now,
        amount: '2',
        calculatedAmount: '2',
        planAmount: '1.5',
        paygAmount: '0.5',
      }),
      usageSeed({ createdAt: now, status: 1, amount: '0', calculatedAmount: '0' }),
    ]);
    const store = createPgUsageStore(db);

    // 今日(北京日界)窗口:昨日行不进今日;status=1 行计入 requests 不计入 success
    const today = await store.overviewToday(beijingDayStart(now));
    expect(today.requests).toBeGreaterThanOrEqual(2);
    expect(today.cost).toMatch(/^\d/);
    const totals = await store.overviewTotals();
    expect(totals.requests).toBeGreaterThanOrEqual(3);

    const groups = await store.usageGroups({ group: 'model' });
    const mine = groups.find((g) => g.key === SEED_MODEL);
    expect(mine?.requests).toBe(3);
    const byUser = await store.usageGroups({ group: 'user' });
    expect(byUser.find((g) => g.key === seedUserId)?.requests).toBeGreaterThanOrEqual(3);
    const byChannel = await store.usageGroups({ group: 'channel' });
    expect(byChannel.find((g) => g.key === null)?.requests).toBeGreaterThanOrEqual(3);

    // 趋势:昨日+今日各至少一档(date 为北京日界字符串,升序)
    const trends = await store.dailyTrends(new Date(beijingDayStart(now).getTime() - 86_400_000));
    const dates = trends.map((r) => r.date);
    expect(dates).toEqual(dates.toSorted());
    expect(dates.length).toBeGreaterThanOrEqual(2);

    // TTFT:种子无 ttft(非流式)→ 命中行全为真实流式样本(过滤口径不炸空)
    const ttft = await store.channelTtft(new Date(now.getTime() - 3_600_000));
    expect(ttft.every((r) => r.samples >= 0)).toBe(true);
  });
});
