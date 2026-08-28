/**
 * 管理员邀请令牌/冷却 Redis 适配器单测(fake Redis——锁键形态、TTL、NX、
 * GETDEL 一次性语义与明文/哈希分离;真 Redis 行为由 e2e/admin 旅程全真验证)。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type Redis from 'ioredis';
import {
  ADMIN_INVITE_RESEND_COOLDOWN_S,
  ADMIN_INVITE_TOKEN_TTL_SECONDS,
  createRedisAdminInviteStore,
} from '../src/adapters/redis-admin-invite';

/** 最小 fake:记录 set 调用参数(NX 语义按键存在性模拟),getdel 模拟 Redis GETDEL */
function fakeRedis() {
  const store = new Map<string, string>();
  const sets: Array<{
    key: string;
    value: string;
    ttlSeconds?: number;
    nx: boolean;
  }> = [];
  const redis = {
    sets,
    async set(key: string, value: string, ...rest: unknown[]) {
      // 形态固定为 SET key val EX ttl [NX](调用方只按此形态调用)
      const ex = rest.indexOf('EX');
      const ttlSeconds = ex >= 0 ? Number(rest[ex + 1]) : undefined;
      const nx = rest.includes('NX');
      sets.push({ key, value, ttlSeconds, nx });
      if (nx && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async getdel(key: string) {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    },
  };
  return redis;
}

const sha = (token: string) => createHash('sha256').update(token).digest('hex');

describe('redis-admin-invite(令牌签发/消费 + 重发冷却)', () => {
  it('issue:32B base64url 明文仅本次返回,入库只存哈希键,TTL 30 分钟', async () => {
    const redis = fakeRedis();
    const store = createRedisAdminInviteStore(redis as unknown as Redis);
    const token = await store.issue(1_000_000_007);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(redis.sets).toEqual([
      {
        key: `admininvite:token:${sha(token)}`,
        value: '1000000007',
        ttlSeconds: ADMIN_INVITE_TOKEN_TTL_SECONDS,
        nx: false,
      },
    ]);
    expect(ADMIN_INVITE_TOKEN_TTL_SECONDS).toBe(1800);
  });

  it('consume:返回 adminId 且 GETDEL 原子单次——重放即 null;未知令牌 null', async () => {
    const redis = fakeRedis();
    const store = createRedisAdminInviteStore(redis as unknown as Redis);
    const token = await store.issue(42);
    await expect(store.consume(token)).resolves.toBe(42);
    await expect(store.consume(token)).resolves.toBeNull();
    await expect(store.consume('x'.repeat(43))).resolves.toBeNull();
  });

  it('tryStartCooldown:SET NX EX 60——首占成功,窗口内再占失败', async () => {
    const redis = fakeRedis();
    const store = createRedisAdminInviteStore(redis as unknown as Redis);
    await expect(store.tryStartCooldown(42)).resolves.toBe(true);
    await expect(store.tryStartCooldown(42)).resolves.toBe(false);
    const cooldown = redis.sets.find((s) => s.key === 'admininvite:cooldown:42');
    expect(cooldown).toMatchObject({
      ttlSeconds: ADMIN_INVITE_RESEND_COOLDOWN_S,
      nx: true,
    });
    expect(ADMIN_INVITE_RESEND_COOLDOWN_S).toBe(60);
  });
});
