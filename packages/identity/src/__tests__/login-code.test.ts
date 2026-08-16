import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { loadRootEnvFile } from '@ai-gateway/http';

import {
  issueLoginCodeChallenge,
  verifyLoginCodeChallenge,
  LoginCodeCooldownError,
  LOGIN_CODE_TTL_S,
  LOGIN_CODE_MAX_TRIES,
  LOGIN_CODE_RESEND_COOLDOWN_S,
} from '../login-code.js';

/**
 * 登录验证码挑战（client-api 强制 / admin-api 2FA 共用，从 admin-auth 抽取下沉）：
 *   - 发送冷却：同一主体 60s 内只发一条（防邮件轰炸）
 *   - challenge 5 分钟有效；错 5 次作废（第 5 次错误即作废，作废后正确码也失败）
 *   - 验证成功一次性消费（防重放）；namespace 隔离 admin/user
 * 需要真实 Redis（incr/expire/hset/hincrby 语义）。
 */

loadRootEnvFile();

const redis = new Redis(process.env.REDIS_URL ?? 'redis://:root123@localhost:6379', {
  retryStrategy: () => null,
  lazyConnect: true,
  maxRetriesPerRequest: null,
});

let connected = false;
beforeAll(async () => {
  try {
    await redis.connect();
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => {
  await redis.quit().catch(() => {});
});

/** 只删自己创建的键：冷却键（可由 subjectId 推导）+ 显式记录的 challenge 键 */
async function cleanup(subjectIds: string[], challengeKeys: string[]): Promise<void> {
  const keys = [
    ...subjectIds.map((s) => `logincode:cool:user:${s}`),
    ...subjectIds.map((s) => `logincode:cool:admin:${s}`),
    ...challengeKeys,
  ];
  if (keys.length > 0) await redis.del(...keys).catch(() => {});
}

describe('identity login-code — 挑战签发/验证/防刷', () => {
  it('发送冷却：60s 内第二次签发被拒', async () => {
    if (!connected) return it.skip('no Redis');
    const subject = `lc-cool-${Date.now()}`;
    try {
      const id = await issueLoginCodeChallenge(redis, 'user', subject, '123456');
      expect(id).toBeTypeOf('string');
      await expect(issueLoginCodeChallenge(redis, 'user', subject, '123456')).rejects.toBeInstanceOf(
        LoginCodeCooldownError,
      );
    } finally {
      await cleanup([subject], []);
    }
  });

  it('错误码计次：第 5 次错误作废，作废后正确码也失败', async () => {
    if (!connected) return it.skip('no Redis');
    const subject = `lc-tries-${Date.now()}`;
    const challengeKeys: string[] = [];
    try {
      const challengeId = await issueLoginCodeChallenge(redis, 'user', subject, '654321');
      challengeKeys.push(`logincode:user:challenge:${challengeId}`);

      // 前 4 次错：CODE_INVALID
      for (let i = 0; i < LOGIN_CODE_MAX_TRIES - 1; i++) {
        const r = await verifyLoginCodeChallenge(redis, 'user', challengeId, '000000');
        expect(r.ok).toBe(false);
        expect(!r.ok && r.reason).toBe('CODE_INVALID');
      }
      // 第 5 次错：作废
      const last = await verifyLoginCodeChallenge(redis, 'user', challengeId, '000000');
      expect(!last.ok && last.reason).toBe('CHALLENGE_EXHAUSTED');

      // 作废后正确码也失败
      const gone = await verifyLoginCodeChallenge(redis, 'user', challengeId, '654321');
      expect(!gone.ok && gone.reason).toBe('CHALLENGE_INVALID');

      // 不存在的挑战
      const none = await verifyLoginCodeChallenge(
        redis,
        'user',
        '00000000-0000-4000-8000-000000000000',
        '654321',
      );
      expect(!none.ok && none.reason).toBe('CHALLENGE_INVALID');
    } finally {
      await cleanup([subject], challengeKeys);
    }
  });

  it('验证成功一次性消费（防重放）；namespace 隔离 admin/user', async () => {
    if (!connected) return it.skip('no Redis');
    const subject = `lc-ns-${Date.now()}`;
    const challengeKeys: string[] = [];
    try {
      const challengeId = await issueLoginCodeChallenge(redis, 'user', subject, '111222');
      challengeKeys.push(`logincode:user:challenge:${challengeId}`);

      const ok = await verifyLoginCodeChallenge(redis, 'user', challengeId, '111222');
      expect(ok.ok).toBe(true);
      if (ok.ok) expect(ok.subjectId).toBe(subject);

      // 已消费的挑战不能复用
      const replay = await verifyLoginCodeChallenge(redis, 'user', challengeId, '111222');
      expect(replay.ok).toBe(false);

      // admin namespace 看不到 user 的挑战（同 subjectId 双 namespace 并存也不串）
      const adminChallenge = await issueLoginCodeChallenge(redis, 'admin', subject, '333444');
      challengeKeys.push(`logincode:admin:challenge:${adminChallenge}`);
      const cross = await verifyLoginCodeChallenge(redis, 'user', adminChallenge, '333444');
      expect(!cross.ok && cross.reason).toBe('CHALLENGE_INVALID');
    } finally {
      await cleanup([subject], challengeKeys);
    }
  });

  it('常量口径：5 分钟有效 / 5 次机会 / 60s 冷却', () => {
    expect(LOGIN_CODE_TTL_S).toBe(300);
    expect(LOGIN_CODE_MAX_TRIES).toBe(5);
    expect(LOGIN_CODE_RESEND_COOLDOWN_S).toBe(60);
  });

  it('extra 字段随挑战存储，验证成功时原样返回（注册场景：暂存 email+密码哈希）', async () => {
    if (!connected) return it.skip('no Redis');
    const subject = `lc-extra-${Date.now()}`;
    const challengeKeys: string[] = [];
    try {
      const challengeId = await issueLoginCodeChallenge(redis, 'user', subject, '246810', {
        pendingEmail: 'someone@test.local',
        pendingPasswordHash: 'scrypt:32768:8:1:aa:bb',
      });
      challengeKeys.push(`logincode:user:challenge:${challengeId}`);

      const ok = await verifyLoginCodeChallenge(redis, 'user', challengeId, '246810');
      expect(ok.ok).toBe(true);
      if (ok.ok) {
        expect(ok.subjectId).toBe(subject);
        expect(ok.data?.pendingEmail).toBe('someone@test.local');
        expect(ok.data?.pendingPasswordHash).toBe('scrypt:32768:8:1:aa:bb');
      }
    } finally {
      await cleanup([subject], challengeKeys);
    }
  });
});
