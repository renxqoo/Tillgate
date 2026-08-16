import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { apiKeys, plans, userSubscriptions, users } from '@ai-gateway/db/schema';
import { authKeyCache, createRedis, loadRootEnvFile, type Redis } from '@ai-gateway/http';
import { keyRoutes } from './keys.js';
import { makeClientTestApp, makeServices } from '../test/helpers.js';

/**
 * L1/L3 回归锁定（Key 轮换与限流更新）：
 *   - L1 轮换沿用旧订阅前必须重校验：订阅已失效 → 新 Key 降级为个人余额
 *     （subscriptionId=null，响应与落库一致），而不是盲目继承失效订阅。
 *   - L3 PATCH 改 rpmLimit/tpmLimit/dailySpendLimit 后必须清网关鉴权缓存
 *     （auth:key:{hash}），否则旧限流快照最长 60s 内仍生效。
 * 数据纪律：全部 p1api- 前缀，finally 只删自己创建的行。
 */

loadRootEnvFile();

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
);
const redis: Redis = createRedis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');

let dbOk = false;
let redisOk = false;
beforeAll(async () => {
  try {
    await db.select({ id: users.id }).from(users).limit(1);
    dbOk = true;
  } catch {
    dbOk = false;
  }
  try {
    await redis.connect();
    const pong = await redis.ping();
    redisOk = pong === 'PONG';
  } catch {
    redisOk = false;
  }
});
afterAll(async () => {
  await redis.quit().catch(() => {});
  await db.$client.end().catch(() => {});
});

interface KeyFixture {
  userId: number;
  keyId: number;
  subscriptionId: number | null;
  cleanup: () => Promise<void>;
}

/** 用户 + 可选订阅 + 绑定该订阅的有效 Key */
async function setupUserWithKey(suffix: string, withSubscription: boolean): Promise<KeyFixture> {
  const [me] = await db
    .insert(users)
    .values({
      issuer: 'local',
      subject: `p1api-${suffix}`,
      identityProvider: 'local',
      email: `${suffix}@p1api.local`,
    })
    .returning({ id: users.id });
  let subscriptionId: number | null = null;
  let planId: number | null = null;
  if (withSubscription) {
    const [plan] = await db
      .insert(plans)
      .values({
        name: `p1api-plan-${suffix}`.slice(0, 32),
        kind: 'subscription',
        price: '10',
        periodDays: 30,
        quotaAmount: '100',
        sortOrder: 1,
        allowSeats: true,
        status: 0,
      })
      .returning({ id: plans.id });
    const [sub] = await db
      .insert(userSubscriptions)
      .values({
        userId: me!.id,
        planId: plan!.id,
        startAt: new Date(),
        endAt: new Date(Date.now() + 86_400_000),
        quotaAmount: '100',
        quantity: 1,
        price: '10',
        status: 0,
      })
      .returning({ id: userSubscriptions.id });
    subscriptionId = sub!.id;
    planId = plan!.id;
  }
  const [k] = await db
    .insert(apiKeys)
    .values({
      keyHash: randomUUID().replace(/-/g, '').repeat(2),
      keyPreview: `p1api-${suffix}`.slice(0, 40),
      userId: me!.id,
      name: `p1api-key-${suffix}`.slice(0, 64),
      subscriptionId,
      status: 0,
    })
    .returning({ id: apiKeys.id });
  return {
    userId: me!.id,
    keyId: k!.id,
    subscriptionId,
    cleanup: async () => {
      await db.delete(apiKeys).where(eq(apiKeys.userId, me!.id));
      if (subscriptionId != null) {
        await db.delete(userSubscriptions).where(eq(userSubscriptions.id, subscriptionId));
      }
      if (planId != null) {
        await db.delete(plans).where(eq(plans.id, planId));
      }
      await db.delete(users).where(eq(users.id, me!.id));
    },
  };
}

describe('Key 轮换计费来源重校验（L1）', () => {
  it('旧 Key 绑定的订阅已过期 → 轮换产出的新 Key 降级为个人余额（subscriptionId=null）', async () => {
    if (!dbOk) return it.skip('no DB');
    const suffix = `rot${Date.now()}`;
    const fx = await setupUserWithKey(suffix, true);
    const app = makeClientTestApp(fx.userId, { '/keys': keyRoutes(makeServices(db)) });
    try {
      // 订阅在旧 Key 创建后失效（到期）
      await db
        .update(userSubscriptions)
        .set({ endAt: new Date(Date.now() - 1_000) })
        .where(eq(userSubscriptions.id, fx.subscriptionId!));

      const res = await app.request(`/api/keys/${fx.keyId}/rotate`, { method: 'POST' });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: number; subscriptionId: number | null; key: string };
      // 响应必须体现降级：不再挂失效订阅
      expect(body.subscriptionId).toBeNull();
      // 落库一致：新 Key 行 subscriptionId 为空，旧 Key 已吊销
      const newKey = await db.query.apiKeys.findFirst({ where: eq(apiKeys.id, body.id) });
      expect(newKey?.subscriptionId).toBeNull();
      expect(newKey?.status).toBe(0);
      const oldKey = await db.query.apiKeys.findFirst({ where: eq(apiKeys.id, fx.keyId) });
      expect(oldKey?.status).toBe(1);
    } finally {
      await fx.cleanup();
    }
  });

  it('订阅仍有效 → 轮换沿用计费来源（回归）', async () => {
    if (!dbOk) return it.skip('no DB');
    const suffix = `rok${Date.now()}`;
    const fx = await setupUserWithKey(suffix, true);
    const app = makeClientTestApp(fx.userId, { '/keys': keyRoutes(makeServices(db)) });
    try {
      const res = await app.request(`/api/keys/${fx.keyId}/rotate`, { method: 'POST' });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: number; subscriptionId: number | null };
      expect(body.subscriptionId).toBe(fx.subscriptionId);
    } finally {
      await fx.cleanup();
    }
  });

  it('无订阅的旧 Key → 轮换仍为个人余额（回归）', async () => {
    if (!dbOk) return it.skip('no DB');
    const suffix = `rno${Date.now()}`;
    const fx = await setupUserWithKey(suffix, false);
    const app = makeClientTestApp(fx.userId, { '/keys': keyRoutes(makeServices(db)) });
    try {
      const res = await app.request(`/api/keys/${fx.keyId}/rotate`, { method: 'POST' });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { subscriptionId: number | null };
      expect(body.subscriptionId).toBeNull();
    } finally {
      await fx.cleanup();
    }
  });
});

describe('PATCH 限流后清网关鉴权缓存（L3）', () => {
  it('改 rpmLimit → auth:key:{hash} 缓存被清除（立即生效，不等 60s TTL）', async () => {
    if (!dbOk || !redisOk) return it.skip('no DB/Redis');
    const suffix = `pch${Date.now()}`;
    const fx = await setupUserWithKey(suffix, false);
    const app = makeClientTestApp(fx.userId, {
      '/keys': keyRoutes(makeServices(db, { redis })),
    });
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, fx.keyId));
    const cacheKey = authKeyCache(row!.keyHash);
    try {
      // 预置网关鉴权快照（模拟网关已缓存旧限流）
      await redis.set(cacheKey, 'stale-snapshot');
      expect(await redis.get(cacheKey)).toBe('stale-snapshot');

      const res = await app.request(`/api/keys/${fx.keyId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rpmLimit: 5 }),
      });
      expect(res.status).toBe(200);
      // 回显不泄漏 hash
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.keyHash).toBeUndefined();
      // 缓存必须已被清除
      expect(await redis.get(cacheKey)).toBeNull();
    } finally {
      await redis.del(cacheKey).catch(() => {});
      await fx.cleanup();
    }
  });

  it('改 dailySpendLimit → 同样清缓存；纯改名不清缓存', async () => {
    if (!dbOk || !redisOk) return it.skip('no DB/Redis');
    const suffix = `pcd${Date.now()}`;
    const fx = await setupUserWithKey(suffix, false);
    const app = makeClientTestApp(fx.userId, {
      '/keys': keyRoutes(makeServices(db, { redis })),
    });
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, fx.keyId));
    const cacheKey = authKeyCache(row!.keyHash);
    try {
      await redis.set(cacheKey, 'stale-snapshot');
      const res = await app.request(`/api/keys/${fx.keyId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dailySpendLimit: 10 }),
      });
      expect(res.status).toBe(200);
      expect(await redis.get(cacheKey)).toBeNull();

      // 纯改名（不动限流字段）不触碰鉴权缓存
      await redis.set(cacheKey, 'fresh-snapshot');
      const rename = await app.request(`/api/keys/${fx.keyId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `p1api-renamed-${suffix}`.slice(0, 64) }),
      });
      expect(rename.status).toBe(200);
      expect(await redis.get(cacheKey)).toBe('fresh-snapshot');
    } finally {
      await redis.del(cacheKey).catch(() => {});
      await fx.cleanup();
    }
  });
});
