import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { billingRequests, channels, providers } from '@ai-gateway/db/schema';
import {
  loadEnvFileIntoProcess,
  ensureTestSecrets,
  createTestDb,
  createTestRedis,
  isBackendAvailable,
  createTestUser,
  cleanupTestData,
} from '../helpers.js';

/**
 * R4 回归（渠道敞口投影）：cleanupTestData 只能回收「仍在途」的渠道预占。
 *
 * 事故（2026-08-16 渠道 2）：敞口收集查询无状态过滤，把已结算行
 * （结算时已释放过渠道预占）的 channel_reserved_amount 又减了一次 →
 * channels.upstream_reserved 比账面在途短 0.0003738 元 →
 * 人工 resolve 的释放守卫（upstream_reserved >= amount）失败 →
 * state_conflict，复核单永久卡死。测试自建渠道随删随清从未暴露，
 * 对真实渠道跑清理即中招。
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

describe('cleanupTestData 渠道敞口回收（R4）', () => {
  it('只回收在途状态的渠道预占；已结算/已释放的行不得再扣一次', async () => {
    if (!connected) return it.skip('no DB');
    const prefix = 'cchexp';
    const userId = await createTestUser(db, '1000', prefix);
    // 独立渠道：清理后自删（前缀识别）
    const [prov] = await db
      .insert(providers)
      .values({ name: `${prefix}-prov-${Date.now()}`, protocol: 'openai-compatible', baseUrl: 'http://localhost:9999' })
      .returning();
    const [ch] = await db
      .insert(channels)
      .values({
        providerId: prov!.id,
        name: `${prefix}-ch-${Date.now()}`,
        apiKeyEnc: 'enc:v1:00:00:00',
        upstreamReserved: '1.0', // 0.5（在途 A）+ 0.3（已释放 B，账上已不含）+ 0.2（他人敞口，不归本次清理动）
      })
      .returning();
    try {
      const mk = (status: string, amount: string, revision: number, withReceipt = false) => ({
        requestId: randomUUID(),
        userId,
        channelId: ch!.id,
        channelReservedAmount: amount,
        reservedAmount: amount,
        status,
        revision,
        stream: true,
        quote: {},
        authorizationFingerprint: 'a'.repeat(64),
        // DB 状态机 CHECK：settled 必须带 receipt（测试例外允许直插，但守不变量）
        ...(withReceipt ? { receipt: { requestId: 'r', tokens: 1 }, settledAt: new Date() } : {}),
      });
      await db.insert(billingRequests).values([
        mk('uncertain', '0.5', 2), // 在途：预占仍占着渠道投影
        mk('settled', '0.3', 3, true), // 已结算：结算时渠道预占已释放，账上不再包含
        mk('released', '0.1', 4), // 已释放：同上
      ]);
      await cleanupTestData(db, redis, userId, null, null);
      const after = await db.query.channels.findFirst({
        where: eq(channels.id, ch!.id),
        columns: { upstreamReserved: true },
      });
      // 正确：只扣在途 uncertain 的 0.5 → 1.0-0.5=0.5
      // （旧 bug：把 settled 0.3 + released 0.1 也扣了 → 0.1，渠道投影被蛀空）
      expect(Number(after?.upstreamReserved)).toBe(0.5);
    } finally {
      await db.delete(billingRequests).where(eq(billingRequests.userId, userId)).catch(() => {});
      await db.delete(channels).where(eq(channels.id, ch!.id)).catch(() => {});
      await db.delete(providers).where(eq(providers.id, prov!.id)).catch(() => {});
      await db.delete(billingRequests).where(eq(billingRequests.userId, userId)).catch(() => {});
    }
  });
});
