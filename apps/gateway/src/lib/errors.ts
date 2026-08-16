import { HttpError, errorSpec, type KnownErrorCode } from '@ai-gateway/http';
import { pgSqlState } from '@ai-gateway/http';
import { HTTPException } from 'hono/http-exception';
import { ValidationError } from './validation.js';
import {
  BillingBacklogError,
  BillingConfigurationError,
  BillingStateConflictError,
  DailySpendLimitExceededError,
  InsufficientBalanceError,
  MemberDailyLimitExceededError,
  MemberQuotaExceededError,
  SubscriptionForbiddenError,
  SubscriptionQuotaExhaustedError,
  SubscriptionRequiredError,
} from '@ai-gateway/ledger';

/**
 * 网关统一错误体系（2026-08 异常风格，单一真相三层结构）：
 *
 *   ① 目录：ERROR_REGISTRY（packages/http）——全部对外码一次登记，
 *      状态码/默认文案从注册表推导，本文件不出现第二份码表；
 *   ② 类型：GatewayError（继承 HttpError）——网关基础错误类，管线步骤的可预期
 *      拒绝统一 throw；run.ts 边界一个 catch 收口渲染（renderGatewayError），
 *      非 GatewayError 原样上抛给 app.onError（真故障 500 路径）；
 *   ③ 翻译：translate* 系列把各层错误（ledger 域错误 / PG 约束 / 未知异常）
 *      统一翻成可渲染形状，出站渲染只有 renderReject 一个入口。
 *
 * 分级纪律（原则 6）：可预期拒绝 = throw GatewayError（4xx/429/402/503）；
 * 真正的服务端故障 = 其他异常原样上抛 → 500。注册表测试强制只有
 * internal_error 允许 500；上游 4xx 透传码是动态值（不在注册表），必须走
 * upstreamPassthroughReject 的白名单校验（4xx + 形状合法 + 调用方已
 * sanitize），否则收敛 no_available_channel。
 */

/** 可渲染的错误形状（GatewayError 结构兼容；renderReject 的入参契约） */
export interface GatewayReject {
  code: string;
  status: number;
  message: string;
  suggestion?: string;
  /** 限流类拒绝的建议等待秒数（渲染为 retry-after 头） */
  retryAfterSec?: number;
  /** 附带日志负载（如 backlog 拒绝需记录积压深度）——调用方按需输出 */
  log?: Record<string, unknown>;
}

export interface RejectOverrides {
  /** 覆盖默认文案（动态插值：模型名、余额数等） */
  message?: string;
  suggestion?: string;
  retryAfterSec?: number;
  log?: Record<string, unknown>;
}

/**
 * 网关基础错误类：状态码/默认文案从注册表推导（code 主键），
 * 管线步骤的可预期拒绝统一抛出本类（或其工厂 gatewayError()）。
 * retryAfterSec 落 retry-after 头；log 携带边界日志负载（如积压深度）。
 */
export class GatewayError extends HttpError {
  readonly retryAfterSec?: number;
  readonly log?: Record<string, unknown>;

  constructor(code: KnownErrorCode, overrides: RejectOverrides = {}) {
    super(
      code,
      overrides.message,
      undefined,
      overrides.retryAfterSec !== undefined
        ? { 'retry-after': String(overrides.retryAfterSec) }
        : undefined,
      overrides.suggestion,
    );
    this.name = 'GatewayError';
    this.retryAfterSec = overrides.retryAfterSec;
    this.log = overrides.log;
  }

  /** 结构视图（与 GatewayReject 同形，供统一渲染/翻译消费） */
  toReject(): GatewayReject {
    return {
      code: this.code,
      status: this.status,
      message: this.message,
      ...(this.suggestion !== undefined ? { suggestion: this.suggestion } : {}),
      ...(this.retryAfterSec !== undefined ? { retryAfterSec: this.retryAfterSec } : {}),
      ...(this.log !== undefined ? { log: this.log } : {}),
    };
  }
}

/** GatewayError 工厂（等价 new；保留 overrides 形状与注册表校验） */
export function gatewayError(code: KnownErrorCode, overrides: RejectOverrides = {}): GatewayError {
  return new GatewayError(code, overrides);
}

/**
 * 上游响应透传信号（管线内部控制流，不是对外错误）：
 * 单渠道尝试产出「直接返回客户端的已构建响应」（上游 4xx 原码透传等），
 * dispatch 以本类把它抛出双层候选循环，run.ts 捕获后原样返回响应，
 * 并从 channelError 提取失败元数据（lastError/upstreamCharge）供收尾信号用。
 * estimatedCancel = 用户取消（TTFB 期 aborted）已派发估算结算。
 */
export class UpstreamRespondError extends Error {
  constructor(
    public readonly response: Response,
    public readonly channelError: { code: string; upstreamCharge: 'none' | 'unknown' },
    public readonly estimatedCancel: boolean = false,
  ) {
    super(`upstream responded: ${channelError.code}`);
    this.name = 'UpstreamRespondError';
  }
}

/** 从注册表构建可渲染拒绝（状态码/默认文案单一真相；只允许覆盖动态部分） */
export function reject(code: KnownErrorCode, overrides: RejectOverrides = {}): GatewayReject {
  const spec = errorSpec(code);
  if (!spec) throw new Error(`unregistered error code: ${code}`);
  return gatewayError(code, overrides).toReject();
}

/** 上游 4xx 透传（OpenAI 兼容语义：客户端问题原码返回）。白名单：仅 4xx + 码形状合法。 */
export function upstreamPassthroughReject(input: {
  code: string;
  status: number;
  message: string;
  suggestion?: string;
}): GatewayReject {
  const codeSafe = /^[a-z0-9_]{1,64}$/.test(input.code);
  if (input.status >= 400 && input.status < 500 && codeSafe) {
    return {
      code: input.code,
      status: input.status,
      message: input.message,
      ...(input.suggestion !== undefined ? { suggestion: input.suggestion } : {}),
    };
  }
  // 5xx/畸形码不透传：收敛到注册表码，内部失败原因只进日志与 trace
  return reject('no_available_channel');
}

/** HttpError（跨 app 抛出契约，含 GatewayError）→ GatewayReject */
export function fromHttpError(error: HttpError): GatewayReject {
  const retryAfterRaw = error.headers?.['retry-after'];
  return {
    code: error.code,
    status: error.status,
    message: error.message,
    ...(error.suggestion !== undefined ? { suggestion: error.suggestion } : {}),
    ...(retryAfterRaw !== undefined ? { retryAfterSec: Number(retryAfterRaw) } : {}),
  };
}

export interface AuthorizeRejectionContext {
  /** 本次请求的预扣估算（元，字符串形式，用于余额不足文案） */
  maxEstimate: string;
  /** 单请求预扣上限（env.BILLING_RESERVATION_MAX） */
  reservationMax: string;
}

/**
 * 授权拒绝的统一翻译（表驱动单一真相）：billing 层领域异常 → throw GatewayError。
 * 返回 = 未分类异常（真正的服务端故障）→ 调用方释放预占后原样上抛。
 */
export function translateAuthorizeError(
  error: unknown,
  ctx: AuthorizeRejectionContext,
): void {
  if (error instanceof InsufficientBalanceError) {
    throw gatewayError('insufficient_balance', {
      message: `可用余额不足（当前余额 ${error.balance} 元，需要预扣 ${ctx.maxEstimate} 元）`,
      suggestion: '请充值后再试',
    });
  }
  if (error instanceof DailySpendLimitExceededError) {
    const scope = error.scope === 'key' ? `该 Key（#${error.apiKeyId}）今日` : '今日';
    throw gatewayError('daily_spend_limit_exceeded', {
      message: `${scope}花费已达上限（上限 ${error.dailySpendLimit} 元，当前预计 ${error.projected} 元）`,
      suggestion: '请明天再试，或联系管理员调整每日花费上限',
    });
  }
  if (error instanceof MemberDailyLimitExceededError) {
    throw gatewayError('member_daily_limit', {
      message: `本日花费已达上限（上限 ${error.dailySpendLimit} 元，当前预计 ${error.projected} 元）`,
      suggestion: '请联系组织管理员调整每日上限，或明日再试',
    });
  }
  if (error instanceof MemberQuotaExceededError) {
    throw gatewayError('member_quota_exceeded', {
      message: `本月配额已用完（配额 ${error.monthlyQuota} 元，当前预计 ${error.projected} 元）`,
      suggestion: '请联系组织管理员调整配额',
    });
  }
  if (error instanceof SubscriptionRequiredError) {
    throw gatewayError('subscription_required', {
      suggestion: '请先订阅或续费后再使用',
    });
  }
  if (error instanceof SubscriptionQuotaExhaustedError) {
    throw gatewayError('subscription_quota_exhausted', {
      message: `套餐额度已用完（剩余 ${error.remaining} 元，本次预估 ${error.requested} 元）`,
      suggestion: '请升级套餐、续费或扩容后再使用',
    });
  }
  if (error instanceof SubscriptionForbiddenError) {
    throw gatewayError('subscription_forbidden', {
      message: '当前凭证绑定的订阅无权使用（非 owner 或非组织成员）',
      suggestion: '请改用绑定到你有权订阅的凭证',
    });
  }
  if (error instanceof BillingConfigurationError) {
    const overLimit = error.code === 'reservation_limit_exceeded';
    throw overLimit
      ? gatewayError('reservation_limit_exceeded', {
          message: `请求最大费用 ${ctx.maxEstimate} 元超过单请求上限 ${ctx.reservationMax} 元`,
          suggestion: '请降低最大输出 token 数后重试',
        })
      : gatewayError(error.code as KnownErrorCode, {
          suggestion: '请联系管理员检查模型价格与费率卡',
        });
  }
  if (error instanceof BillingStateConflictError) {
    throw gatewayError('authorization_conflict', {
      message: `请求 ID 已存在内容不同的授权记录（${error.requestId}）`,
      suggestion: '同一请求重试请保持请求体不变，或更换 x-request-id 后重试',
    });
  }
  if (error instanceof BillingBacklogError) {
    throw gatewayError('billing_temporarily_unavailable', {
      suggestion: '请稍后重试',
      log: { pending: error.pending, oldestPendingMs: error.oldestPendingMs },
    });
  }
}

/** PG 约束/值错误 → 4xx（可预期拒绝不得伪装 500） */
const PG_REJECT_MAP: Record<string, KnownErrorCode> = {
  '23505': 'conflict',
  '23503': 'invalid_reference',
  '23514': 'constraint_violation',
  '22001': 'value_too_long',
  '22P02': 'invalid_value',
  '22003': 'value_out_of_range',
};

/** 未知异常兜底：500 且不外泄内部 message（安全：栈与详情只进日志） */
export function translateUnknown(): GatewayReject {
  return reject('internal_error');
}

/** 边界统一翻译：任何抛出的错误 → GatewayReject（app.onError 与 run.ts 共用） */
export function translateBoundaryError(error: unknown): GatewayReject {
  if (error instanceof HttpError) return fromHttpError(error);
  if (error instanceof ValidationError) {
    return reject('invalid_request', { message: '请求参数校验失败' });
  }
  if (error instanceof HTTPException) {
    // Hono 内置错误：JSON 解析失败（400）/ 未匹配路由（404）等
    const status = error.status >= 400 && error.status < 600 ? error.status : 400;
    if (status === 400) return reject('invalid_request', { message: '请求体不是合法 JSON' });
    if (status === 404) return reject('not_found');
    return reject('invalid_request');
  }
  const pg = error instanceof Error ? pgSqlState(error) : null;
  if (pg && PG_REJECT_MAP[pg]) return reject(PG_REJECT_MAP[pg]!);
  return translateUnknown();
}
