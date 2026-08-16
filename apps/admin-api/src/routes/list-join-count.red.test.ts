import { beforeAll, describe, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createDb, type Db } from '@ai-gateway/db';
import {
  admins,
  apiKeys,
  channelRecharges,
  channels,
  plans,
  providers,
  userSubscriptions,
  users,
} from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { keyAdminRoutes } from './keys.js';
import { channelFundsRoutes } from './channel-funds.js';
import { subscriptionAdminRoutes } from './subscriptions.js';
import { makeAdminTestApp, makeServices } from '../test/helpers.js';

/**
 * 红测（复审 #1）：keys / channel-funds / subscriptions 三个列表的搜索目标列在
 * JOIN 表上（users.email / channels.name / plans.name），但计数走单表 countAll →
 * where 引用不到 join 表列 → PG 42P01 → 500。用户可达：前端 rate-limits 页把
 * q 直传 /api/admin/keys。修复后带 q 必须 200 且 total 正确。
 * 数据纪律：前缀 lqjc-，清理只删自己建的行。
 */

loadRootEnvFile();

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
);
let connected = false;
beforeAll(async () => {
  try {
    await db.select({ id: users.id }).from(users).limit(1);
    connected = true;
  } catch {
    connected = false;
  }
});

const PREFIX = 'lqjc';

describe('列表搜索 × join 计数（红测 #1）', () => {
  it('keys/channel-funds/subscriptions 带 q → 200（不再 500）', async (context) => {
    if (!connected) return context.skip();
    const tag = `${PREFIX}-${randomUUID().slice(0, 8)}`;
    const [admin] = await db
      .insert(admins)
      .values({ email: `${tag}-admin@test.local`, passwordHash: 'x' })
      .returning({ id: admins.id });
    const [user] = await db
      .insert(users)
      .values({
        issuer: 'test',
        subject: randomUUID(),
        identityProvider: 'local',
        email: `${tag}-user@test.local`,
        passwordHash: 'x',
        status: 0,
      })
      .returning({ id: users.id });
    const [provider] = await db
      .insert(providers)
      .values({ name: `${tag}-prov`, baseUrl: 'https://jc.test' })
      .returning({ id: providers.id });
    const [channel] = await db
      .insert(channels)
      .values({
        providerId: provider!.id,
        name: `${tag}-chan`,
        apiKeyEnc: 'enc',
        upstreamBudget: '0',
      })
      .returning({ id: channels.id });
    const [plan] = await db
      .insert(plans)
      .values({
        name: `${tag}-plan`,
        kind: 'subscription',
        price: '10',
        periodDays: 30,
        quotaAmount: '100',
        sortOrder: 1,
        status: 0,
      })
      .returning({ id: plans.id });
    const [sub] = await db
      .insert(userSubscriptions)
      .values({
        userId: user!.id,
        planId: plan!.id,
        startAt: new Date(),
        endAt: new Date(Date.now() + 86_400_000),
        quotaAmount: '100',
        reservedAmount: '0',
        quantity: 1,
        price: '10',
        status: 0,
      })
      .returning({ id: userSubscriptions.id });
    const [key] = await db
      .insert(apiKeys)
      .values({
        keyHash: `${tag}-hash`,
        keyPreview: `${tag}…`,
        userId: user!.id,
        name: `${tag}-key`,
        status: 0,
      })
      .returning({ id: apiKeys.id });
    await db.insert(channelRecharges).values({
      channelId: channel!.id,
      type: 'recharge',
      amount: '1',
      balanceAfter: '1',
      adminId: admin!.id,
    });

    const services = makeServices(db);
    const app = makeAdminTestApp(
      {
        '/keys': keyAdminRoutes(services),
        '/channel-funds': channelFundsRoutes(services, 1024 * 1024),
        '/subscriptions': subscriptionAdminRoutes(services),
      },
      { adminId: admin!.id },
    );

    try {
      // keys：搜索目标 users.email（join 表）
      const keysRes = await app.request(`/api/admin/keys?q=${encodeURIComponent(tag)}`);
      expect(keysRes.status).toBe(200);
      const keysBody = (await keysRes.json()) as { total: number };
      expect(keysBody.total).toBe(1);

      // channel-funds：搜索目标 channels.name（join 表）
      const fundsRes = await app.request(`/api/admin/channel-funds?q=${encodeURIComponent(tag)}`);
      expect(fundsRes.status).toBe(200);
      const fundsBody = (await fundsRes.json()) as { total: number };
      expect(fundsBody.total).toBe(1);

      // subscriptions：搜索目标 users.subject / plans.name（join 表）
      const subsRes = await app.request(`/api/admin/subscriptions?q=${encodeURIComponent(tag)}`);
      expect(subsRes.status).toBe(200);
      const subsBody = (await subsRes.json()) as { total: number };
      expect(subsBody.total).toBe(1);
    } finally {
      await db.delete(channelRecharges).where(eq(channelRecharges.channelId, channel!.id));
      await db.delete(apiKeys).where(eq(apiKeys.id, key!.id));
      await db.delete(userSubscriptions).where(eq(userSubscriptions.id, sub!.id));
      await db.delete(plans).where(eq(plans.id, plan!.id));
      await db.delete(channels).where(like(channels.name, `${tag}%`));
      await db.delete(providers).where(eq(providers.id, provider!.id));
      await db.delete(users).where(eq(users.id, user!.id));
      await db.delete(admins).where(eq(admins.id, admin!.id));
    }
  });
});
