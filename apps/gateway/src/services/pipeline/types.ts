import type { ParamRules } from '@ai-gateway/ai';
import type { Decimal } from '@ai-gateway/wallet/metering';
import type { Db } from '@ai-gateway/db';
import type { Redis } from 'ioredis';
import type { Ai, Endpoint } from '@ai-gateway/ai';
import type { BillingDomain } from '@ai-gateway/ledger/billing';
import type { GatewayEnv, Logger } from '@ai-gateway/core';
import type { Tracer, Context as OtelContext, Span as OtelSpan } from '@opentelemetry/api';
import type { AuthContext } from '../../middleware/auth.js';
import type { SanitizeContext } from '../../lib/upstream-error-sanitize.js';
import type { RateLimiter } from '../billing/rate-limit-service.js';
import type { BillingDispatcher } from '../billing/billing-dispatcher.js';
import type { ModelRouter, ChannelCache } from '../routing/model-router.js';
import type { RequestLifecycle, RequestBudget } from '../runtime/request-lifecycle.js';
import type { CompletionRegistry } from '../runtime/completion-registry.js';
import type { CoefficientCache } from '../auth/coefficient-cache.js';

/**
 * 管线契约层（单一真相，全部类型 + 无依赖纯函数）：
 *
 * 函数化架构（2026-08 重构）：
 *   - 编排 = run.ts 的六步顺序调用（admission → resolve → rate-limit →
 *     authorize → dispatch → finalize），执行顺序见 run.ts 清单注释；
 *   - 组件间调用是直接函数 import（单向无环），不再有构造注入与 this 钻取；
 *   - 步骤的可预期拒绝统一 throw GatewayError（lib/errors.ts，注册表单一真相）；
 *   - TPM 预占是有所有权语义的句柄（TpmReservation），释放/移交显式化。
 */

// 端点类型复用 ai 包 Endpoint（词表单一真相：入口表/管线/adapter 寻址同源）
export type PipelineKind = Endpoint;

/** 请求未带 max_tokens 时的默认输出上限估算 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export interface PipelineDeps {
  db: Db;
  ai: Ai;
  redis: Redis;
  env: GatewayEnv;
  logger: Logger;
  billingDispatcher: BillingDispatcher;
  rateLimiter: RateLimiter;
  billing: BillingDomain;
  router: ModelRouter;
  lifecycle: RequestLifecycle;
  completions: CompletionRegistry;
  /** 费率卡系数快照（resolve 步按选中映射解析系数；单一真相 ledger/coefficient.ts） */
  coefficients: CoefficientCache;
}

/** tracer 注入束（run.ts 创建一次，各步骤共享同源；2026-08 从旧 attempt-runner 迁入终结环状 import） */
export interface PipelineTracers {
  upstream: Tracer;
  billing: Tracer;
}

/** 请求级链路上下文：后续所有 span（authorize/upstream/finalize）的父 */
export interface RequestTraceContext {
  requestContext: OtelContext;
}

/** 单渠道尝试的链路上下文（请求上下文 + 本次上游 span；TTFB/状态码/usage 写入点） */
export interface AttemptTraceContext extends RequestTraceContext {
  upSpan: OtelSpan;
}

/** 候选目标：预扣定价在解析期算好；渠道列表 lazy（主模型全失败才解析 fallback） */
export interface CandidateTarget {
  realModel: string;
  mappingId: number;
  /** 模型级限流画像（主维在准入判定；fallback 维在候选循环派发前判定——G3） */
  rpmLimit: number | null;
  tpmLimit: number | null;
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  /** 计费单位与单位单价（token 模型 unitPrice='0'；计价公式单一真相 money/amount.ts） */
  pricingUnit: string;
  unitPrice: string;
  /** 单位计量上界（body.n 等倍数参数；token 模型 0）——预扣口径 */
  unitUpperBound: number;
  /** 本候选的费率卡系数（按 mappingId/pricingGroup 解析，model>group>global） */
  coefficient: string;
  paramRules: ParamRules | null;
  billingPolicy: Record<string, unknown> | null;
  billingPolicyFingerprint: string | null;
  /** 显式免费模型（`:free` 变体 + 官方价全 0）：整条候选链全免费才产生 0 元授权 */
  isFree: boolean;
  inputTokenUpperBound: number;
  /** 预扣估算（元，Decimal，用户价=官方价×费率卡系数） */
  estimate: Decimal;
  /** 上游成本预估（元，Decimal，官方价，系数=1）——渠道进货额度精确硬闸用 */
  upstreamEstimate: Decimal;
  channels: ChannelCache[] | null;
}

/** 渠道失败信息（候选循环统一形状） */
export interface ChannelError {
  code: string;
  message: string;
  status: number;
  suggestion?: string;
  upstreamCharge: 'none' | 'unknown';
}

/** ChannelError 构造（默认无上游计费风险；status 默认 503）——候选循环内不再手写字面量 */
export function channelError(
  code: string,
  message: string,
  status = 503,
  upstreamCharge: 'none' | 'unknown' = 'none',
): ChannelError {
  return { code, message, status, upstreamCharge };
}

export interface AttemptCtx {
  requestId: string;
  model: string;
  providerName: string;
  /** 第几次渠道尝试（1 起；路线图显性化换渠次数） */
  attemptNo: number;
  endpoint?: Exclude<Endpoint, 'chat'>;
  paramRules?: ParamRules;
  deadlineMs: number;
  /** 本请求的输出 token 上界（估算结算硬夹用，run() 单一来源） */
  maxOutputTokens: number;
  signal: AbortSignal;
}

/**
 * 上游租约时长（单一真相）：非流式调用没有任何续期（续期只存在于流式的
 * withBillingLifecycle），租约必须覆盖请求的权威时间上界（budget deadline），
 * 否则长耗时请求会在仍在途时被 worker recoverOnce 按「网关崩溃」口径释放（→漏收）。
 * deadline 先到（abort 请求），租约永不在请求存续期内过期。
 */
export function upstreamLeaseMs(leaseMs: number, requestDeadlineMs: number): number {
  return Math.max(leaseMs, requestDeadlineMs + 10_000);
}

export type AttemptOutcome =
  | { kind: 'success'; response: Response }
  | { kind: 'switch'; error: ChannelError }
  | { kind: 'respond'; response: Response; error: ChannelError };

/**
 * TPM 预占句柄（2026-08 重构：所有权结构化，替代散布 5 处的布尔标志 + 手工释放）：
 *
 *   handedOff() — 成功/用户取消估算路径：移交结算 backfillTpm 处置
 *   retained()  — 上游计费状态未知：保留预占，等 TTL(600s)/结算处置
 *   release()   — 未交付路径：释放全部维度（幂等，只执行一次）
 *
 * 契约由 tpm-reservation.characterization.test.ts 护栏验证。
 */
export interface TpmReservation {
  handedOff(): void;
  retained(): void;
  release(): Promise<void>;
}

export function createTpmReservation(
  rateLimiter: RateLimiter,
  requestId: string,
): TpmReservation {
  let disposition: 'held' | 'handed_off' | 'retained' | 'released' = 'held';
  return {
    handedOff() {
      disposition = 'handed_off';
    },
    retained() {
      disposition = 'retained';
    },
    async release() {
      if (disposition !== 'held') return;
      disposition = 'released';
      // best-effort：Redis 故障不得阻塞计费/响应主路径（TTL 600s 自然回收）
      await rateLimiter.releaseTpm(requestId).catch(() => {});
    },
  };
}

/** 输出 token 上界（TPM 预算 / 预扣 / 估算硬夹共用口径）。exposureCap = env.GATEWAY_OUTPUT_EXPOSURE_CAP */
export function maxOutputTokens(
  kind: PipelineKind,
  body: Record<string, unknown>,
  exposureCap: number,
): number {
  if (kind !== 'chat') return 0; // embeddings 无输出；模态端点按单位计费（units 上界走 unitUpperBound）
  const requested =
    typeof body.max_completion_tokens === 'number' && body.max_completion_tokens > 0
      ? body.max_completion_tokens
      : typeof body.max_tokens === 'number' && body.max_tokens > 0
        ? body.max_tokens
        : DEFAULT_MAX_OUTPUT_TOKENS;
  const count = typeof body.n === 'number' && body.n > 0 ? body.n : 1;
  // 信用模型：输出敞口（及 TPM 预算）不按 max_tokens 全额预估——max_tokens 是「上限」不是「预期」。
  // cap 之外的部分由 credit_limit 透支缓冲 + 结算扣负兜底，避免长输出上限把在途敞口虚高。
  return Math.min(requested * count, exposureCap);
}

/** 出站脱敏上下文：当前候选真实模型名 + 对外名 + 渠道供应商（错误面白标闭环） */
export function sanitizeCtx(
  externalModel: string,
  target: CandidateTarget,
  channel: ChannelCache | null,
): SanitizeContext {
  return {
    realModels: [target.realModel],
    externalModel,
    providerNames: channel ? [channel.providerName] : [],
  };
}

export type { AuthContext, RequestBudget };
