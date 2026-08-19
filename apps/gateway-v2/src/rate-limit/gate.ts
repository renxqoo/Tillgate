/**
 * 限流闸（app 编排件，Redis 装配注入；未装配 = 单副本开发形态全放行）：
 *   - key 维 RPM/TPM 准入（api_keys.rpm_limit/tpm_limit；TPM 按 token 预估预占，
 *     失败无上游执行由调用方 releaseTpm）
 *   - 渠道维 RPM/TPM 尝试前检查（channels.rpm_limit/tpm_limit——候选循环逐渠判定，
 *     超限视同可换渠错误继续）
 *   - 免费模型每日请求上限（explicitlyFree 的唯一防线——计数器不可用 fail-closed，
 *     与付费链路 fail-open 语义相反：免费不走资金闸门，无上限 = 印刷机）
 */
import type { SlidingWindowLimiter } from '@ai-gateway/core';
import type { Redis } from 'ioredis';
import { AppError } from '../http/error-map.js';

export interface RateLimitGate {
  limiter: SlidingWindowLimiter;
  freeDaily: FreeDailyGate;
}

export interface AdmissionCheck {
  dimension: string;
  max: number;
}

/** 免费模型日限判定（fail-closed——见模块头）：超限（429）与计数器不可用（503）分口径 */
export interface FreeDailyGate {
  check(userId: number): Promise<{ ok: true } | { ok: false; code: 'limit' | 'counter'; retryAfterSec: number }>;
}

/** 本地时区计费日键（免费日计数的窗口锚点） */
function localDayKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function createFreeDailyGate(redis: Redis, limit: number): FreeDailyGate {
  return {
    async check(userId) {
      const key = `free:req:${userId}:${localDayKey(new Date())}`;
      try {
        const n = (await redis.eval(
          'local v = redis.call("INCR", KEYS[1]) if v == 1 then redis.call("EXPIRE", KEYS[1], 90000) end return v',
          1,
          key,
        )) as number;
        if (n > limit) {
          // 到本地次日零点的秒数（窗口重置提示）
          const now = new Date();
          const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
          return { ok: false, code: 'limit', retryAfterSec: Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000)) };
        }
        return { ok: true };
      } catch {
        // F7 fail-closed：免费链路唯一防线，计数器不可用时拒绝（付费链路不受影响）
        return { ok: false, code: 'counter', retryAfterSec: 60 };
      }
    },
  };
}

function reject429(_dimension: string, retryAfterSec: number): AppError {
  // 维度串（key:{id} / user:{userId}）是内部标识——响应里只给口径，不给 ID
  return new AppError(429, 'rate_limit_exceeded', `请求频率或 token 预算超限，${retryAfterSec}s 后重试`);
}

/** 凭证维准入（RPM 原子 + TPM 预占）；超限抛 429。dimension 由调用方给出
 * （静态 Key → key:{id}；JWT 凭证 → user:{userId}——无 Key 维度可限） */
export async function admitKey(gate: RateLimitGate, input: {
  requestId: string;
  dimension: string;
  rpmLimit: number | null;
  tpmLimit: number | null;
  estimatedTokens: number;
}): Promise<void> {
  const dimension = input.dimension;
  if (input.rpmLimit != null && input.rpmLimit > 0) {
    const rpm = await gate.limiter.check(dimension, input.rpmLimit, input.requestId);
    if (!rpm.allowed) throw reject429(dimension, rpm.retryAfterSec ?? 60);
  }
  if (input.tpmLimit != null && input.tpmLimit > 0) {
    const tpm = await gate.limiter.reserveTpmAll(
      [{ dimension, estimatedTokens: input.estimatedTokens, max: input.tpmLimit }],
      input.requestId,
    );
    if (!tpm.allowed) throw reject429(dimension, tpm.retryAfterSec ?? 60);
  }
}

/** 渠道维尝试前判定；false = 该渠道超限（调用方按可换渠继续） */
export async function tryChannel(gate: RateLimitGate, input: {
  requestId: string;
  channelId: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  estimatedTokens: number;
}): Promise<boolean> {
  const dimension = `channel:${input.channelId}`;
  if (input.rpmLimit != null && input.rpmLimit > 0) {
    const rpm = await gate.limiter.check(dimension, input.rpmLimit, input.requestId);
    if (!rpm.allowed) return false;
  }
  if (input.tpmLimit != null && input.tpmLimit > 0) {
    const tpm = await gate.limiter.reserveTpmAll(
      [{ dimension, estimatedTokens: input.estimatedTokens, max: input.tpmLimit }],
      input.requestId,
    );
    if (!tpm.allowed) return false;
  }
  return true;
}

/** 免费模型日限（fail-closed）：超限 429 / 计数器不可用 503（拒绝放行——唯一防线） */
export async function admitFreeDaily(gate: RateLimitGate, userId: number): Promise<void> {
  const result = await gate.freeDaily.check(userId);
  if (result.ok) return;
  if (result.code === 'counter') {
    throw new AppError(503, 'free_model_counter_unavailable', '免费模型计数器不可用，暂拒绝放行');
  }
  throw reject429('free_daily', result.retryAfterSec);
}
