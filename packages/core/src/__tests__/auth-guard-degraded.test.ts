/**
 * 爆破防护故障档位测试（不依赖真 Redis——用恒抛错的替身模拟存储不可用）：
 *   degraded（默认）：降质为本地内存粗限——阈值内放行、达阈值锁定、成功清零
 *   closed：抛 AuthGuardUnavailableError（调用方 503）
 *   open：吞错放行（仅失去防护）
 */
import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import {
  AuthGuardUnavailableError,
  createAuthFailureGuard,
  createKeyBruteForceGuard,
} from '../redis/auth-guards.js';

/** 恒抛错的 Redis 替身（每条命令都模拟存储不可达） */
/** 恒抛错的命令桩（模块级：不随调用重建） */
const deadCommand = () => {
  throw new Error('ECONNREFUSED (simulated)');
};

function deadRedis(): Redis {
  return { ttl: deadCommand, get: deadCommand, incr: deadCommand, expire: deadCommand, set: deadCommand, del: deadCommand } as unknown as Redis;
}

const keyPolicy = { failureThreshold: 3, failureWindowS: 60, lockS: 300 };

describe('KeyBruteForceGuard 故障档位', () => {
  it('degraded（默认）：Redis 挂 → 本地粗限生效，登录可用且达阈值锁定', async () => {
    const guard = createKeyBruteForceGuard(deadRedis(), keyPolicy);
    // 阈值内失败：不锁（登录面保住——降质换可用）
    expect((await guard.recordFailure('k1')).locked).toBe(false);
    expect((await guard.recordFailure('k1')).locked).toBe(false);
    // 达阈值：锁定（粗限仍能截获持续爆破）
    const third = await guard.recordFailure('k1');
    expect(third.locked).toBe(true);
    expect((await guard.isLocked('k1')).locked).toBe(true);
    // 成功清零（降级体同样清——正确密码不被连坐）
    await guard.recordSuccess('k1');
    expect((await guard.isLocked('k1')).locked).toBe(false);
  });

  it('closed：抛 AuthGuardUnavailableError（防护绝对优先）', async () => {
    const guard = createKeyBruteForceGuard(deadRedis(), keyPolicy, { failMode: 'closed' });
    await expect(guard.isLocked('k1')).rejects.toBeInstanceOf(AuthGuardUnavailableError);
  });

  it('open：吞错放行（仅失去防护）', async () => {
    const guard = createKeyBruteForceGuard(deadRedis(), keyPolicy, { failMode: 'open' });
    expect((await guard.recordFailure('k1')).locked).toBe(false);
    expect((await guard.isLocked('k1')).locked).toBe(false);
  });
});

describe('AuthFailureGuard 故障档位（IP 维）', () => {
  it('degraded：本地粗限 + 成功清零', async () => {
    const guard = createAuthFailureGuard(deadRedis(), { limit: 2, windowS: 60 });
    expect((await guard.recordFailure('1.2.3.4')).locked).toBe(false);
    expect((await guard.recordFailure('1.2.3.4')).locked).toBe(true);
    expect((await guard.isLocked('1.2.3.4')).locked).toBe(true);
    await guard.recordSuccess?.('1.2.3.4');
    expect((await guard.isLocked('1.2.3.4')).locked).toBe(false);
  });

  it('closed：抛错', async () => {
    const guard = createAuthFailureGuard(
      deadRedis(),
      { limit: 2, windowS: 60 },
      { failMode: 'closed' },
    );
    await expect(guard.isLocked('1.2.3.4')).rejects.toBeInstanceOf(AuthGuardUnavailableError);
  });
});
