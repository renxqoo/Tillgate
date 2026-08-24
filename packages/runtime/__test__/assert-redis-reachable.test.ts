/** assertRedisReachable 单元测试（mock ping，无真实连接；真实 Redis 集成面在 redis-integration.test.ts）。 */
import { describe, expect, it } from 'vitest';
import { isInfrastructureError } from '@tillgate/errors';
import type { Redis } from 'ioredis';
import { assertRedisReachable } from '../src/redis/assert-redis-reachable';
import { defined } from './defined';

/** 最小假件：assertRedisReachable 只消费 ping()——契约面收窄，测试替身无需完整 Redis */
function fakeRedis(ping: () => Promise<string>): Redis {
  return { ping } as unknown as Redis;
}

describe('assertRedisReachable（timeoutMs 必填注入）', () => {
  it('可达实例（首 ping PONG）直接通过', async () => {
    let calls = 0;
    await expect(
      assertRedisReachable(
        fakeRedis(async () => (calls++, 'PONG')),
        'svc',
        'redis://h:6379',
        1_000,
      ),
    ).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  it('持续拒绝 → 超时上界内抛 InfrastructureError（服务名 + 脱敏 URL + cause 保留）', async () => {
    const pingErr = new Error('ECONNREFUSED synthetic');
    const err = await assertRedisReachable(
      fakeRedis(() => Promise.reject(pingErr)),
      'svc',
      'redis://:pass@127.0.0.1:1',
      50,
    ).then(
      () => null,
      (error: Error) => error,
    );
    expect(isInfrastructureError(err), String(err)).toBe(true);
    expect((err as { code: string }).code).toBe('runtime.redis.unreachable');
    expect(defined(err, 'err').message).toContain('svc');
    expect(defined(err, 'err').message).toContain('***@127.0.0.1:1'); // 凭证脱敏
    expect(defined(err, 'err').message).not.toContain(':pass@');
    expect((err as { cause?: unknown }).cause).toBe(pingErr);
  });

  it('ping 有响应但非 PONG（半开连接）→ 同样按超时抛错，描述走 ping timeout 文案', async () => {
    const err = await assertRedisReachable(
      fakeRedis(async () => 'NOT PONG'),
      'svc',
      'redis://127.0.0.1:6379',
      50,
    ).then(
      () => null,
      (error: Error) => error,
    );
    expect(isInfrastructureError(err), String(err)).toBe(true);
    expect(defined(err, 'err').message).toContain('ping timeout (50ms)'); // 无异常记录时的兜底描述
  });
});
