/**
 * 鉴权爆破防护双件（真实 Redis 段 + degraded/closed/open 三档故障语义）。
 * 行为规格 = v1 gateway app.test「JWT 伪造计数→锁定」/ production-hardening 爆破两层的机制段。
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { isInfrastructureError } from '@tokenlens/errors';
import {
  createAuthFailureGuard,
  createKeyBruteForceGuard,
  authGuardUnavailable,
} from '../src/redis/auth-guards';
import { createLocalAuthFailureGuard, createLocalKeyBruteForceGuard } from '../src/redis/auth-local-guard';
import { connectTestRedis, disconnectTestRedis, testRedisUrl } from '../src/testing';

const url = testRedisUrl();

describe.skipIf(url == null)('爆破防护（真实 Redis）', () => {
  let redis: Redis | null = null;

  beforeAll(async () => {
    redis = await connectTestRedis();
  });
  afterAll(() => disconnectTestRedis(redis));

  it('keyGuard：窗口内失败达阈值即锁、成功清零', async () => {
    const guard = createKeyBruteForceGuard(redis!, {
      failureThreshold: 3,
      failureWindowS: 60,
      lockS: 60,
    });
    const dim = `it-key-${Date.now()}`;
    expect((await guard.isLocked(dim)).locked).toBe(false);
    await guard.recordFailure(dim);
    await guard.recordFailure(dim);
    expect((await guard.isLocked(dim)).locked).toBe(false);
    const locked = await guard.recordFailure(dim); // 第 3 次 → 锁
    expect(locked.locked).toBe(true);
    expect((await guard.isLocked(dim)).locked).toBe(true);
    await guard.recordSuccess(dim); // 成功清零
    expect((await guard.isLocked(dim)).locked).toBe(false);
  });

  it('ipGuard：失败达 limit 即锁（锁长=窗口长）、recordSuccess 清零', async () => {
    const guard = createAuthFailureGuard(redis!, { limit: 2, windowS: 60 });
    const ip = `10.0.0.${(Date.now() % 250) + 1}`;
    await guard.recordFailure(ip);
    const locked = await guard.recordFailure(ip);
    expect(locked.locked).toBe(true);
    expect((await guard.isLocked(ip)).locked).toBe(true);
    await guard.recordSuccess?.(ip);
    expect((await guard.isLocked(ip)).locked).toBe(false);
  });
});

/** 预期不可达实例（错误事件静默——连接失败是测试路径，不泄漏 unhandled 噪声） */
function deadRedis(): Redis {
  const redis = new Redis('redis://127.0.0.1:1', { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  redis.on('error', () => {});
  return redis;
}

describe('爆破防护故障三档', () => {

  it('degraded（默认）：存储不可用降级本地粗限，不 503', async () => {
    const guard = createKeyBruteForceGuard(deadRedis(), {
      failureThreshold: 2,
      failureWindowS: 60,
      lockS: 60,
    });
    const dim = `degraded-${Date.now()}`;
    await guard.recordFailure(dim);
    const locked = await guard.recordFailure(dim);
    expect(locked.locked).toBe(true); // 本地降级体承接同语义
  });

  it('closed：存储不可用抛 runtime.auth_guard_unavailable（503 语义）', async () => {
    const guard = createKeyBruteForceGuard(
      deadRedis(),
      { failureThreshold: 2, failureWindowS: 60, lockS: 60 },
      { failMode: 'closed' },
    );
    const err = await guard.isLocked('x').then(() => null, (e: Error) => e);
    expect(isInfrastructureError(err), String(err)).toBe(true);
    expect((err as { code: string }).code).toBe('runtime.auth_guard_unavailable');
  });

  it('open：存储不可用放行', async () => {
    const guard = createAuthFailureGuard(deadRedis(), { limit: 2, windowS: 60 }, { failMode: 'open' });
    await expect(guard.isLocked('1.2.3.4')).resolves.toMatchObject({ locked: false });
  });

  it('authGuardUnavailable 工厂：英文 message + 身份码', () => {
    const err = authGuardUnavailable('x');
    expect(err.code).toBe('runtime.auth_guard_unavailable');
    expect(err.message).toContain('auth guard storage unavailable');
  });
});

describe('本地降级体（纯内存语义）', () => {
  it('key 维：阈值锁 + 锁内重计 + 成功清零', async () => {
    const guard = createLocalKeyBruteForceGuard({ failureThreshold: 2, failureWindowS: 60, lockS: 1 });
    await guard.recordFailure('k');
    const locked = await guard.recordFailure('k');
    expect(locked.locked).toBe(true);
    await guard.recordSuccess('k');
    expect((await guard.isLocked('k')).locked).toBe(false);
  });

  it('ip 维：阈值锁（锁长=窗口长）', async () => {
    const guard = createLocalAuthFailureGuard(2, 60);
    await guard.recordFailure('1.1.1.1');
    expect((await guard.recordFailure('1.1.1.1')).locked).toBe(true);
  });

  it('容量保护：maxEntries 上限整表重计（防维度空间撑内存）', async () => {
    const guard = createLocalKeyBruteForceGuard({ failureThreshold: 5, failureWindowS: 60, lockS: 60 });
    await guard.recordFailure('seed');
    // 不直接触达内部表——通过大量新维度触发整表重置后 seed 计数归零
    for (let i = 0; i < 100_001; i++) await guard.recordFailure(`dim-${i}`);
    const seeded = await guard.isLocked('seed');
    expect(seeded.locked).toBe(false); // seed 计数已随整表丢弃
  });
});
