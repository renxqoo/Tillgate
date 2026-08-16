import type { Context } from 'hono';
import { createHash } from 'node:crypto';
import { estimateInputTokens } from '@ai-gateway/ai';
import { Decimal, estimateMaxCost } from '@ai-gateway/money';
import { context as otelContext, trace as otelTrace } from '@opentelemetry/api';
import { formatTraceParent, getTracer, SpanStatusCode } from '@ai-gateway/core';
import type { RequestTraceContext } from './trace-context.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { errorResponse } from '../../lib/http.js';
import { isModelAllowed } from '../../lib/model-scope.js';
import { ServiceDrainingError } from '../runtime/request-lifecycle.js';
import {
  analyzeMultimodalRequest,
  authorizeMultimodalQuote,
  MultimodalQuoteError,
} from '../billing/multimodal-quote-policy.js';
import type { MappingCache } from '../routing/model-router.js';

/**
 * LLM 请求管线编排器（chat/completions 与 embeddings 共享，杜绝两路由漂移）：
 *
 *   scope 校验 → 限流(RPM: global/user/key/app → 模型级) → TPM 预检查
 *   → 候选定价（主模型 + fallback）→ billing_requests 足额授权
 *   → 候选循环[渠道级限流 → ai 包调用 → 换渠道/死凭据持久化]
 *   → 成功收据先落 DB → 队列只做结算唤醒；失败按请求级状态释放
 *
 * 组件化（同目录）：pipeline-shared（契约）→ authorize-rejection（拒绝翻译）
 *   → rate-guards（限流）→ billing-recorder（收尾）→ attempt-runner（执行）。
 * 计费语义（requirements 5.11）：durable receipt 携带实际成功渠道价格快照；
 *   任意成功响应缺少可信 usage → uncertain；估算值只用于授权，绝不进入资金结算。
 */

// 对外表面保持不变（app.ts 只 import LlmPipeline/PipelineKind/PipelineDeps）
export type { PipelineKind, PipelineDeps } from './pipeline-shared.js';
import {
  channelError,
  maxOutputTokens,
  type AttemptCtx,
  type CandidateTarget,
  type ChannelError,
  type PipelineDeps,
  type PipelineKind,
} from './pipeline-shared.js';
import { mapAuthorizeRejection, type AuthorizeRejection } from './authorize-rejection.js';
import { RateGuards } from './rate-guards.js';
import { BillingRecorder } from './billing-recorder.js';
import { AttemptRunner, type PipelineTracers } from './attempt-runner.js';

export class LlmPipeline {
  private readonly upstreamTracer = getTracer('gateway.upstream');
  private readonly billingTracer = getTracer('gateway.billing');
  private readonly tracers: PipelineTracers;

  private readonly guards: RateGuards;
  private readonly recorder: BillingRecorder;
  private readonly attempts: AttemptRunner;

  constructor(private readonly deps: PipelineDeps) {
    this.tracers = { upstream: this.upstreamTracer, billing: this.billingTracer };
    this.guards = new RateGuards(deps);
    this.recorder = new BillingRecorder(deps, this.tracers);
    this.attempts = new AttemptRunner(deps, this.guards, this.recorder, this.tracers);
  }

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
    const runStartedAt = Date.now();
    let budget: ReturnType<typeof this.deps.lifecycle.create>;
    try {
      budget = this.deps.lifecycle.create(c.req.raw.signal);
    } catch (error) {
      // drain 期间拒绝新请求（在途请求不受影响，见 request-lifecycle）
      if (error instanceof ServiceDrainingError) {
        return errorResponse(c, 503, 'server_draining', '服务正在发布维护，请稍后重试');
      }
      throw error;
    }
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

    // 输入 token 估算（单一真相：TPM 预占 + 预扣共用，见 ai/token-estimate.ts）。
    // 预扣阶段尚未选渠道，用全局权重（无 provider 覆盖/template 偏移）。
    // 口径决策（2026-08 拍板）：预扣用校准估算而非「字符数上界」——预扣不再是
    // 敞口硬上界（估算偏小 → 结算实扣可超预扣），敞口由信用模型（credit_limit）
    // 与 settle 按 calculated 实扣兜底。选择接受该平台敞口以换取更少的资金占用。
    const estInput = estimateInputTokens(body);

    // ---- 请求 + 模型 RPM 一次原子判定；后维拒绝不会污染前维窗口。 ----
    const rpmDims = this.guards.buildRpmDims(auth);
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
        estInput,
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
    const outputCap = maxOutputTokens(kind, body, this.deps.env.GATEWAY_OUTPUT_EXPOSURE_CAP);
    const estimatedTotalTokens = estInput + outputCap;
    const tpmDims = this.guards.buildTpmDims(auth, mapping, estimatedTotalTokens);
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
    // ---- 免费模型独立日限额：0 元授权不占每日花费上限（amount=0），需独立请求数闸防滥用。
    // 计数器不可用（Redis 故障）fail-closed → 503：此闸是免费链路唯一防线 ----
    if (mapping.isFree && this.deps.env.FREE_MODEL_DAILY_LIMIT > 0) {
      const free = await this.guards.checkFreeDailyLimit(auth.userId);
      if (!free.ok) {
        // 本闸位于 TPM 预占之后、try/finally 之前——拒绝路径必须显式释放
        // TPM 预占（否则占满窗口至 600s TTL；被拒请求不占窗口，与 RPM 层同语义）
        await this.releaseTpmQuietly(requestId);
        c.header('retry-after', String(free.retryAfterSec));
        if (free.code === 'free_model_daily_limit_exceeded') {
          return errorResponse(
            c,
            429,
            free.code,
            `免费模型每日请求数已达上限（${this.deps.env.FREE_MODEL_DAILY_LIMIT} 次/天）`,
            `请明日再试或联系管理员调整限额`,
          );
        }
        return errorResponse(
          c,
          503,
          free.code,
          '免费模型计数服务暂不可用，为防滥用已暂停免费模型请求',
          '请稍后重试',
        );
      }
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
        appId: auth.appId,
        stream,
        traceParent,
        reservationLimit: String(env.BILLING_RESERVATION_MAX),
        authorizationTtlMs: env.BILLING_AUTHORIZATION_TTL_SECONDS * 1_000,
        quote: {
          maxOutputTokens: outputCap,
          // 整条候选链（主模型 + fallback）全部为显式免费模型才允许 0 元授权；
          // 任一 fallback 收费则按最贵候选正常预扣，杜绝免费主模型降到收费模型后透支。
          explicitlyFree: targets.length > 0 && targets.every((t) => t.isFree),
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
      // 授权拒绝统一翻译（表驱动单一真相；null=未分类服务端故障）
      const rejection = mapAuthorizeRejection(error, {
        maxEstimate: maxEstimate.toString(),
        reservationMax: String(env.BILLING_RESERVATION_MAX),
      });
      if (!rejection) {
        await this.releaseTpmQuietly(requestId);
        throw error;
      }
      authSpan.setAttributes({
        'billing.result': 'rejected',
        'billing.reject_code': rejection.code,
        'billing.amount_required': maxEstimate.toString(),
      });
      authSpan.setStatus({ code: SpanStatusCode.ERROR, message: rejection.code });
      if (rejection.log) {
        logger.error(
          { requestId, ...rejection.log },
          'billing settlement backlog closed admission',
        );
      }
      return this.rejectAuthorized(c, requestId, rejection);
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
      for (const [targetIdx, target] of targets.entries()) {
        // G3：fallback 模型的限流维收口（主渠道全挂才走到这；超限→换候选）
        if (targetIdx > 0) {
          const fbLimited = await this.guards.reserveFallbackDims(
            auth,
            target,
            estimatedTotalTokens,
            requestId,
          );
          if (fbLimited) {
            lastError = fbLimited;
            continue;
          }
        }
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
            lastError = channelError('channel_budget_exhausted', '渠道额度不足');
            continue;
          }
          if (!reservation.allowed) {
            logger.warn(
              { requestId, channel: channel.key, remaining: reservation.remaining },
              'channel upstream budget exhausted, skipping',
            );
            lastError = channelError('channel_budget_exhausted', '渠道额度不足');
            continue;
          }
          const ctx: AttemptCtx = {
            requestId,
            model: target.realModel,
            providerName: channel.providerName,
            attemptNo,
            endpoint: kind === 'embeddings' ? 'embeddings' : undefined,
            paramRules: target.paramRules ?? undefined,
            maxOutputTokens: outputCap,
            // 每次 fallback 只拿整个请求预算的剩余值，绝不重置 deadline。
            deadlineMs: budget.remainingMs(),
            signal: budget.signal,
          };
          logger.info(
            { requestId, channel: channel.key, model: target.realModel, stream },
            'candidate attempt',
          );
          const outcome = await this.attempts.attempt(
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
            if (outcome.error.code === 'aborted') {
              // 用户侧取消（TTFB 期，一个数据块未流动）：仅 input 估算结算，
              // 不走 request.failed（bytesRelayed=0 → output 估算为 0）。
              deliveryAccepted = true;
              releaseTpm = false;
              void this.deps.completions.track(
                this.recorder.recordEstimatedCancel({
                  auth,
                  requestId,
                  externalModel: model,
                  target,
                  channel,
                  reason: 'aborted',
                  bytesRelayed: 0,
                  durationMs: Date.now() - runStartedAt,
                  inputTokens: estimateInputTokens(body, {
                    providerName: channel.providerName,
                    model: target.realModel,
                  }),
                  maxOutputTokens: outputCap,
                  trace: requestTrace,
                }),
              );
              return outcome.response;
            }
            return outcome.response;
          }
          lastError = outcome.error;
          if (outcome.error.upstreamCharge === 'unknown') upstreamChargeUnknown = true;
          if (budget.signal.aborted) break;
        }
      }

      // 全部候选耗尽 → 503。message 用通用文案（上游原文可能带真实模型名/
      // 供应商细节）；code 统一 no_available_channel——内部失败原因
      // （circuit_open/dead_credential/channel_budget_exhausted…）泄漏渠道
      // 拓扑语义，只进日志与 trace，不出站。
      if (lastError) {
        logger.warn(
          { requestId, model, code: lastError.code, channelHint: 'see trace' },
          'all candidates exhausted',
        );
      }
      const message = `模型「${model}」所有渠道均不可用`;
      return errorResponse(c, 503, 'no_available_channel', message, lastError?.suggestion);
    } finally {
      if (!deliveryAccepted) {
        // 失败路径收尾 span：request.failed 是 billing 侧终态信号（uncertain/released），
        // 与 recordSuccess/recordUncertain 的 finalize 同级——没有它失败 trace 无收尾节点。
        const finalizeSpan = this.billingTracer.startSpan(
          'billing.finalize',
          {},
          requestTrace.requestContext,
        );
        const failReason = lastError?.code ?? 'request_failed_before_delivery';
        finalizeSpan.setAttributes({
          'request.id': requestId,
          'billing.finalize': 'failed',
          'billing.failure_reason': failReason,
        });
        try {
          await billing.signal({
            type: 'request.failed',
            requestId,
            reason: failReason,
            delivery: 'none',
            upstreamCharge: upstreamChargeUnknown ? 'unknown' : 'none',
          });
        } catch (e) {
          logger.warn({ requestId, err: (e as Error).message }, 'billing failure signal failed');
        } finally {
          finalizeSpan.end();
        }
        if (releaseTpm && !upstreamChargeUnknown) {
          await this.releaseTpmQuietly(requestId);
        }
      }
      budget.dispose();
    }
  }

  /** 授权拒绝的统一出口：释放 TPM 预占（已拒绝的请求不占窗口）+ 语义化响应。
   *  授权阶段每条拒绝路径都必须走这里——releaseTpm 遗漏会让被拒请求永久占住 TPM 窗口。 */
  private async rejectAuthorized(
    c: Context<AuthEnv>,
    requestId: string,
    rejection: AuthorizeRejection,
  ): Promise<Response> {
    await this.releaseTpmQuietly(requestId);
    return errorResponse(
      c,
      rejection.status,
      rejection.code,
      rejection.message,
      rejection.suggestion,
    );
  }

  /** TPM 预占释放（best-effort：Redis 故障不得阻塞计费/响应主路径）。全文件唯一实现。 */
  private releaseTpmQuietly(requestId: string): Promise<void> {
    return this.deps.rateLimiter.releaseTpm(requestId).catch(() => {});
  }

  // ---- 限流维度构建（集中管理，杜绝两路由维度漂移）----

  /** 候选目标解析：价格预取（预扣需要），fallback 渠道列表 lazy */
  private async resolveTargets(
    kind: PipelineKind,
    body: Record<string, unknown>,
    mapping: MappingCache,
    inputTokenEstimate: number,
    multimodal: ReturnType<typeof analyzeMultimodalRequest>,
    coefficient: string,
  ): Promise<CandidateTarget[]> {
    const targets: CandidateTarget[] = [];
    const addTarget = (m: MappingCache): void => {
      const candidateInputUpperBound = Math.max(
        inputTokenEstimate,
        authorizeMultimodalQuote(multimodal, m.billingPolicy),
      );
      const outputCap = maxOutputTokens(kind, body, this.deps.env.GATEWAY_OUTPUT_EXPOSURE_CAP);
      const estimate = estimateMaxCost({
        estimatedInputTokens: candidateInputUpperBound,
        maxOutputTokens: outputCap,
        inputPrice: m.inputPrice,
        cacheInputPrice: m.cacheInputPrice,
        outputPrice: kind === 'chat' ? m.outputPrice : 0,
        coefficient,
      });
      // 上游成本 = 官方价 × 上界（系数=1），与 settle.ts 的 upstream_cost 同口径
      const upstreamEstimate = estimateMaxCost({
        estimatedInputTokens: candidateInputUpperBound,
        maxOutputTokens: outputCap,
        inputPrice: m.inputPrice,
        cacheInputPrice: m.cacheInputPrice,
        outputPrice: kind === 'chat' ? m.outputPrice : 0,
        coefficient: '1',
      });
      targets.push({
        realModel: m.realModel,
        mappingId: m.id,
        rpmLimit: m.rpmLimit,
        tpmLimit: m.tpmLimit,
        inputPrice: m.inputPrice,
        outputPrice: m.outputPrice,
        cacheInputPrice: m.cacheInputPrice,
        paramRules: m.paramRules,
        billingPolicy: m.billingPolicy,
        billingPolicyFingerprint: m.billingPolicy
          ? createHash('sha256').update(JSON.stringify(m.billingPolicy)).digest('hex')
          : null,
        isFree: m.isFree,
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
}
