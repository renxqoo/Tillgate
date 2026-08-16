import { afterAll, describe, expect, it } from 'vitest';
import type { PipelineDeps } from './pipeline-shared.js';
import { RateGuards } from './rate-guards.js';

/**
 * 红测（F7 + F8）：免费模型日计数。
 *
 * F7：Redis 故障时 fail-open → 免费模型（0 元授权、无余额闸门）在 Redis 宕机
 * 期间完全无上限。免费请求的「花费上限」授权不兜底（amount=0），此闸是唯一
 * 防线 → 必须 fail-closed（503 可重试），付费链路不受影响。
 *
 * F8：日窗口与账本（billing-flow 每日花费上限，服务器本地时区）错位——计数器
 * 用 UTC 日键。统一为同一「计费日」实现（本地时区），两侧共用一个助手。
 */

process.env.TZ = 'Asia/Tokyo'; // UTC+9：UTC 2026-08-16T20:00 = 本地 2026-08-17 05:00

function makeDeps(redisEval: unknown): PipelineDeps {
  return {
    env: { FREE_MODEL_DAILY_LIMIT: 5 },
    redis: { eval: redisEval },
    logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
  } as unknown as PipelineDeps;
}

afterAll(() => {
  delete process.env.TZ;
});

describe('免费模型日计数（F7 fail-closed / F8 计费日统一）', () => {
  it('Redis 故障 → fail-closed（free_model_counter_unavailable），不再是 null 放行', async () => {
    const guards = new RateGuards(
      makeDeps(async () => {
        throw new Error('redis down');
      }),
    );
    const result = await guards.checkFreeDailyLimit(1);
    expect(result).toEqual(
      expect.objectContaining({ ok: false, code: 'free_model_counter_unavailable' }),
    );
  });

  it('日键使用本地计费日（与账本每日限额同一时区），不是 UTC', async () => {
    const keys: string[] = [];
    const guards = new RateGuards(
      makeDeps(async (_script: string, _n: number, key: string) => {
        keys.push(key);
        return 1;
      }),
    );
    const result = await guards.checkFreeDailyLimit(
      7,
      new Date('2026-08-16T20:00:00Z'), // Tokyo：2026-08-17 05:00
    );
    expect(result).toEqual({ ok: true });
    expect(keys[0]).toBe('free:req:{7}:2026-08-17'); // 本地日，非 UTC 的 08-16
  });

  it('超限 → 429 语义 + retryAfter 到本地次日 0 点', async () => {
    const guards = new RateGuards(makeDeps(async () => 6)); // limit=5
    const result = await guards.checkFreeDailyLimit(
      7,
      new Date('2026-08-16T20:00:00Z'), // Tokyo 05:00 → 次日 0 点 = UTC 2026-08-17T15:00 → 19h
    );
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        code: 'free_model_daily_limit_exceeded',
        retryAfterSec: 19 * 3600,
      }),
    );
  });
});
