/**
 * 终审加固测试（2026-08-20 删 v1 前最后一轮）：
 *   ① 限流并罚语义：凭证维与用户维各自生效（DEFAULT_USER_* 兜底已删——未设置=不限）
 *   ② playground JWT 属主状态核验（封禁用户的存量 JWT 不得在 TTL 窗口内放行）
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { SignJWT } from 'jose';
import { users } from '@ai-gateway/db';
import { createDb } from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import { createApp } from '../app.js';

const JWT_SECRET = 'final-hardening-secret-0123456789';
const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const createdUsers: number[] = [];

afterAll(async () => {
  if (createdUsers.length) await db.delete(users).where(eq(users.id, createdUsers[0]!)).catch(() => {});
  await db.$client.end().catch(() => {});
});

describe('① 限流并罚制（凭证维与用户维各自生效）', () => {
  it('高限额凭证 + 低用户帽 → 用户帽维度拒绝（旧择优制会放行）', async () => {
    // 并罚语义钉死：两维一起判定，任一超限即拒——高限额 Key 不得越过用户帽
    // （实现走 limiter.checkAll 原子多维；此处经真 limiter 验证行为）
    const { createRedisClient, createSlidingWindowLimiter, waitForRedisReady } = await import('@ai-gateway/core');
    const redis = createRedisClient(process.env.REDIS_URL ?? 'redis://localhost:6379', { serviceName: 'final-test' });
    await waitForRedisReady(redis);
    const limiter = createSlidingWindowLimiter(redis, { failMode: 'open' });
    const tag = Math.floor(Math.random() * 1e9);
    // 用户帽 2：第 3 次被用户维拒绝——即便凭证维限额 1000
    const r1 = await limiter.checkAll([
      { dimension: `key:${tag}`, max: 1000 },
      { dimension: `user:${tag}`, max: 2 },
    ], `req-${tag}-1`);
    const r2 = await limiter.checkAll([
      { dimension: `key:${tag}`, max: 1000 },
      { dimension: `user:${tag}`, max: 2 },
    ], `req-${tag}-2`);
    const r3 = await limiter.checkAll([
      { dimension: `key:${tag}`, max: 1000 },
      { dimension: `user:${tag}`, max: 2 },
    ], `req-${tag}-3`);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(false); // 用户帽生效（择优制此处会放行）
    expect(r3.dimension).toBe(`user:${tag}`);
    await redis.quit().catch(() => {});
  }, 30_000);
});

describe('② playground JWT 退役锁（BYOK 改造 2026-08-21）', () => {
  it('签名完全合法的 playground 形态 JWT → 401（形态已删，防误恢复）', async () => {
    const [user] = await db
      .insert(users)
      .values({ issuer: 'fh', subject: `fh-${randomUUID().slice(0, 8)}`, identityProvider: 'local' })
      .returning({ id: users.id });
    createdUsers.push(user!.id);

    const token = await new SignJWT({ sub: String(user!.id), typ: 'playground', scope: { rpm: 10, tpm: 200000 } })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('ai-gateway')
      .setAudience('ai-gateway-api')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(JWT_SECRET));

    const app = createApp({ db, oauth: { jwtSecret: JWT_SECRET, tokenTtlSeconds: 3_600 } });

    // 操练场改为用户自持 API Key 直连（client-api 不再持有网关签名密钥）——
    // 即使签名合法，playground 形态一律 401：不存在的凭证形态必须被拒绝
    const res = await app.request('/v1/models', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  }, 30_000);
});
