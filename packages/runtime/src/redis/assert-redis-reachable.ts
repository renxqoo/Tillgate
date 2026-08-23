/**
 * 启动期连通性验证（Redis 是首选组件：连不上 = 拒绝启动）——拆分自 v2 原 redis-client.ts
 * （一动词一文件，铁律 5）。timeoutMs 必填注入（铁律 3：5s 不做藏默认）。
 *
 * 冷连接友好：客户端关闭了 offline queue（连接就绪前的命令立即拒绝），
 * 因此用「重试直至截止」而非单发 ping；超时报错带脱敏 URL 便于直接排查。
 */
import { Redis } from 'ioredis';
import { InfrastructureError } from '@tokenlens/errors';
import { describeError, sanitizeUrl } from './redis-diagnostics';

export async function assertRedisReachable(
  redis: Redis,
  serviceName: string,
  rawUrl: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | null = null;
  for (;;) {
    try {
      if ((await redis.ping()) === 'PONG') return;
    } catch (err) {
      lastError = err as Error;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new InfrastructureError(
    `[${serviceName}] Redis startup check failed (${sanitizeUrl(rawUrl)}): ${describeError(lastError ?? new Error(`ping timeout (${timeoutMs}ms)`))} — ` +
      'Redis is a required component, refusing to start in degraded mode (check REDIS_URL and the Redis instance)',
    'runtime.redis.unreachable',
    { serviceName, url: sanitizeUrl(rawUrl) },
    { cause: lastError ?? undefined },
  );
}
