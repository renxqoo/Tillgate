import { gatewayError } from '../../../lib/errors.js';
import { billingDayKey, secondsUntilNextBillingDay } from '@ai-gateway/ledger';
import type { MappingCache, ChannelCache } from '../../routing/model-router.js';
import type {
  AuthContext,
  CandidateTarget,
  ChannelError,
  PipelineDeps,
  TpmReservation,
} from '../types.js';
import { channelError, createTpmReservation } from '../types.js';

/**
 * 第三步：限流（RPM 原子判定 → TPM 原子预占 → 免费模型日限）。
 *
 * 覆盖四层：免费模型日限（Redis 计数）→ 请求/用户/Key/App RPM + TPM（准入，
 * 主 mapping 维）→ fallback 模型维（G3：候选循环派发前，见 reserveFallbackDims）
 * → 渠道维（attempt 前，见 checkChannelLimits）。
 * 判定语义统一：返回 null=通过；非 null=ChannelError（调用方换候选/换渠道）。
 */

/** 免费模型日计数判定结果：ok=放行；拒绝时区分「超限」（429）与「计数器不可用」（503）。 */
export type FreeDailyLimitResult =
  | { ok: true }
  | {
      ok: false;
      code: 'free_model_daily_limit_exceeded' | 'free_model_counter_unavailable';
      retryAfterSec: number;
    };

/**
 * 免费模型每用户每日请求计数（Redis 原子 INCR+EXPIRE；重复计数由 RPM 层
 * requestId 去重前置保证）。日窗口用账本的「计费日」单一真相（本地时区）。
 * Redis 故障 fail-closed（F7）：免费模型 0 元授权不走余额/花费上限闸门，
 * 此计数是唯一防线——fail-open 等于 Redis 宕机期间免费请求无上限；
 * 付费链路不受影响（其余限流维持 fail-open，资金由 DB 硬闸门兜底）。
 */
export async function checkFreeDailyLimit(
  deps: PipelineDeps,
  userId: number,
  now: Date = new Date(),
): Promise<FreeDailyLimitResult> {
  const limit = deps.env.FREE_MODEL_DAILY_LIMIT;
  const key = `free:req:{${userId}}:${billingDayKey(now)}`;
  try {
    const n = (await deps.redis.eval(
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
    deps.logger.warn(
      { userId, err: (err as Error).message },
      'free daily counter unavailable, failing closed',
    );
    return { ok: false, code: 'free_model_counter_unavailable', retryAfterSec: 5 };
  }
}

export function buildRpmDims(
  deps: PipelineDeps,
  auth: AuthContext,
): Array<{ dimension: string; max: number }> {
  const dims: Array<{ dimension: string; max: number }> = [
    { dimension: 'global', max: deps.env.GLOBAL_RPM },
    {
      dimension: `user:${auth.userId}`,
      max: auth.userRpmLimit ?? deps.env.DEFAULT_USER_RPM,
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

export function buildTpmDims(
  deps: PipelineDeps,
  auth: AuthContext,
  mapping: MappingCache,
  estimatedTotalTokens: number,
): Array<{ dimension: string; estimatedTokens: number; max: number }> {
  const dims: Array<{ dimension: string; estimatedTokens: number; max: number }> = [
    {
      dimension: `user:${auth.userId}:model:${mapping.id}`,
      estimatedTokens: estimatedTotalTokens,
      max: auth.userTpmLimit ?? deps.env.DEFAULT_USER_TPM,
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
export async function reserveFallbackDims(
  deps: PipelineDeps,
  auth: AuthContext,
  target: CandidateTarget,
  estimatedTotalTokens: number,
  requestId: string,
): Promise<ChannelError | null> {
  if (target.rpmLimit) {
    const fbRpm = await deps.rateLimiter.checkAll(
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
      max: auth.userTpmLimit ?? deps.env.DEFAULT_USER_TPM,
    },
  ];
  if (target.tpmLimit) {
    fbDims.push({
      dimension: `model:${target.mappingId}`,
      estimatedTokens: estimatedTotalTokens,
      max: target.tpmLimit,
    });
  }
  const fbTpm = await deps.rateLimiter.reserveTpmAll(fbDims, requestId);
  if (!fbTpm.allowed) {
    return channelError('rate_limited', 'fallback 模型 Token 用量超限', 429);
  }
  return null;
}

/**
 * 渠道级限流（保护上游 API key 配额；超限换下一个渠道）。
 * @returns null=通过；非 null=限流错误（调用方 switch 换渠道）
 */
export async function checkChannelLimits(
  deps: PipelineDeps,
  channel: ChannelCache,
  estimatedTotalTokens: number,
  requestId: string,
): Promise<ChannelError | null> {
  if (channel.rpmLimit) {
    const cRpm = await deps.rateLimiter.check(
      `channel:${channel.channelId}`,
      channel.rpmLimit,
      requestId,
    );
    if (!cRpm.allowed) {
      deps.logger.warn(
        { requestId, channel: channel.key, retryAfter: cRpm.retryAfterSec },
        'channel RPM limited, switching',
      );
      return channelError('rate_limited', '渠道请求频率超限', 429);
    }
  }
  if (channel.tpmLimit) {
    const cTpm = await deps.rateLimiter.reserveTpmAll(
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
      deps.logger.warn(
        { requestId, channel: channel.key },
        'channel TPM limited, switching',
      );
      return channelError('rate_limited', '渠道 Token 用量超限', 429);
    }
  }
  return null;
}

/**
 * 准入限流（run.ts 第三步入口）：RPM → TPM 预占（返回句柄）→ 免费模型日限。
 * 免费日限拒绝路径显式释放 TPM 预占（否则占满窗口至 600s TTL；被拒请求不占窗口，
 * 与 RPM 层同语义）。
 */
export async function checkRateLimits(
  deps: PipelineDeps,
  auth: AuthContext,
  mapping: MappingCache,
  requestId: string,
  estimatedTotalTokens: number,
): Promise<{ tpm: TpmReservation }> {
  // ---- 请求 + 模型 RPM 一次原子判定；后维拒绝不会污染前维窗口。 ----
  const rpmDims = buildRpmDims(deps, auth);
  if (mapping.rpmLimit) rpmDims.push({ dimension: `model:${mapping.id}`, max: mapping.rpmLimit });
  const rlResult = await deps.rateLimiter.checkAll(rpmDims, requestId);
  if (!rlResult.allowed) {
    throw gatewayError('rate_limit_exceeded', {
      message: `请求过于频繁（${rlResult.dimension} 维度超限）`,
      suggestion: `请 ${rlResult.retryAfterSec} 秒后重试`,
      retryAfterSec: rlResult.retryAfterSec ?? 1,
    });
  }

  // ---- TPM 原子预占：所有请求维度要么一起成功，要么一项都不写 ----
  const tpmDims = buildTpmDims(deps, auth, mapping, estimatedTotalTokens);
  const tpmResult = await deps.rateLimiter.reserveTpmAll(tpmDims, requestId);
  if (!tpmResult.allowed) {
    throw gatewayError('rate_limit_exceeded', {
      message: `Token 用量超限（${tpmResult.dimension} 维度 TPM）`,
      suggestion: `请 ${tpmResult.retryAfterSec} 秒后重试`,
      retryAfterSec: tpmResult.retryAfterSec ?? 1,
    });
  }
  const tpm = createTpmReservation(deps.rateLimiter, requestId);

  // ---- 免费模型独立日限额：0 元授权不占每日花费上限（amount=0），需独立请求数闸防滥用。
  // 计数器不可用（Redis 故障）fail-closed → 503：此闸是免费链路唯一防线 ----
  if (mapping.isFree && deps.env.FREE_MODEL_DAILY_LIMIT > 0) {
    const free = await checkFreeDailyLimit(deps, auth.userId);
    if (!free.ok) {
      // 本闸位于 TPM 预占之后——拒绝路径必须显式释放（见句柄所有权契约）
      await tpm.release();
      if (free.code === 'free_model_daily_limit_exceeded') {
        throw gatewayError('free_model_daily_limit_exceeded', {
          message: `免费模型每日请求数已达上限（${deps.env.FREE_MODEL_DAILY_LIMIT} 次/天）`,
          suggestion: '请明日再试或联系管理员调整限额',
          retryAfterSec: free.retryAfterSec,
        });
      }
      throw gatewayError('free_model_counter_unavailable', {
        suggestion: '请稍后重试',
        retryAfterSec: free.retryAfterSec,
      });
    }
  }

  return { tpm };
}
