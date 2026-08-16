import { afterAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { createRateLimiter } from '../rate-limit-service.js';
import { createRedisKvStorage } from '../../../infrastructure/ai-storage.js';
import {
  checkBruteForce,
  createRedisBruteForceStorage,
} from '../../../middleware/brute-force-guard.js';
import { checkFreeDailyLimit } from '../../pipeline/steps/rate-limit.js';
import { loadGatewayEnv, createLogger } from '@ai-gateway/core';
import { loadEnvFileIntoProcess, ensureTestSecrets } from '../../../testing/helpers.js';
import type { PipelineDeps } from '../../pipeline/types.js';

loadEnvFileIntoProcess();
ensureTestSecrets();

/**
 * 审计 P0-2：文档多处声明付费链路限流「fail-open、资金由 DB 硬闸门兜底」
 * （rate-guards.ts / key-auth-cache.ts 注释），但 RateLimiter 全文件 0 个
 * catch、brute-force-guard 与 ai-storage 同样裸抛——Redis 一抖 /v1/* 与
 * 鉴权全量 500。实现必须与声明的单一真相一致：
 *   - 付费链路限流（RPM/TPM）→ fail-open（DB 硬闸门兜底资金）
 *   - 免费模型日计数 → fail-closed（保持不变，F7 唯一防线）
 *   - 熔断/死凭据状态读取 → 视为未知状态（放行，计数走内存降级）
 *   - 防爆破计数 → fail-open（防枚举是尽力而为，不得拖垮登录/鉴权）
 */
function brokenRedis(): Redis {
  return new Redis({
    host: '127.0.0.1',
    port: 6390, // 无人监听：offline queue 关闭 → 命令立即拒绝
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 300,
    retryStrategy: () => null,
  });
}

const redis = brokenRedis();
afterAll(async () => {
  redis.disconnect();
});

describe('P0-2 — Redis 故障降级', () => {
  it('checkAll 存储故障 → fail-open 放行', async () => {
    const limiter = createRateLimiter(redis);
    const result = await limiter.checkAll([{ dimension: 'global', max: 100 }], 'p02-req');
    expect(result.allowed).toBe(true);
  });

  it('reserveTpmAll 存储故障 → fail-open 放行', async () => {
    const limiter = createRateLimiter(redis);
    const result = await limiter.reserveTpmAll(
      [{ dimension: 'user:1:model:1', estimatedTokens: 100, max: 1000 }],
      'p02-req',
    );
    expect(result.allowed).toBe(true);
  });

  it('releaseTpm 存储故障 → 不抛（best-effort）', async () => {
    const limiter = createRateLimiter(redis);
    await expect(limiter.releaseTpm('p02-req')).resolves.toBeUndefined();
  });

  it('免费模型日计数保持 fail-closed（语义不回退）', async () => {
    const env = loadGatewayEnv();
    const deps = {
      redis,
      env,
      logger: createLogger({ level: 'silent' }),
    } as unknown as PipelineDeps;
    const result = await checkFreeDailyLimit(deps, 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('free_model_counter_unavailable');
  });

  it('熔断/死凭据状态读取故障 → 返回未知状态（null），不抛', async () => {
    const storage = createRedisKvStorage(redis, 'ai:breaker:');
    await expect(storage.getState('p02-channel')).resolves.toBeNull();
  });

  it('防爆破检查故障 → fail-open 不锁定、不抛', async () => {
    const storage = createRedisBruteForceStorage(redis);
    const result = await checkBruteForce(storage, 'p02-keyhash');
    expect(result.locked).toBe(false);
  });
});
