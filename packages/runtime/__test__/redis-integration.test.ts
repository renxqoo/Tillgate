/**
 * Redis 集成（真实实例；REDIS_URL 未配置时整套 skip——本地无 Redis 的开发环境
 * 不阻塞门禁，CI/生产形态必跑）。覆盖：脚本运行器真实自愈（SCRIPT FLUSH）、
 * 启动连通性验证（可达通过 / 不可达超时抛错含脱敏 URL）。
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { isInfrastructureError } from '@tillgate/errors';
import { assertRedisReachable, createRedisClient, createRedisScriptRunner } from '../src';
import { connectTestRedis, disconnectTestRedis, testRedisUrl } from '../src/testing';

const url = testRedisUrl();

describe.skipIf(url == null)('Redis 集成（真实实例）', () => {
  let redis: Redis | null = null;

  beforeAll(async () => {
    redis = await connectTestRedis();
  });
  afterAll(() => disconnectTestRedis(redis));

  it('script-runner：SCRIPT FLUSH 后 NOSCRIPT 自愈（官方恢复模式）', async () => {
    const runner = createRedisScriptRunner(redis!);
    expect(await runner.run('return 42', 0)).toBe(42);
    await redis!.script('FLUSH');
    expect(await runner.run('return 42', 0)).toBe(42); // 缓存消失后重载重试
  });

  it('assertRedisReachable：可达实例直接通过', async () => {
    await expect(assertRedisReachable(redis!, 'it-svc', url!, 5_000)).resolves.toBeUndefined();
  });

  it('assertRedisReachable：不可达端口在超时上界内抛错，信息含服务名与脱敏 URL', async () => {
    const dead = createRedisClient('redis://:pass@127.0.0.1:1', {
      serviceName: 'dead-svc',
      logThrottleMs: 30_000,
    });
    try {
      const err = await assertRedisReachable(dead, 'dead-svc', 'redis://:pass@127.0.0.1:1', 1_000)
        .then(() => null)
        .catch((e: Error) => e);
      expect(isInfrastructureError(err), String(err)).toBe(true); // §11 身份
      expect((err as { code: string }).code).toBe('runtime.redis.unreachable');
      expect(err!.message).toContain('dead-svc');
      expect(err!.message).toContain('Redis startup check failed');
      expect(err!.message).toContain('***@127.0.0.1:1'); // 脱敏后形态
      expect(err!.message).not.toContain(':pass@'); // 凭证不得泄漏
      // context 只进脱敏后的事实（凭证不得入记录）
      const ctx = (err as { context?: { url?: string } }).context;
      expect(ctx?.url).toBe('redis://:***@127.0.0.1:1'); // 非特殊 scheme 不补尾斜杠
    } finally {
      dead.disconnect();
    }
  });
});
