import type { PipelineDeps, CandidateTarget, ChannelError } from './pipeline-shared.js';
import { channelError } from './pipeline-shared.js';
import type { ChannelCache, MappingCache } from '../routing/model-router.js';
import type { AuthContext } from '../../middleware/auth.js';
import { billingDayKey, secondsUntilNextBillingDay } from '@ai-gateway/ledger';

/**
 * 限流守卫（组件化下沉）：准入维度构建 + 各级限流判定。
 *
 * 覆盖四层：免费模型日限（Redis 计数）→ 请求/用户/Key/App RPM + TPM（准入，
 * 主 mapping 维）→ fallback 模型维（G3：候选循环派发前）→ 渠道维（attempt 前）。
 * 判定语义统一：返回 null=通过；非 null=ChannelError（调用方换候选/换渠道/拒绝）。
 */

/** 免费模型日计数判定结果：ok=放行；拒绝时区分「超限」（429）与「计数器不可用」（503）。 */
export type FreeDailyLimitResult =
  | { ok: true }
  | {
      ok: false;
      code: 'free_model_daily_limit_exceeded' | 'free_model_counter_unavailable';
      retryAfterSec: number;
    };

export class RateGuards {
  constructor(private readonly deps: PipelineDeps) {}

  /**
   * 免费模型每用户每日请求计数（Redis 原子 INCR+EXPIRE；重复计数由 RPM 层
   * requestId 去重前置保证）。日窗口用账本的「计费日」单一真相（本地时区）。
   * Redis 故障 fail-closed（F7）：免费模型 0 元授权不走余额/花费上限闸门，
   * 此计数是唯一防线——fail-open 等于 Redis 宕机期间免费请求无上限；
   * 付费链路不受影响（其余限流维持 fail-open，资金由 DB 硬闸门兜底）。
   */
  async checkFreeDailyLimit(userId: number, now: Date = new Date()): Promise<FreeDailyLimitResult> {
    const limit = this.deps.env.FREE_MODEL_DAILY_LIMIT;
    const key = `free:req:{${userId}}:${billingDayKey(now)}`;
    try {
      const n = (await this.deps.redis.eval(
        'local v = redis.call("INCR", KEYS[1]) if v == 1 then redis.call("EXPIRE", KEYS[1], 90000) end return v',
        1,
        key,
      )) as number;
      if (n > limit) {
        return {
          ok: false,
          code: 'free_model_daily_limit_exceeded',
          retryAfterSec: secondsUntilNextBillingDay(now),
        };
      }
      return { ok: true };
    } catch (err) {
      this.deps.logger.warn(
        { userId, err: (err as Error).message },
        'free daily counter unavailable, failing closed',
      );
      return { ok: false, code: 'free_model_counter_unavailable', retryAfterSec: 5 };
    }
  }

  buildRpmDims(auth: AuthContext): Array<{ dimension: string; max: number }> {
    const dims: Array<{ dimension: string; max: number }> = [
      { dimension: 'global', max: this.deps.env.GLOBAL_RPM },
      {
        dimension: `user:${auth.userId}`,
        max: auth.userRpmLimit ?? this.deps.env.DEFAULT_USER_RPM,
      },
    ];
    if (auth.apiKeyId !== null && auth.keyRpmLimit !== null) {
      dims.push({ dimension: `key:${auth.apiKeyId}`, max: auth.keyRpmLimit });
    }
    if (auth.appId !== null && auth.appRpmLimit !== null) {
      dims.push({ dimension: `app:${auth.appId}`, max: auth.appRpmLimit });
    }
    return dims;
  }

  buildTpmDims(
    auth: AuthContext,
    mapping: MappingCache,
    estimatedTotalTokens: number,
  ): Array<{ dimension: string; estimatedTokens: number; max: number }> {
    const dims: Array<{ dimension: string; estimatedTokens: number; max: number }> = [
      {
        dimension: `user:${auth.userId}:model:${mapping.id}`,
        estimatedTokens: estimatedTotalTokens,
        max: auth.userTpmLimit ?? this.deps.env.DEFAULT_USER_TPM,
      },
    ];
    if (mapping.tpmLimit) {
      dims.push({
        dimension: `model:${mapping.id}`,
        estimatedTokens: estimatedTotalTokens,
        max: mapping.tpmLimit,
      });
    }
    if (auth.apiKeyId !== null && auth.keyTpmLimit !== null) {
      dims.push({
        dimension: `key:${auth.apiKeyId}`,
        estimatedTokens: estimatedTotalTokens,
        max: auth.keyTpmLimit,
      });
    }
    if (auth.appId !== null && auth.appTpmLimit !== null) {
      dims.push({
        dimension: `app:${auth.appId}`,
        estimatedTokens: estimatedTotalTokens,
        max: auth.appTpmLimit,
      });
    }
    return dims;
  }

  /**
   * G3：fallback 模型的限流维收口。准入阶段的 RPM/TPM 判定只含主 mapping 维度，
   * 主渠道故障全量切到 fallback 时若无计量，fallback 模型维（及其每用户×模型维）
   * 形同虚设——多用户合流可击穿其上游配额。镜像渠道级限流语义：超限→换候选。
   * @returns null=通过；非 null=限流错误（调用方 continue 换候选）
   */
  async reserveFallbackDims(
    auth: AuthContext,
    target: CandidateTarget,
    estimatedTotalTokens: number,
    requestId: string,
  ): Promise<ChannelError | null> {
    const { rateLimiter } = this.deps;
    if (target.rpmLimit) {
      const fbRpm = await rateLimiter.checkAll(
        [{ dimension: `model:${target.mappingId}`, max: target.rpmLimit }],
        requestId,
      );
      if (!fbRpm.allowed) {
        return channelError('rate_limited', 'fallback 模型请求频率超限', 429);
      }
    }
    const fbDims: Array<{ dimension: string; estimatedTokens: number; max: number }> = [
      {
        dimension: `user:${auth.userId}:model:${target.mappingId}`,
        estimatedTokens: estimatedTotalTokens,
        max: auth.userTpmLimit ?? this.deps.env.DEFAULT_USER_TPM,
      },
    ];
    if (target.tpmLimit) {
      fbDims.push({
        dimension: `model:${target.mappingId}`,
        estimatedTokens: estimatedTotalTokens,
        max: target.tpmLimit,
      });
    }
    const fbTpm = await rateLimiter.reserveTpmAll(fbDims, requestId);
    if (!fbTpm.allowed) {
      return channelError('rate_limited', 'fallback 模型 Token 用量超限', 429);
    }
    return null;
  }

  /**
   * 渠道级限流（保护上游 API key 配额；超限换下一个渠道）。
   * @returns null=通过；非 null=限流错误（调用方 switch 换渠道）
   */
  async checkChannelLimits(
    channel: ChannelCache,
    estimatedTotalTokens: number,
    requestId: string,
  ): Promise<ChannelError | null> {
    const { logger, rateLimiter } = this.deps;
    if (channel.rpmLimit) {
      const cRpm = await rateLimiter.check(
        `channel:${channel.channelId}`,
        channel.rpmLimit,
        requestId,
      );
      if (!cRpm.allowed) {
        logger.warn(
          { requestId, channel: channel.key, retryAfter: cRpm.retryAfterSec },
          'channel RPM limited, switching',
        );
        return channelError('rate_limited', '渠道请求频率超限', 429);
      }
    }
    if (channel.tpmLimit) {
      const cTpm = await rateLimiter.reserveTpmAll(
        [
          {
            dimension: `channel:${channel.channelId}`,
            estimatedTokens: estimatedTotalTokens,
            max: channel.tpmLimit,
          },
        ],
        requestId,
      );
      if (!cTpm.allowed) {
        logger.warn(
          { requestId, channel: channel.key, retryAfter: cTpm.retryAfterSec },
          'channel TPM limited, switching',
        );
        return channelError('rate_limited', '渠道 Token 用量超限', 429);
      }
    }
    return null;
  }
}
