import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { eq, sql } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { users, usageLogs, transactions } from '@ai-gateway/db/schema';
import { Decimal } from '@ai-gateway/money';
import { settle, type MeterJobData } from './settle.js';

/**
 * 重构后：C2 资损场景已从架构层消除（不再有 Redis 余额缓存，DB 是唯一权威）。
 *
 * 旧 C2 bug：settle 重放跳过 redis.del(余额缓存) → 脏缓存粘滞 → 虚高余额 → 超额放行。
 * 重构后：余额缓存彻底删除（billing:balance 不再使用），getBalance 直接查 DB。
 *   → 不存在「脏缓存」概念，C2 场景天然不可能发生。
 *
 * 本测试转而验证重构后的等价不变量（资损防线仍在）：
 *   1. settle 重放（幂等跳过）时，自己的 hold 标记仍被清理（防 hold 残留锁余额）
 *   2. settle 后余额以 DB 为准（无缓存层可脏）
 *   3. 重放不重复扣费（幂等）
 *
 * 价格：input 1000 元/M、output 2000 元/M；usage 1000+500 → amount = 2 元。
 */

const cwd = dirname(fileURLToPath(import.meta.url));
function loadEnvFile(): void {
  let dir = cwd;
  for (let i = 0; i < 6; i++) {
    const f = resolve(dir, '.env');
    if (existsSync(f)) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
        if (m && m[1] && !(m[1] in process.env)) process.env[m[1]] = m[2];
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
loadEnvFile();

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const db: Db = createDb(DATABASE_URL);
const redis = new Redis(REDIS_URL, { retryStrategy: () => null, lazyConnect: true, maxRetriesPerRequest: null });

let connected = false;
beforeAll(async () => {
  try {
    await redis.connect();
    await db.query.users.findFirst({ where: eq(users.id, 1), columns: { id: true } });
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => {
  await redis.quit().catch(() => {});
  await db.$client.end().catch(() => {});
});

async function createTestUser(balance: string): Promise<number> {
  const [u] = await db.insert(users).values({
    issuer: 'test',
    subject: 'c2-replay-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    identityProvider: 'local', displayName: 'C2 Replay', balance,
  }).returning();
  return u!.id;
}
async function cleanupUser(userId: number): Promise<void> {
  await db.delete(usageLogs).where(eq(usageLogs.userId, userId));
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
  await redis.del(`billing:balance:${userId}`).catch(() => {});
}

function makeJob(userId: number, requestId: string): MeterJobData {
  return {
    apiKeyId: null, appId: null, credentialType: 'key',
    externalModel: 'm', realModel: 'r', channelId: null,
    usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 500, estimated: false },
    inputPrice: '1000', outputPrice: '2000', cacheInputPrice: '100',
    coefficient: '1.0', durationMs: 100,
    stream: false, streamAborted: false, holdAmount: '0', mappingId: 1,
    userId, requestId,
  };
}

describe('重构后：余额缓存已删除，C2 资损场景从架构层消除', () => {
  it('settle 重放（幂等）→ 不重复扣费 + hold 标记被清理', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser('100');
    const requestId = randomUUID();
    const holdKey = `billing:hold:${requestId}`;
    try {
      // 模拟真实 hold：DB 扣 2 + Redis 写 hold 标记（与 gateway billing.hold 同口径）
      await db.update(users).set({ balance: sql`${users.balance} - 2::numeric` }).where(eq(users.id, userId));
      await redis.set(holdKey, `${userId}:2`, 'PX', 600000);

      // 第一次 settle：GETDEL 退 hold(2) + 扣实际(2) → 净 0，余额维持 98（100-2hold）
      const r1 = await settle(db, redis, makeJob(userId, requestId));
      expect(r1.settled).toBe(true);
      expect(await redis.get(holdKey)).toBeNull(); // hold 标记被 GETDEL 清理

      // 重新写回 hold 标记（模拟「del 未执行」的脏状态）
      await redis.set(holdKey, `${userId}:2`, 'PX', 600000);

      // 第二次 settle（重放，模拟崩溃后 BullMQ 重投）
      const r2 = await settle(db, redis, makeJob(userId, requestId));
      expect(r2.settled).toBe(false); // 已结算，幂等跳过

      // 重放也清理 hold 标记（防残留锁余额）
      expect(await redis.get(holdKey)).toBeNull();

      // 余额只扣一次：hold 扣 2 + settle 退 2 扣 2 = 净扣 2 → 100 - 2 = 98
      const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { balance: true } });
      expect(new Decimal(u?.balance ?? '0').equals(new Decimal('98'))).toBe(true);
    } finally {
      await cleanupUser(userId);
      await redis.del(holdKey).catch(() => {});
    }
  });

  it('DB 是唯一权威：无 billing:balance 缓存层可脏', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser('100');
    const requestId = randomUUID();
    try {
      // 故意写一个「脏」的 billing:balance（模拟遗留/外部写入）
      await redis.set(`billing:balance:${userId}`, '999999');
      // settle 后 DB 余额准确（缓存层不再被 hold/getBalance 读取）
      await settle(db, redis, makeJob(userId, requestId));
      const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { balance: true } });
      expect(new Decimal(u?.balance ?? '0').toString()).toBe('98'); // DB 准确，缓存脏值不影响
    } finally {
      await cleanupUser(userId);
    }
  });
});
