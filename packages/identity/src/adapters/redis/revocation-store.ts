/**
 * jti 黑名单 Redis 实现:SETEX 存活至令牌自然过期(无需 GC)。
 * 故障口径(B06 统一):isRevoked 读失败 fail-open + warn(吊销是增强层,主防线是
 * 属主回查与锚点线);revoke 写失败原样上抛(调用方映射 unavailable,幂等重试)。
 * redis 参数为结构化最小接口(不编译依赖 ioredis)。
 */
import type { LoggerLike } from '../../ports/logger.js';
import type { SessionRevocationStore } from '../../ports/session-revocation-store.js';

export interface RedisStringClient {
  set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

export function createRedisSessionRevocationStore(
  redis: RedisStringClient,
  options: { logger: LoggerLike; prefix?: string },
): SessionRevocationStore {
  const prefix = options.prefix ?? 'session:rev';
  return {
    async revoke(jti, remainingTtlSec) {
      // 剩余 ≤0 的令牌本就过期——无需落键
      if (remainingTtlSec > 0) await redis.set(`${prefix}:${jti}`, '1', 'EX', remainingTtlSec);
    },
    async isRevoked(jti) {
      try {
        return (await redis.get(`${prefix}:${jti}`)) != null;
      } catch (error) {
        options.logger.warn(
          { err: (error as Error).message, jti },
          'session revocation lookup failed (fail-open; owner checks and anchor line remain authoritative)',
        );
        return false;
      }
    },
  };
}
