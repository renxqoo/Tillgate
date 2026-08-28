/**
 * @tillgate/runtime 公共面：仅服务端运行时基础设施（config / logging / crypto /
 * redis / lifecycle）。测试装置走子入口 `@tillgate/runtime/testing`，不进生产面。
 */
export { strictBooleanSchema, secretSchema } from './config/env-schemas';
export { createCipher, type Cipher } from './crypto/cipher';
export { createShutdown, type ShutdownDeps, type ShutdownLog } from './lifecycle/shutdown';
export { createLogger, type CreateLoggerOptions, type Logger } from './logging/logger';
export { parseSentinels } from './redis/parse-sentinels';
export {
  resolveRedisConnection,
  type RedisConnectionTarget,
  type SentinelTopology,
} from './redis/resolve-redis-connection';
export { createRedisClient, type RedisClientOptions } from './redis/create-redis-client';
export { assertRedisReachable } from './redis/assert-redis-reachable';
export { createRedisScriptRunner, type RedisScriptRunner } from './redis/script-runner';
export {
  createSlidingWindowLimiter,
  rateLimitUnavailable,
  type SlidingWindowLimiter,
  type SlidingWindowLimiterOptions,
  type RateLimitResult,
} from './redis/rate-limiter';
export {
  createKeyBruteForceGuard,
  createAuthFailureGuard,
  authGuardUnavailable,
  type KeyBruteForceGuard,
  type AuthFailureGuard,
  type BruteForcePolicy,
  type AuthFailurePolicy,
  type GuardCheck,
  type GuardFailMode,
  type GuardFailureMode,
} from './redis/auth-guards';
