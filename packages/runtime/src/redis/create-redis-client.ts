/**
 * Redis 客户端工厂：连接目标由 resolve-redis-connection 解析，本层只叠加
 * 请求热路快速失败与去重降级日志。各消费方自行决定 fail-open/fail-closed。
 */
import { Redis } from 'ioredis';
import { describeError, sanitizeUrl } from './redis-diagnostics';
import { resolveRedisConnection, type SentinelTopology } from './resolve-redis-connection';

export type RedisClientOptions = {
  /** 日志前缀（服务名） */
  serviceName: string;
  /** 重复错误日志的最小间隔（ms）——必填注入。 */
  logThrottleMs: number;
  /** 降级日志出口；注入以统一日志面与可测性。 */
  log?: (message: string) => void;
} & SentinelTopology;

export function createRedisClient(url: string, options: RedisClientOptions): Redis {
  // 单条命令快速失败，避免 Redis 不可达时积压业务请求。
  const commandOptions = { maxRetriesPerRequest: 1, enableOfflineQueue: false } as const;
  const target = resolveRedisConnection(url, options);
  const redis =
    target.kind === 'direct'
      ? new Redis(target.url, commandOptions)
      : new Redis({ ...target.options, ...commandOptions });
  const log = options.log ?? ((message: string) => console.error(message));
  let lastLoggedAt = 0;
  redis.on('error', (err: Error) => {
    const now = Date.now();
    if (now - lastLoggedAt < options.logThrottleMs) return;
    lastLoggedAt = now;
    log(
      `[${options.serviceName}] Redis 不可达（${sanitizeUrl(url)}）：${describeError(err)}——持续重试中；` +
        '限流 fail-open 降级、爆破防护 degraded（本地粗限）、免费模型日限 fail-closed（503）',
    );
  });
  return redis;
}
