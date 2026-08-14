import type { Context } from 'hono';
import { createHash } from 'node:crypto';
import type { Ai, ChannelDesc, ParamRules, Usage, UpstreamError } from '@ai-gateway/ai';
import { estimateTokens, extractRequestChars } from '@ai-gateway/ai';
import { Decimal, estimateMaxCost } from '@ai-gateway/money';
import {
  BillingConfigurationError,
  BillingBacklogError,
  DailySpendLimitExceededError,
  InsufficientBalanceError,
  SubscriptionQuotaExhaustedError,
  SubscriptionRequiredError,
  type Billing,
  type UsageReceipt,
} from '@ai-gateway/ledger';
import type { Db } from '@ai-gateway/db';
import type { Redis } from 'ioredis';
import { context as otelContext, trace as otelTrace } from '@opentelemetry/api';
import {
  formatTraceParent,
  getTracer,
  type GatewayEnv,
  type Logger,
  SpanStatusCode,
} from '@ai-gateway/core';
import type { AttemptTraceContext, RequestTraceContext } from './trace-context.js';
import type { AuthContext, AuthEnv } from '../../middleware/auth.js';
import { errorResponse } from '../../lib/http.js';
import { rewriteSseModel } from '../../lib/sse-model-rewrite.js';
import { isModelAllowed } from '../../lib/model-scope.js';
import {
  recordChannelFailure,
  recordBillingWakeupFailed,
  recordRequest,
} from '../../lib/metrics.js';
import { RateLimiter } from '../billing/rate-limit-service.js';
import { BillingDispatcher } from '../billing/billing-dispatcher.js';
import {
  analyzeMultimodalRequest,
  authorizeMultimodalQuote,
  MultimodalQuoteError,
} from '../billing/multimodal-quote-policy.js';
import { ModelRouter, type ChannelCache, type MappingCache } from '../routing/model-router.js';
import {
  isChannelSwitchable,
  isDeadCredentialError,
  markChannelDeadCredential,
} from '../routing/channel-policy.js';
import { RequestLifecycle } from '../runtime/request-lifecycle.js';
import { CompletionRegistry } from '../runtime/completion-registry.js';

/**
 * LLM 请求管线（chat/completions 与 embeddings 共享编排，杜绝两路由漂移）：
 *
 *   scope 校验 → 限流(RPM: global/user/key/app → 模型级) → TPM 预检查
 *   → 候选定价（主模型 + fallback）→ billing_requests 足额授权
 *   → 候选循环[渠道级限流 → ai 包调用 → 换渠道/死凭据持久化]
 *   → 成功收据先落 DB → 队列只做结算唤醒；失败按请求级状态释放
 *
 * 计费语义（requirements 5.11）：
 *   - durable receipt 携带实际成功渠道对应价格快照 + mappingId
 *   - 任意成功响应缺少供应商可信 usage → uncertain；估算值只用于授权，绝不进入资金结算
 */

export type PipelineKind = 'chat' | 'embeddings';

/** 请求未带 max_tokens 时的默认输出上限估算 */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export interface PipelineDeps {
  db: Db;
  ai: Ai;
  redis: Redis;
  env: GatewayEnv;
  logger: Logger;
  billingDispatcher: BillingDispatcher;
  rateLimiter: RateLimiter;
  billing: Billing;
  router: ModelRouter;
  lifecycle: RequestLifecycle;
  completions: CompletionRegistry;
}

/** 候选目标：预扣定价在解析期算好；渠道列表 lazy（主模型全失败才解析 fallback） */
interface CandidateTarget {
  realModel: string;
  mappingId: number;
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  paramRules: ParamRules | null;
  billingPolicy: Record<string, unknown> | null;
  billingPolicyFingerprint: string | null;
  inputTokenUpperBound: number;
  /** 预扣估算（元，Decimal，用户价=官方价×费率卡系数） */
  estimate: Decimal;
  /** 上游成本预估（元，Decimal，官方价，系数=1）——渠道进货额度精确硬闸用 */
  upstreamEstimate: Decimal;
  channels: ChannelCache[] | null;
}

/** 渠道失败信息（候选循环统一形状） */
interface ChannelError {
  code: string;
  message: string;
  status: number;
  suggestion?: string;
  upstreamCharge: 'none' | 'unknown';
}

interface AttemptCtx {
  requestId: string;
  model: string;
  providerName: string;
  /** 第几次渠道尝试（1 起；路线图显性化换渠次数） */
  attemptNo: number;
  endpoint?: 'embeddings';
  paramRules?: ParamRules;
  deadlineMs: number;
  signal: AbortSignal;
}

type AttemptOutcome =
  | { kind: 'success'; response: Response }
  | { kind: 'switch'; error: ChannelError }
  | { kind: 'respond'; response: Response; error: ChannelError };

export class LlmPipeline {
  private readonly upstreamTracer = getTracer('gateway.upstream');
  private readonly billingTracer = getTracer('gateway.billing');

  constructor(private readonly deps: PipelineDeps) {}

  async run(
    c: Context<AuthEnv>,
    kind: PipelineKind,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const { env, logger, rateLimiter, billing, router } = this.deps;
    const auth = c.var.auth;
    const requestId = c.var.requestId;
    const model = body.model as string;
    const stream = kind === 'chat' && body.stream === true;
    const budget = this.deps.lifecycle.create(c.req.raw.signal);
    if (budget.signal.aborted) {
      return errorResponse(c, 408, 'request_cancelled', '请求已取消');
    }

    // ---- JWT scope.models 越权校验（S3）：白名单外的模型直接 403（防越权计费）----
    if (!isModelAllowed(auth.allowedModels, model)) {
      return errorResponse(c, 403, 'model_not_allowed', `模型「${model}」不在当前凭证的可用范围内`);
    }

    // ---- 模型路由：externalName → model_mappings（Redis 缓存，消除热路径每请求查 DB）----
    const mapping = await router.getMapping(model);
    if (!mapping) {
      return errorResponse(c, 404, 'model_not_found', `模型「${model}」不存在或已下架`);
    }

    let multimodal;
    try {
      multimodal = analyzeMultimodalRequest(body);
    } catch (error) {
      if (error instanceof MultimodalQuoteError) {
        return errorResponse(c, 422, error.code, error.message);
      }
      throw error;
    }

    // 输入 token 估算（TPM 预占 + 预扣共用）
    const estInput = estimateTokens(extractRequestChars(body), 3.5);
    // 预扣估算用 UTF-8 字节数作为保守输入上界（仅为「预留足够资金」的估算值）。
    // 它不是「真实 token 的硬上限」：供应商会报告隐藏的 system/cached token，
    // 真实 inputTokens 可远超字节数。资损不变量由 settleClaim 的「金额」判定兜底
    // （calculated > reserved → dead），不在此处用字节数卡 token。
    const textInputUpperBound = this.inputTokenUpperBound(body);

    // ---- 请求 + 模型 RPM 一次原子判定；后维拒绝不会污染前维窗口。 ----
    const rpmDims = this.buildRpmDims(auth);
    if (mapping.rpmLimit) rpmDims.push({ dimension: `model:${mapping.id}`, max: mapping.rpmLimit });
    const rlResult = await rateLimiter.checkAll(rpmDims, requestId);
    if (!rlResult.allowed) {
      c.header('retry-after', String(rlResult.retryAfterSec ?? 1));
      return errorResponse(
        c,
        429,
        'rate_limit_exceeded',
        `请求过于频繁（${rlResult.dimension} 维度超限）`,
        `请 ${rlResult.retryAfterSec} 秒后重试`,
      );
    }

    // ---- 候选定价：主模型 + fallback。预扣按最贵候选估算，杜绝 fallback 更贵导致结算透支 ----
    let targets: CandidateTarget[];
    try {
      targets = await this.resolveTargets(
        kind,
        body,
        mapping,
        textInputUpperBound,
        multimodal,
        auth.coefficient,
      );
    } catch (error) {
      if (error instanceof MultimodalQuoteError) {
        return errorResponse(
          c,
          422,
          error.code,
          error.message,
          '请调整媒体内容，或由管理员配置该模型的多模态计费策略',
        );
      }
      throw error;
    }
    // ---- TPM 原子预占：所有请求维度要么一起成功，要么一项都不写 ----
    const maxOutputTokens = this.maxOutputTokens(kind, body);
    const estimatedTotalTokens = estInput + maxOutputTokens;
    const tpmDims = this.buildTpmDims(auth, mapping, estimatedTotalTokens);
    const tpmResult = await rateLimiter.reserveTpmAll(tpmDims, requestId);
    if (!tpmResult.allowed) {
      c.header('retry-after', String(tpmResult.retryAfterSec ?? 1));
      return errorResponse(
        c,
        429,
        'rate_limit_exceeded',
        `Token 用量超限（${tpmResult.dimension} 维度 TPM）`,
        `请 ${tpmResult.retryAfterSec} 秒后重试`,
      );
    }
    let releaseTpm = true;

    // ---- 足额授权（billing_requests：DB 权威）----
    const maxEstimate = targets.reduce(
      (max, t) => (t.estimate.gt(max) ? t.estimate : max),
      new Decimal(0),
    );
    // 请求级链路上下文：后续所有 span（authorize/upstream/finalize）的父
    const requestTrace: RequestTraceContext = { requestContext: otelContext.active() };
    // 根 span traceparent：落列 billing_requests，worker 结算时挂回同一 trace
    const rootSpanContext = otelTrace.getSpan(requestTrace.requestContext)?.spanContext();
    const traceParent = rootSpanContext ? formatTraceParent(rootSpanContext) : null;
    let authorization;
    const authSpan = this.billingTracer.startSpan('billing.authorize');
    authSpan.setAttribute('request.id', requestId);
    try {
      authorization = await billing.authorize({
        requestId,
        userId: auth.userId,
        apiKeyId: auth.apiKeyId,
        stream,
        traceParent,
        reservationLimit: String(env.BILLING_RESERVATION_MAX),
        authorizationTtlMs: env.BILLING_AUTHORIZATION_TTL_SECONDS * 1_000,
        quote: {
          maxOutputTokens,
          candidates: targets.map((target) => ({
            mappingId: target.mappingId,
            externalModel: model,
            realModel: target.realModel,
            inputPrice: target.inputPrice,
            outputPrice: target.outputPrice,
            cacheInputPrice: target.cacheInputPrice,
            coefficient: auth.coefficient,
            inputTokenUpperBound: target.inputTokenUpperBound,
            billingPolicyFingerprint: target.billingPolicyFingerprint,
          })),
        },
      });
      authSpan.setAttributes({
        'billing.result': 'authorized',
        // 预估敞口（非冻结额），结算按实扣
        'billing.amount_reserved': authorization.reservedAmount,
        'billing.available_balance': authorization.availableBalance,
        'billing.replayed': authorization.replayed,
      });
    } catch (error) {
      // 拒绝语义码与对外 402/422 响应同源（链路里直接看拒绝原因）
      const rejectCode =
        error instanceof InsufficientBalanceError
          ? 'insufficient_balance'
          : error instanceof DailySpendLimitExceededError
            ? 'daily_spend_limit_exceeded'
            : error instanceof SubscriptionRequiredError
              ? 'subscription_required'
              : error instanceof SubscriptionQuotaExhaustedError
                ? 'subscription_quota_exhausted'
                : error instanceof BillingConfigurationError
                  ? error.code
                  : 'authorize_error';
      authSpan.setAttributes({
        'billing.result': 'rejected',
        'billing.reject_code': rejectCode,
        'billing.amount_required': maxEstimate.toString(),
      });
      authSpan.setStatus({ code: SpanStatusCode.ERROR, message: rejectCode });
      if (error instanceof InsufficientBalanceError) {
        await rateLimiter.releaseTpm(requestId).catch(() => {});
        return errorResponse(
          c,
          402,
          'insufficient_balance',
          `可用余额不足（当前余额 ${error.balance} 元，需要预扣 ${maxEstimate.toString()} 元）`,
          '请充值后再试',
        );
      }
      if (error instanceof DailySpendLimitExceededError) {
        await rateLimiter.releaseTpm(requestId).catch(() => {});
        const scope =
          error.scope === 'key' ? `该 Key（#${error.apiKeyId}）今日` : '今日';
        return errorResponse(
          c,
          402,
          'daily_spend_limit_exceeded',
          `${scope}花费已达上限（上限 ${error.dailySpendLimit} 元，当前预计 ${error.projected} 元）`,
          '请明天再试，或联系管理员调整每日花费上限',
        );
      }
      if (error instanceof SubscriptionRequiredError) {
        await rateLimiter.releaseTpm(requestId).catch(() => {});
        return errorResponse(
          c,
          402,
          'subscription_required',
          '无有效订阅（未订阅或已到期）',
          '请先订阅或续费后再使用',
        );
      }
      if (error instanceof SubscriptionQuotaExhaustedError) {
        await rateLimiter.releaseTpm(requestId).catch(() => {});
        return errorResponse(
          c,
          402,
          'subscription_quota_exhausted',
          `套餐额度已用完（剩余 ${error.remaining} 元，本次预估 ${error.requested} 元）`,
          '请升级套餐、续费或扩容后再使用',
        );
      }
      if (error instanceof BillingConfigurationError) {
        await rateLimiter.releaseTpm(requestId).catch(() => {});
        const overLimit = error.code === 'reservation_limit_exceeded';
        return errorResponse(
          c,
          overLimit ? 422 : 503,
          error.code,
          overLimit
            ? `请求最大费用 ${maxEstimate.toString()} 元超过单请求上限 ${env.BILLING_RESERVATION_MAX} 元`
            : '模型计费配置无效',
          overLimit ? '请降低最大输出 token 数后重试' : '请联系管理员检查模型价格与费率卡',
        );
      }
      if (error instanceof BillingBacklogError) {
        await rateLimiter.releaseTpm(requestId).catch(() => {});
        logger.error(
          { requestId, pending: error.pending, oldestPendingMs: error.oldestPendingMs },
          'billing settlement backlog closed admission',
        );
        return errorResponse(
          c,
          503,
          'billing_temporarily_unavailable',
          '计费结算服务暂时繁忙，为保护资金准确性已暂停新请求',
          '请稍后重试',
        );
      }
      await rateLimiter.releaseTpm(requestId).catch(() => {});
      throw error;
    } finally {
      authSpan.end();
    }
    logger.debug(
      {
        requestId,
        userId: auth.userId,
        maxEstimate: maxEstimate.toString(),
        reservedAmount: authorization.reservedAmount,
      },
      'billing authorized',
    );

    // ---- 候选循环：主模型渠道 → 全失败 → fallback 模型渠道 → 全失败 → 503 ----
    let deliveryAccepted = false;
    let lastError: ChannelError | null = null;
    let upstreamChargeUnknown = false;

    try {
      for (const target of targets) {
        const channels = target.channels ?? (await router.getChannels(target.realModel));
        target.channels = channels;
        if (channels.length === 0) continue;

        let attemptNo = 0;
        for (const channel of channels) {
          if (budget.signal.aborted) break;
          attemptNo += 1;
          // 渠道「进货额度」精确硬闸：路由选渠前原子预留在途上游成本敞口。
          // 余额（进货额度 - 已消耗 - 在途）不足本次上游预估 → 跳过改试下一渠道（没钱即拦截）。
          let reservation: { allowed: boolean; remaining: string };
          try {
            reservation = await billing.reserveChannel({
              requestId,
              channelId: channel.channelId,
              amount: target.upstreamEstimate.toString(),
            });
          } catch (error) {
            logger.warn(
              { requestId, channel: channel.key, err: (error as Error).message },
              'channel reserve failed, skipping',
            );
            lastError = {
              code: 'channel_budget_exhausted',
              message: '渠道额度不足',
              status: 503,
              upstreamCharge: 'none',
            };
            continue;
          }
          if (!reservation.allowed) {
            logger.warn(
              { requestId, channel: channel.key, remaining: reservation.remaining },
              'channel upstream budget exhausted, skipping',
            );
            lastError = {
              code: 'channel_budget_exhausted',
              message: '渠道额度不足',
              status: 503,
              upstreamCharge: 'none',
            };
            continue;
          }
          const ctx: AttemptCtx = {
            requestId,
            model: target.realModel,
            providerName: channel.providerName,
            attemptNo,
            endpoint: kind === 'embeddings' ? 'embeddings' : undefined,
            paramRules: target.paramRules ?? undefined,
            // 每次 fallback 只拿整个请求预算的剩余值，绝不重置 deadline。
            deadlineMs: budget.remainingMs(),
            signal: budget.signal,
          };
          logger.info(
            { requestId, channel: channel.key, model: target.realModel, stream },
            'candidate attempt',
          );
          const outcome = await this.attempt(
            c,
            auth,
            requestId,
            body,
            model,
            estimatedTotalTokens,
            kind,
            target,
            channel,
            ctx,
            stream,
            requestTrace,
          );
          if (outcome.kind === 'success') {
            deliveryAccepted = true;
            releaseTpm = false;
            return outcome.response;
          }
          if (outcome.kind === 'respond') {
            lastError = outcome.error;
            if (outcome.error.upstreamCharge === 'unknown') upstreamChargeUnknown = true;
            return outcome.response;
          }
          lastError = outcome.error;
          if (outcome.error.upstreamCharge === 'unknown') upstreamChargeUnknown = true;
          if (budget.signal.aborted) break;
        }
      }

      // 全部候选耗尽 → 503（返回最后一个有意义的错误）
      const code = lastError?.code ?? 'no_available_channel';
      const message = lastError?.message ?? `模型「${model}」所有渠道均不可用`;
      return errorResponse(c, 503, code, message, lastError?.suggestion);
    } finally {
      if (!deliveryAccepted) {
        try {
          await billing.signal({
            type: 'request.failed',
            requestId,
            reason: lastError?.code ?? 'request_failed_before_delivery',
            delivery: 'none',
            upstreamCharge: upstreamChargeUnknown ? 'unknown' : 'none',
          });
        } catch (e) {
          logger.warn({ requestId, err: (e as Error).message }, 'billing failure signal failed');
        }
        if (releaseTpm && !upstreamChargeUnknown) {
          await rateLimiter.releaseTpm(requestId).catch(() => {});
        }
      }
      budget.dispose();
    }
  }

  // ---- 限流维度构建（集中管理，杜绝两路由维度漂移）----

  private buildRpmDims(auth: AuthContext): Array<{ dimension: string; max: number }> {
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

  private buildTpmDims(
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

  /** 候选目标解析：价格预取（预扣需要），fallback 渠道列表 lazy */
  private async resolveTargets(
    kind: PipelineKind,
    body: Record<string, unknown>,
    mapping: MappingCache,
    inputTokenUpperBound: number,
    multimodal: ReturnType<typeof analyzeMultimodalRequest>,
    coefficient: string,
  ): Promise<CandidateTarget[]> {
    const targets: CandidateTarget[] = [];
    const addTarget = (m: MappingCache): void => {
      const candidateInputUpperBound = Math.max(
        inputTokenUpperBound,
        authorizeMultimodalQuote(multimodal, m.billingPolicy),
      );
      const maxOutputTokens = this.maxOutputTokens(kind, body);
      const estimate = estimateMaxCost({
        estimatedInputTokens: candidateInputUpperBound,
        maxOutputTokens,
        inputPrice: m.inputPrice,
        cacheInputPrice: m.cacheInputPrice,
        outputPrice: kind === 'chat' ? m.outputPrice : 0,
        coefficient,
      });
      // 上游成本 = 官方价 × 上界（系数=1），与 settle.ts 的 upstream_cost 同口径
      const upstreamEstimate = estimateMaxCost({
        estimatedInputTokens: candidateInputUpperBound,
        maxOutputTokens,
        inputPrice: m.inputPrice,
        cacheInputPrice: m.cacheInputPrice,
        outputPrice: kind === 'chat' ? m.outputPrice : 0,
        coefficient: '1',
      });
      targets.push({
        realModel: m.realModel,
        mappingId: m.id,
        inputPrice: m.inputPrice,
        outputPrice: m.outputPrice,
        cacheInputPrice: m.cacheInputPrice,
        paramRules: m.paramRules,
        billingPolicy: m.billingPolicy,
        billingPolicyFingerprint: m.billingPolicy
          ? createHash('sha256').update(JSON.stringify(m.billingPolicy)).digest('hex')
          : null,
        inputTokenUpperBound: candidateInputUpperBound,
        estimate,
        upstreamEstimate,
        channels: null,
      });
    };

    addTarget(mapping);
    // fallback 模型（仅 chat）：预扣按最贵候选，渠道列表主模型全失败时才解析
    if (kind === 'chat') {
      for (const fb of mapping.fallbackModels ?? []) {
        const fbMapping = await this.deps.router.getMapping(fb);
        if (fbMapping) addTarget(fbMapping);
      }
    }
    return targets;
  }

  private maxOutputTokens(kind: PipelineKind, body: Record<string, unknown>): number {
    if (kind === 'embeddings') return 0;
    const requested =
      typeof body.max_completion_tokens === 'number' && body.max_completion_tokens > 0
        ? body.max_completion_tokens
        : typeof body.max_tokens === 'number' && body.max_tokens > 0
          ? body.max_tokens
          : DEFAULT_MAX_OUTPUT_TOKENS;
    const count = typeof body.n === 'number' && body.n > 0 ? body.n : 1;
    // 信用模型：输出敞口（及 TPM 预算）不按 max_tokens 全额预估——max_tokens 是「上限」不是「预期」。
    // cap 之外的部分由 credit_limit 透支缓冲 + 结算扣负兜底，避免长输出上限把在途敞口虚高。
    return Math.min(requested * count, this.deps.env.GATEWAY_OUTPUT_EXPOSURE_CAP);
  }

  /**
   * 输入 token 的保守上界（信用模型下用于预估在途敞口）。
   * 用「字符数」而非 UTF-8 字节数：token 数恒 ≤ 字符数（中文 1 字符≈1 token，英文更低），
   * 字节数对中文会高估约 3 倍，字符数仍是可靠上界且不虚高。
   * 多模态语义成本由模型 billing_policy 的 maxInputTokens 接管。
   */
  private inputTokenUpperBound(body: Record<string, unknown>): number {
    return Math.max(1, extractRequestChars(body));
  }

  /** 单渠道尝试：渠道级限流 → ai 包调用（流式/非流式） */
  private async attempt(
    c: Context<AuthEnv>,
    auth: AuthContext,
    requestId: string,
    body: Record<string, unknown>,
    externalModel: string,
    estimatedTotalTokens: number,
    kind: PipelineKind,
    target: CandidateTarget,
    channel: ChannelCache,
    ctx: AttemptCtx,
    stream: boolean,
    requestTrace: RequestTraceContext,
  ): Promise<AttemptOutcome> {
    const { logger, rateLimiter } = this.deps;

    // ---- 渠道级限流（保护上游 API key 配额；超限换下一个渠道）----
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
        return {
          kind: 'switch',
          error: {
            code: 'rate_limited',
            message: '渠道请求频率超限',
            status: 429,
            upstreamCharge: 'none',
          },
        };
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
        return {
          kind: 'switch',
          error: {
            code: 'rate_limited',
            message: '渠道 Token 用量超限',
            status: 429,
            upstreamCharge: 'none',
          },
        };
      }
    }

    const channelDesc: ChannelDesc = {
      baseUrl: channel.baseUrl,
      apiKey: channel.apiKey,
      protocol: channel.protocol,
    };

    await this.deps.billing.signal({
      type: 'upstream.started',
      requestId,
      leaseOwner: requestId,
      leaseMs: this.deps.env.BILLING_LEASE_SECONDS * 1_000,
    });

    // 上游调用 Span（渠道级，OTel 链路追踪）
    const upSpan = this.upstreamTracer.startSpan(`upstream ${channel.providerName}`);
    upSpan.setAttributes({
      'channel.id': channel.channelId,
      'channel.key': channel.key,
      'ai.model': target.realModel,
      'ai.attempt_stream': stream,
      // 第几次渠道尝试（路线图节点显性化「换了 N 次渠」）
      'channel.attempt': ctx.attemptNo,
      'request.id': requestId,
    });
    const attemptTrace: AttemptTraceContext = { requestContext: requestTrace.requestContext, upSpan };
    try {
      const outcome = stream
        ? await this.attemptStream(
            auth,
            requestId,
            body,
            externalModel,
            target,
            channel,
            channelDesc,
            ctx,
            attemptTrace,
          )
        : await this.attemptNonStream(
            c,
            auth,
            requestId,
            body,
            externalModel,
            kind,
            target,
            channel,
            channelDesc,
            ctx,
            attemptTrace,
          );
      // 终态属性：上游真实状态码语义（成功 200 / 失败用映射后的错误码与状态）
      if (outcome.kind === 'success') {
        upSpan.setAttribute('http.status_code', 200);
      } else if (outcome.error) {
        upSpan.setAttributes({
          'http.status_code': outcome.error.status,
          'upstream.error_code': outcome.error.code,
        });
      }
      return outcome;
    } catch (err) {
      logger.error({ requestId, channel: channel.key, err }, 'candidate unexpected error');
      upSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      return {
        kind: 'switch',
        error: {
          code: 'upstream_error',
          message: '网关内部错误',
          status: 500,
          upstreamCharge: 'unknown',
        },
      };
    } finally {
      upSpan.end();
    }
  }

  /**
   * 流式尝试。ai 包契约：流开始前失败 → 返回含错误帧的流 + 重放 failed 事件
   * （onEvent 注册时同步重放），据此判断是否换渠道；流开始后的事件在流期间异步到达。
   */
  private async attemptStream(
    auth: AuthContext,
    requestId: string,
    body: Record<string, unknown>,
    externalModel: string,
    target: CandidateTarget,
    channel: ChannelCache,
    channelDesc: ChannelDesc,
    ctx: AttemptCtx,
    trace: AttemptTraceContext,
  ): Promise<AttemptOutcome> {
    const { ai, logger } = this.deps;
    const startedAt = Date.now();
    let ttfbRecorded = false;
    const handle = await ai.chatStream({ channel: channelDesc, request: body, ctx });
    const state: { failed: UpstreamError | null } = { failed: null };
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    handle.onEvent((e) => {
      // 首个上游事件 = TTFB（含建连；只记一次）
      if (!ttfbRecorded) {
        ttfbRecorded = true;
        trace.upSpan.setAttribute('upstream.ttfb_ms', Date.now() - startedAt);
      }
      if (e.type === 'failed') {
        state.failed = e.error;
      }
      if (e.type === 'success') {
        logger.info(
          {
            requestId,
            channel: channel.key,
            usage: e.usage,
            terminated: e.terminated,
            bytesRelayed: e.bytesRelayed,
          },
          'stream completed',
        );
        recordRequest(target.realModel, 200, e.durationMs);
        if (e.usage && !e.usage.estimated) {
          // usage 终值（span 已结束时为 no-op，最终真相在 billing.finalize）
          trace.upSpan.setAttributes({
            'usage.input_tokens': e.usage.inputTokens,
            'usage.cached_input_tokens': e.usage.cachedInputTokens,
            'usage.output_tokens': e.usage.outputTokens,
          });
        }
        if (!e.usage || e.usage.estimated) {
          const durable = this.deps.completions.track(
            this.recordUncertain(
              requestId,
              e.usage?.estimated
                ? 'stream_estimated_usage_not_billable'
                : `stream_${e.terminated ?? 'completed'}_without_usage`,
              trace,
            ),
          );
          void durable.then(resolveCompletion, rejectCompletion);
          return;
        }
        const durable = this.deps.completions.track(
          this.recordSuccess(
            this.makeReceipt(
              auth,
              requestId,
              externalModel,
              target,
              channel,
              e.usage,
              e.durationMs,
              !!e.terminated,
              true,
            ),
            trace,
          ),
        );
        void durable.then(resolveCompletion, rejectCompletion);
      }
    });

    if (state.failed && isChannelSwitchable(state.failed.code)) {
      logger.warn(
        { requestId, channel: channel.key, code: state.failed.code },
        'candidate failed, switching',
      );
      recordChannelFailure(channel.key);
      if (isDeadCredentialError(state.failed.code)) {
        void markChannelDeadCredential(
          this.deps.db,
          this.deps.router,
          channel.channelId,
          this.deps.logger,
        );
      }
      return {
        kind: 'switch',
        error: {
          code: state.failed.code,
          message: state.failed.message,
          status: 502,
          suggestion: state.failed.suggestion,
          upstreamCharge: this.upstreamCharge(state.failed.code),
        },
      };
    }

    if (state.failed) {
      return {
        kind: 'respond',
        response: sseResponse(handle.stream, requestId),
        error: {
          code: state.failed.code,
          message: state.failed.message,
          status: state.failed.status ?? 502,
          suggestion: state.failed.suggestion,
          upstreamCharge: this.upstreamCharge(state.failed.code),
        },
      };
    }

    // 关闭 SSE 前等待成功收据提交；入队只是提交后的 best-effort 唤醒。
    // 流先过模型名改写（对外只可见对外名），再进计费生命周期包装。
    return {
      kind: 'success',
      response: sseResponse(
        this.withBillingLifecycle(
          rewriteSseModel(handle.stream, externalModel),
          requestId,
          completion,
        ),
        requestId,
      ),
    };
  }

  /** 非流式尝试：成功 → 计量 + 透传上游响应；失败 → 换渠道或直接返回 */
  private async attemptNonStream(
    c: Context<AuthEnv>,
    auth: AuthContext,
    requestId: string,
    body: Record<string, unknown>,
    externalModel: string,
    kind: PipelineKind,
    target: CandidateTarget,
    channel: ChannelCache,
    channelDesc: ChannelDesc,
    ctx: AttemptCtx,
    trace: AttemptTraceContext,
  ): Promise<AttemptOutcome> {
    const { ai, logger } = this.deps;
    const result = await ai.chat({ channel: channelDesc, request: body, ctx });

    if (result.status === 'success') {
      logger.info({ requestId, channel: channel.key, usage: result.usage }, 'non-stream success');
      // 非流式：整响应一次到达，TTFB = 上游耗时；usage 终值此时已知
      trace.upSpan.setAttributes({
        'upstream.ttfb_ms': result.durationMs,
        ...(result.usage && !result.usage.estimated
          ? {
              'usage.input_tokens': result.usage.inputTokens,
              'usage.cached_input_tokens': result.usage.cachedInputTokens,
              'usage.output_tokens': result.usage.outputTokens,
            }
          : {}),
      });
      try {
        if (!result.usage || result.usage.estimated) {
          await this.recordUncertain(
            requestId,
            result.usage?.estimated
              ? 'nonstream_estimated_usage_not_billable'
              : 'nonstream_completed_without_usage',
            trace,
          );
        } else {
          await this.recordSuccess(
            this.makeReceipt(
              auth,
              requestId,
              externalModel,
              target,
              channel,
              result.usage,
              result.durationMs,
              false,
              false,
            ),
            trace,
          );
        }
      } catch (error) {
        logger.error(
          { requestId, err: error instanceof Error ? error.message : String(error) },
          'upstream succeeded but durable billing receipt failed',
        );
        // 上游已经成功，必须保留 reservation；返回错误响应但按 accepted 结束管线，
        // 后续租约恢复会把该请求转 uncertain，禁止 finally 误退款。
        return {
          kind: 'success',
          response: errorResponse(
            c,
            503,
            'billing_receipt_unavailable',
            '请求已完成，但账务收据暂时无法持久化',
            '请勿立即重试；请使用请求 ID 联系管理员确认结果',
          ),
        };
      }
      recordRequest(target.realModel, 200, result.durationMs);
      // 直接透传上游完整响应体（model 字段改写为对外名——白标）；缺失时给同构空信封
      const fallbackBody =
        kind === 'chat'
          ? {
              id: `chatcmpl-${requestId.slice(0, 24)}`,
              object: 'chat.completion',
              model: externalModel,
              choices: [],
            }
          : { model: externalModel, data: [], usage: {} };
      const relayed =
        result.body &&
        typeof result.body === 'object' &&
        typeof (result.body as { model?: unknown }).model === 'string'
          ? { ...result.body, model: externalModel }
          : result.body;
      return { kind: 'success', response: c.json(relayed ?? fallbackBody) };
    }

    const err = result.error;
    if (err && isChannelSwitchable(err.code)) {
      logger.warn(
        { requestId, channel: channel.key, code: err.code },
        'candidate failed, switching',
      );
      recordChannelFailure(channel.key);
      // 死凭据 → 写回 DB status=4（永久退出路由 + 管理端可见）
      if (isDeadCredentialError(err.code)) {
        void markChannelDeadCredential(
          this.deps.db,
          this.deps.router,
          channel.channelId,
          this.deps.logger,
        );
      }
      return {
        kind: 'switch',
        error: {
          code: err.code,
          message: err.message,
          status: err.status ?? 502,
          suggestion: err.suggestion,
          upstreamCharge: this.upstreamCharge(err.code),
        },
      };
    }
    // 不可换渠道的错误（4xx 客户端问题）→ 直接返回，状态码夹到 [400,600)
    const status =
      err?.status !== undefined && err.status >= 400 && err.status < 600 ? err.status : 502;
    return {
      kind: 'respond',
      response: errorResponse(
        c,
        status,
        err?.code ?? 'upstream_error',
        err?.message ?? '上游错误',
        err?.suggestion,
      ),
      error: {
        code: err?.code ?? 'upstream_error',
        message: err?.message ?? '上游错误',
        status,
        suggestion: err?.suggestion,
        upstreamCharge: this.upstreamCharge(err?.code),
      },
    };
  }

  private makeReceipt(
    auth: AuthContext,
    requestId: string,
    externalModel: string,
    target: CandidateTarget,
    channel: ChannelCache,
    usage: Usage,
    durationMs: number,
    streamAborted: boolean,
    stream: boolean,
  ): UsageReceipt {
    return {
      requestId,
      userId: auth.userId,
      apiKeyId: auth.apiKeyId,
      appId: auth.appId,
      credentialType: auth.credentialType,
      externalModel,
      realModel: target.realModel,
      channelId: channel.channelId,
      channelKey: channel.key,
      usage: {
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        estimated: usage.estimated,
      },
      inputPrice: target.inputPrice,
      outputPrice: target.outputPrice,
      cacheInputPrice: target.cacheInputPrice,
      coefficient: auth.coefficient,
      durationMs,
      stream,
      streamAborted,
      mappingId: target.mappingId,
      billingPolicyFingerprint: target.billingPolicyFingerprint,
    };
  }

  private upstreamCharge(code: string | undefined): 'none' | 'unknown' {
    return code &&
      [
        'invalid_api_key',
        'unauthorized',
        'forbidden',
        'rate_limited',
        'quota_exhausted',
        'model_not_found',
        'invalid_request',
        'circuit_open',
        'dead_credential',
        'empty_completion',
      ].includes(code)
      ? 'none'
      : 'unknown';
  }

  /** 先把不可变收据提交 PostgreSQL，再 best-effort 唤醒 worker。 */
  private async recordSuccess(
    receipt: UsageReceipt,
    trace?: RequestTraceContext,
  ): Promise<void> {
    const { billing, billingDispatcher, logger } = this.deps;
    // 收尾 span：流式生命周期可能晚于根 span 结束，显式以请求上下文为父保证同 trace
    const span = this.billingTracer.startSpan(
      'billing.finalize',
      {},
      trace?.requestContext,
    );
    try {
      const result = await billing.signal({
        type: 'request.succeeded',
        requestId: receipt.requestId,
        receipt,
      });
      if (result.status !== 'settlement_pending' && result.status !== 'settled') {
        span.setAttributes({
          'request.id': receipt.requestId,
          'billing.finalize': 'overrun_review',
          'billing.state': result.status,
        });
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'usage_exceeded_authorization' });
        logger.error(
          { requestId: receipt.requestId, billingStatus: result.status },
          'provider usage exceeded authorization; reservation frozen for review',
        );
        return;
      }
      span.setAttributes({
        'request.id': receipt.requestId,
        'billing.finalize': 'succeeded',
        'billing.state': result.status,
        'usage.input_tokens': receipt.usage.inputTokens,
        'usage.cached_input_tokens': receipt.usage.cachedInputTokens,
        'usage.output_tokens': receipt.usage.outputTokens,
        ...(receipt.usage.estimated ? { 'usage.estimated': true } : {}),
        'channel.final': receipt.channelKey,
        'ai.model': receipt.realModel,
        'request.duration_ms': receipt.durationMs,
        'request.stream': receipt.stream,
      });
      // DB 收据提交即完成正确性边界；Redis/BullMQ 唤醒不得延迟成功响应。
      void billingDispatcher.wake(receipt.requestId).then((wakeup) => {
        if (!wakeup.ok) {
          logger.warn(
            { requestId: receipt.requestId, err: wakeup.error?.message },
            'billing wakeup failed; DB drain will recover',
          );
          recordBillingWakeupFailed();
        }
      });
    } finally {
      span.end();
    }
  }

  /** 中断流缺少可信 usage 时保留预扣，等待供应商回执或人工审计。 */
  private async recordUncertain(
    requestId: string,
    reason: string,
    trace?: RequestTraceContext,
  ): Promise<void> {
    const span = this.billingTracer.startSpan('billing.finalize', {}, trace?.requestContext);
    try {
      span.setAttributes({ 'request.id': requestId, 'billing.finalize': 'uncertain', 'billing.uncertain_reason': reason });
      await this.deps.billing.signal({ type: 'request.uncertain', requestId, reason });
    } finally {
      span.end();
    }
  }

  /** 长流续租；底层流结束后先等待 durable receipt，再允许客户端看到 EOF。 */
  private withBillingLifecycle(
    stream: ReadableStream<Uint8Array>,
    requestId: string,
    completion: Promise<void>,
  ): ReadableStream<Uint8Array> {
    const billing = this.deps.billing;
    const rateLimiter = this.deps.rateLimiter;
    const leaseMs = this.deps.env.BILLING_LEASE_SECONDS * 1_000;
    let timer: ReturnType<typeof setInterval> | null = null;
    const clear = (): void => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    return stream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        start() {
          timer = setInterval(
            () => {
              void Promise.allSettled([
                billing.signal({
                  type: 'lease.renewed',
                  requestId,
                  leaseOwner: requestId,
                  leaseMs,
                }),
                rateLimiter.renewTpm(requestId),
              ]);
            },
            Math.max(1_000, Math.floor(leaseMs / 3)),
          );
          timer.unref?.();
        },
        transform(chunk, controller) {
          controller.enqueue(chunk);
        },
        async flush() {
          clear();
          await completion;
        },
        cancel() {
          clear();
        },
      }),
    );
  }
}

/** SSE 响应头（流式透传） */
function sseResponse(stream: ReadableStream<Uint8Array>, requestId: string): Response {
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-request-id': requestId,
    },
  });
}
