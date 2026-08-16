import type { Context } from 'hono';
import type { ChannelDesc, UpstreamError } from '@ai-gateway/ai';
import { estimateInputTokens } from '@ai-gateway/ai';
import { SpanStatusCode } from '@ai-gateway/core';
import type { Tracer } from '@opentelemetry/api';
import type { AttemptTraceContext, RequestTraceContext } from './trace-context.js';
import type { AuthContext, AuthEnv } from '../../middleware/auth.js';
import { errorResponse } from '../../lib/http.js';
import { rewriteSseModel } from '../../lib/sse-model-rewrite.js';
import { sanitizeUpstreamDetail } from '../../lib/upstream-error-sanitize.js';
import { recordChannelFailure, recordRequest } from '../../lib/metrics.js';
import {
  isChannelSwitchable,
  isDeadCredentialError,
  markChannelDeadCredential,
} from '../routing/channel-policy.js';
import type { ChannelCache } from '../routing/model-router.js';
import {
  channelError,
  sanitizeCtx,
  upstreamLeaseMs,
  type AttemptCtx,
  type AttemptOutcome,
  type CandidateTarget,
  type PipelineDeps,
  type PipelineKind,
} from './pipeline-shared.js';
import { asUserSideCancel } from './usage-estimator.js';
import type { RateGuards } from './rate-guards.js';
import type { BillingRecorder } from './billing-recorder.js';

/** 管线组件的 tracer 注入束（编排器创建一次，组件共享同源） */
export interface PipelineTracers {
  upstream: Tracer;
  billing: Tracer;
}

/**
 * 尝试执行器（组件化下沉）：单渠道尝试 = 渠道限流 → ai 包调用（流式/非流式）
 * → 终态 span 属性。流式含 stream.relay 生命周期、TTFB 锚定（first_chunk）、
 * 责任域分岔（用户侧取消 → 估算结算；上游故障 → uncertain）。
 */
export class AttemptRunner {
  constructor(
    private readonly deps: PipelineDeps,
    private readonly guards: RateGuards,
    private readonly recorder: BillingRecorder,
    private readonly tracers: PipelineTracers,
  ) {}

  async attempt(
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
    const { logger } = this.deps;

    // ---- 渠道级限流（保护上游 API key 配额；超限换下一个渠道）----
    const limited = await this.guards.checkChannelLimits(channel, estimatedTotalTokens, requestId);
    if (limited) {
      return { kind: 'switch', error: limited };
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
      // 租约覆盖整个请求预算（非流式无续期；deadline 是权威时间上界）
      leaseMs: upstreamLeaseMs(
        this.deps.env.BILLING_LEASE_SECONDS * 1_000,
        ctx.deadlineMs,
      ),
    });

    // 上游调用 Span（渠道级，OTel 链路追踪）
    const upSpan = this.tracers.upstream.startSpan(`upstream ${channel.providerName}`);
    upSpan.setAttributes({
      'channel.id': channel.channelId,
      'channel.key': channel.key,
      'ai.model': target.realModel,
      'ai.attempt_stream': stream,
      // 第几次渠道尝试（路线图节点显性化「换了 N 次渠」）
      'channel.attempt': ctx.attemptNo,
      'request.id': requestId,
    });
    const attemptTrace: AttemptTraceContext = {
      requestContext: requestTrace.requestContext,
      upSpan,
    };
    try {
      const outcome = stream
        ? await this.attemptStream(
            c,
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
        error: channelError('upstream_error', '网关内部错误', 500, 'unknown'),
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
    c: Context<AuthEnv>,
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
    // 流生命周期 span：根/upstream span 在 handler 返回（首包）即结束，而流式请求的
    // 业务生命周期延伸到流终止——取消/截断时刻只有本 span 覆盖（复核页查链路的依据）。
    const relayStartedAt = Date.now();
    const relaySpan = this.tracers.upstream.startSpan(
      'stream.relay',
      {
        attributes: {
          'request.id': requestId,
          'channel.key': channel.key,
          'ai.model': target.realModel,
        },
      },
      trace.requestContext,
    );
    const state: { failed: UpstreamError | null } = { failed: null };
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    handle.onEvent((e) => {
      // TTFB 只锚定 first_chunk（上游首字节流向客户端的权威时刻）。
      // 不得用「首个到达的事件」：本回调注册晚于流开始，其他事件（attempt_start 等）
      // 不可达、终态事件在流结束时才发——错锚会把 TTFB 记成终态时刻（c2dee8ff 教训）。
      if (e.type === 'first_chunk' && !ttfbRecorded) {
        ttfbRecorded = true;
        relaySpan.setAttribute('stream.ttfb_ms', Date.now() - startedAt);
      }
      if (e.type === 'failed') {
        state.failed = e.error;
        relaySpan.setAttributes({ 'upstream.error_code': e.error.code });
        relaySpan.end();
      }
      if (e.type === 'success') {
        // 流终态语义单一真相：终止原因/透传字节/usage 全落 relay span
        relaySpan.setAttributes({
          'stream.bytes_relayed': e.bytesRelayed ?? 0,
          'stream.duration_ms': Date.now() - relayStartedAt,
          ...(e.terminated ? { 'stream.terminated': e.terminated } : {}),
          ...(e.usage && !e.usage.estimated
            ? {
                'usage.input_tokens': e.usage.inputTokens,
                'usage.cached_input_tokens': e.usage.cachedInputTokens,
                'usage.output_tokens': e.usage.outputTokens,
              }
            : {}),
        });
        relaySpan.end();
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
        if (!e.usage || e.usage.estimated) {
          // 服务端 drain 中止：服务端责任 → 全额释放（不估算、不冻结）
          if (e.terminated === 'server_draining') {
            const durable = this.deps.completions.track(
              this.recorder.recordServerDrainRelease(requestId, trace),
            );
            void durable.then(resolveCompletion, rejectCompletion);
            return;
          }
          // 责任域分岔：用户侧取消 → 估算结算（billing.estimate 步骤节点）；
          // 上游故障/正常完成缺 usage → 保留预扣挂 uncertain（G1 不变量，不估算）。
          const userCancel = asUserSideCancel(e.terminated);
          if (userCancel) {
            const durable = this.deps.completions.track(
              this.recorder.recordEstimatedCancel({
                auth,
                requestId,
                externalModel,
                target,
                channel,
                reason: userCancel,
                bytesRelayed: e.bytesRelayed ?? 0,
                durationMs: e.durationMs,
                inputTokens: estimateInputTokens(body, {
                  providerName: channel.providerName,
                  model: target.realModel,
                }),
                maxOutputTokens: ctx.maxOutputTokens,
                trace,
              }),
            );
            void durable.then(resolveCompletion, rejectCompletion);
            return;
          }
          const durable = this.deps.completions.track(
            this.recorder.recordUncertain(
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
          this.recorder.recordSuccess(
            this.recorder.makeReceipt(
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
      if (isDeadCredentialError(state.failed)) {
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
          upstreamCharge: this.recorder.upstreamCharge(state.failed.code),
        },
      };
    }

    if (state.failed) {
      // 首字节前失败（failEarly 的 failed 事件在 onEvent 注册时同步重放）：
      // 客户端尚未收到任何字节——返回真实状态码 + JSON 错误体（OpenAI 官方
      // 语义）。不得 200 + SSE 错误帧：标准 SDK 按 HTTP 状态判定成败。
      void handle.stream.cancel().catch(() => {});
      const status =
        state.failed.code === 'aborted'
          ? 408 // 重试预算耗尽/请求中止（与管线入口的 request_cancelled 408 同语义）
          : state.failed.status !== undefined &&
              state.failed.status >= 400 &&
              state.failed.status < 600
            ? state.failed.status
            : 502;
      const safeMessage = sanitizeUpstreamDetail(
        state.failed.message,
        sanitizeCtx(externalModel, target, channel),
      );
      return {
        kind: 'respond',
        response: errorResponse(c, status, state.failed.code, safeMessage, state.failed.suggestion),
        error: {
          code: state.failed.code,
          message: safeMessage,
          status,
          suggestion: state.failed.suggestion,
          upstreamCharge: this.recorder.upstreamCharge(state.failed.code),
        },
      };
    }

    // 关闭 SSE 前等待成功收据提交；入队只是提交后的 best-effort 唤醒。
    // 流先过模型名改写（对外只可见对外名），再进计费生命周期包装。
    return {
      kind: 'success',
      response: sseResponse(
        this.recorder.withBillingLifecycle(
          rewriteSseModel(handle.stream, externalModel, (frame) => {
            const sctx = sanitizeCtx(externalModel, target, channel);
            if (frame.error && typeof frame.error === 'object' && frame.error !== null) {
              const e = frame.error as { message?: unknown };
              if (typeof e.message === 'string')
                e.message = sanitizeUpstreamDetail(e.message, sctx);
            } else if (typeof frame.message === 'string') {
              frame.message = sanitizeUpstreamDetail(frame.message, sctx);
            }
            return frame;
          }),
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
          await this.recorder.recordUncertain(
            requestId,
            result.usage?.estimated
              ? 'nonstream_estimated_usage_not_billable'
              : 'nonstream_completed_without_usage',
            trace,
          );
        } else {
          await this.recorder.recordSuccess(
            this.recorder.makeReceipt(
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
      if (isDeadCredentialError(err)) {
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
          upstreamCharge: this.recorder.upstreamCharge(err.code),
        },
      };
    }
    // 不可换渠道的错误（4xx 客户端问题）→ 直接返回，状态码夹到 [400,600)
    const status =
      err?.status !== undefined && err.status >= 400 && err.status < 600 ? err.status : 502;
    const safeMessage = sanitizeUpstreamDetail(
      err?.message,
      sanitizeCtx(externalModel, target, channel),
    );
    return {
      kind: 'respond',
      response: errorResponse(
        c,
        status,
        err?.code ?? 'upstream_error',
        safeMessage,
        err?.suggestion,
      ),
      error: {
        code: err?.code ?? 'upstream_error',
        message: safeMessage,
        status,
        suggestion: err?.suggestion,
        upstreamCharge: this.recorder.upstreamCharge(err?.code),
      },
    };
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
