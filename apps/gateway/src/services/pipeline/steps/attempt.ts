import type { Context } from 'hono';
import type { ChannelDesc, UpstreamError } from '@ai-gateway/ai';
import {
  estimateInputTokens,
  estimateUsage,
  generationKindDescriptor,
  isTaskKind,
  type GenerationKind,
} from '@ai-gateway/ai';
import { isModalityKind, modalityUsage } from '../../modality-usage.js';
import { SpanStatusCode } from '@ai-gateway/core';
import { upstreamPassthroughReject, type GatewayReject } from '../../../lib/errors.js';
import { renderReject } from '../../../lib/http.js';
import { rewriteSseModel } from '../../../lib/sse-model-rewrite.js';
import { sanitizeUpstreamDetail } from '../../../lib/upstream-error-sanitize.js';
import { recordChannelFailure, recordRequest } from '../../../lib/metrics.js';
import {
  isChannelSwitchable,
  isDeadCredentialError,
  markChannelDeadCredential,
} from '../../routing/channel-policy.js';
import type { ChannelCache } from '../../routing/model-router.js';
import type { AuthContext, AuthEnv } from '../../../middleware/auth.js';
import {
  channelError,
  sanitizeCtx,
  upstreamLeaseMs,
  type AttemptCtx,
  type AttemptOutcome,
  type AttemptTraceContext,
  type CandidateTarget,
  type PipelineDeps,
  type PipelineKind,
  type PipelineTracers,
  type RequestTraceContext,
} from '../types.js';
import { checkChannelLimits } from './rate-limit.js';
import {
  asUserSideCancel,
  makeReceipt,
  recordEstimatedOutcome,
  recordReleasedFailure,
  recordSuccess,
  recordTaskSubmitted,
  upstreamCharge,
  withBillingLifecycle,
} from './finalize.js';

/**
 * 第五步（执行器）：单渠道尝试 = 渠道限流 → ai 包调用（流式/非流式）
 * → 终态 span 属性。流式含 stream.relay 生命周期、TTFB 锚定（first_chunk）、
 * 责任域三分岔（取消/完成缺 usage → 估算结算；上游异常 → 释放不扣）。
 */

export interface AttemptArgs {
  c: Context<AuthEnv>;
  auth: AuthContext;
  requestId: string;
  body: Record<string, unknown>;
  externalModel: string;
  estimatedTotalTokens: number;
  kind: PipelineKind;
  target: CandidateTarget;
  channel: ChannelCache;
  ctx: AttemptCtx;
  stream: boolean;
  requestTrace: RequestTraceContext;
}

export async function attemptChannel(
  deps: PipelineDeps,
  tracers: PipelineTracers,
  args: AttemptArgs,
): Promise<AttemptOutcome> {
  const { requestId, target, channel, ctx, stream, kind } = args;
  const { logger } = deps;

  // ---- 渠道级限流（保护上游 API key 配额；超限换下一个渠道）----
  const limited = await checkChannelLimits(deps, channel, args.estimatedTotalTokens, requestId);
  if (limited) {
    return { kind: 'switch', error: limited };
  }

  const channelDesc: ChannelDesc = {
    baseUrl: channel.baseUrl,
    apiKey: channel.apiKey,
    protocol: channel.protocol,
  };

  // ---- 任务族（execution ≠ sync）：提交即返回。upstream.started（带 TTL 租约）在
  // recordTaskSubmitted 内与任务行同序落库，不走下面的同步请求租约。----
  if (isTaskKind(kind)) {
    const upSpan = tracers.upstream.startSpan(`upstream ${channel.providerName}`);
    upSpan.setAttributes({
      'channel.id': channel.channelId,
      'channel.key': channel.key,
      'ai.model': target.realModel,
      'channel.attempt': ctx.attemptNo,
      'request.id': requestId,
      'generation.kind': kind,
    });
    try {
      const outcome = await attemptTaskSubmit(deps, tracers, {
        ...args,
        channelDesc,
        trace: { requestContext: args.requestTrace.requestContext, upSpan },
      });
      if (outcome.kind === 'success') {
        upSpan.setAttribute('http.status_code', 201);
      } else if (outcome.error) {
        upSpan.setAttributes({
          'http.status_code': outcome.error.status,
          'upstream.error_code': outcome.error.code,
        });
        upSpan.setStatus({ code: SpanStatusCode.ERROR, message: outcome.error.code });
      }
      return outcome;
    } catch (err) {
      logger.error({ requestId, channel: channel.key, err }, 'generation submit unexpected error');
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

  await deps.billing.signal({
    type: 'upstream.started',
    requestId,
    leaseOwner: requestId,
    // 租约覆盖整个请求预算（非流式无续期；deadline 是权威时间上界）
    leaseMs: upstreamLeaseMs(deps.env.BILLING_LEASE_SECONDS * 1_000, ctx.deadlineMs),
  });

  // 上游调用 Span（渠道级，OTel 链路追踪）
  const upSpan = tracers.upstream.startSpan(`upstream ${channel.providerName}`);
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
    requestContext: args.requestTrace.requestContext,
    upSpan,
  };
  try {
    const outcome = stream
      ? await attemptStream(deps, tracers, {
          ...args,
          channelDesc,
          trace: attemptTrace,
        })
      : await attemptNonStream(deps, tracers, {
          ...args,
          channelDesc,
          trace: attemptTrace,
        });
    // 终态属性：上游真实状态码语义（成功 200 / 失败用映射后的错误码与状态）
    if (outcome.kind === 'success') {
      upSpan.setAttribute('http.status_code', 200);
    } else if (outcome.error) {
      upSpan.setAttributes({
        'http.status_code': outcome.error.status,
        'upstream.error_code': outcome.error.code,
      });
      // 失败尝试必须在 span 状态上可见（图谱标红 + errorText=错误码）；
      // aborted 是用户侧取消，按链路政策不标红（graph.ts 口径）。
      if (outcome.error.code !== 'aborted') {
        upSpan.setStatus({ code: SpanStatusCode.ERROR, message: outcome.error.code });
      }
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
async function attemptStream(
  deps: PipelineDeps,
  tracers: PipelineTracers,
  args: AttemptArgs & {
    channelDesc: ChannelDesc;
    trace: AttemptTraceContext;
  },
): Promise<AttemptOutcome> {
  const { c, auth, requestId, body, externalModel, target, channel, channelDesc, ctx, trace } =
    args;
  const { ai, logger } = deps;
  const startedAt = Date.now();
  let ttfbRecorded = false;
  const handle = await ai.chatStream({ channel: channelDesc, request: body, ctx });
  // 流生命周期 span：根/upstream span 在 handler 返回（首包）即结束，而流式请求的
  // 业务生命周期延伸到流终止——取消/截断时刻只有本 span 覆盖（复核页查链路的依据）。
  const relayStartedAt = Date.now();
  const relaySpan = tracers.upstream.startSpan(
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
      // aborted（用户侧取消）不标红，其余失败在 span 状态上留痕
      if (e.error.code !== 'aborted') {
        relaySpan.setStatus({ code: SpanStatusCode.ERROR, message: e.error.code });
      }
      relaySpan.end();
    }
    if (e.type === 'success') {
      // 流终态语义单一真相：终止原因/透传字节/usage 全落 relay span
      relaySpan.setAttributes({
        'stream.bytes_relayed': e.bytesRelayed ?? 0,
        'stream.duration_ms': Date.now() - relayStartedAt,
        ...(e.terminated ? { 'stream.terminated': e.terminated } : {}),
        // 终止细节（2026-08-17 留痕）：事后可判「自然完成」vs「终止帧后断开」
        ...(e.doneSentinel !== undefined ? { 'stream.done_sentinel': e.doneSentinel } : {}),
        ...(e.terminalFrame !== undefined ? { 'stream.terminal_frame': e.terminalFrame } : {}),
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
        // 2026-08-17 政策三分岔（估算结算拍板后 uncertain 冻结路径删除）：
        //   服务端 drain → 释放（平台吸收）；
        //   用户取消 / 正常完成缺 usage → 估算结算（billing.estimate 步骤节点）；
        //   上游服务端异常（超时/5xx/截断/断连/静默）→ 释放不扣（用户未获完整服务）。
        const inputTokens = estimateInputTokens(body, {
          providerName: channel.providerName,
          model: target.realModel,
        });
        const estimateOutcome = (reason: Parameters<typeof recordEstimatedOutcome>[2]['reason']) => {
          const durable = deps.completions.track(
            recordEstimatedOutcome(deps, tracers, {
              auth,
              requestId,
              externalModel,
              target,
              channel,
              reason,
              bytesRelayed: e.bytesRelayed ?? 0,
              durationMs: e.durationMs,
              inputTokens,
              maxOutputTokens: ctx.maxOutputTokens,
              trace,
            }),
          );
          void durable.then(resolveCompletion, rejectCompletion);
        };
        if (e.terminated === 'server_draining') {
          const durable = deps.completions.track(
            recordReleasedFailure(deps, tracers, requestId, 'server_draining', trace),
          );
          void durable.then(resolveCompletion, rejectCompletion);
          return;
        }
        const userCancel = asUserSideCancel(e.terminated);
        if (userCancel) {
          estimateOutcome(userCancel);
          return;
        }
        if (e.terminated === undefined) {
          // 正常完成（终止帧已到）但缺 usage：上游已真实计费 → 按已交付估算结算
          estimateOutcome('usage_missing_completed');
          return;
        }
        // 其余 terminated（upstream_*/inactivity）= 上游服务端异常 → 释放
        const durable = deps.completions.track(
          recordReleasedFailure(deps, tracers, requestId, e.terminated, trace),
        );
        void durable.then(resolveCompletion, rejectCompletion);
        return;
      }
      const durable = deps.completions.track(
        recordSuccess(
          deps,
          tracers,
          makeReceipt(
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
      void markChannelDeadCredential(deps.db, deps.router, channel.channelId, deps.logger);
    }
    return {
      kind: 'switch',
      error: {
        code: state.failed.code,
        message: state.failed.message,
        status: 502,
        suggestion: state.failed.suggestion,
        upstreamCharge: upstreamCharge(state.failed.code),
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
    // 上游 4xx 客户端问题：OpenAI 兼容语义原码透传（白名单校验 + sanitize 后）
    const passthrough =
      status >= 400 && status < 500
        ? upstreamPassthroughReject({
            code: state.failed.code,
            status,
            message: safeMessage,
            suggestion: state.failed.suggestion,
          })
        : null;
    const rejectPayload: GatewayReject =
      passthrough ?? {
        code: state.failed.code,
        status,
        message: safeMessage,
        suggestion: state.failed.suggestion,
      };
    return {
      kind: 'respond',
      response: renderReject(c, rejectPayload),
      error: {
        code: state.failed.code,
        message: safeMessage,
        status,
        suggestion: state.failed.suggestion,
        upstreamCharge: upstreamCharge(state.failed.code),
      },
    };
  }

  // 关闭 SSE 前等待成功收据提交；入队只是提交后的 best-effort 唤醒。
  // 流先过模型名改写（对外只可见对外名），再进计费生命周期包装。
  return {
    kind: 'success',
    response: sseResponse(
      withBillingLifecycle(
        deps,
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
async function attemptNonStream(
  deps: PipelineDeps,
  tracers: PipelineTracers,
  args: AttemptArgs & {
    channelDesc: ChannelDesc;
    trace: AttemptTraceContext;
  },
): Promise<AttemptOutcome> {
  const { c, auth, requestId, body, externalModel, kind, target, channel, channelDesc, ctx, trace } =
    args;
  const { ai, logger } = deps;
  // multipart 模态端点：wrapper.upstreamForm 是重组好的上游 FormData（字节原样）
  const upstreamRequest =
    args.body.upstreamForm instanceof FormData ? args.body.upstreamForm : args.body;
  const result = await ai.chat({ channel: channelDesc, request: upstreamRequest, ctx });

  if (result.status === 'success') {
    logger.info({ requestId, channel: channel.key, usage: result.usage }, 'non-stream success');
    // 二进制响应（audio_speech）：计费收据（units 由模态计量源给出）后原样字节透传
    if (result.rawBody) {
      const usage = modalityUsage(kind as never, args.body, null);
      await recordSuccess(
        deps,
        tracers,
        makeReceipt(auth, requestId, externalModel, target, channel, usage, result.durationMs, false, false),
        trace,
      );
      recordRequest(target.realModel, 200, result.durationMs);
      return {
        kind: 'success',
        response: new Response(result.rawBody, {
          headers: {
            'content-type': result.rawContentType ?? 'application/octet-stream',
            'x-request-id': requestId,
          },
        }),
      };
    }
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
      if (isModalityKind(kind) && kind !== 'audio_speech') {
        // 模态端点计量：units 从响应体/请求体提取（images 张数等），不走 token 估算
        const usage = modalityUsage(kind, args.body, result.body);
        await recordSuccess(
          deps,
          tracers,
          makeReceipt(auth, requestId, externalModel, target, channel, usage, result.durationMs, false, false),
          trace,
        );
      } else if (!result.usage || result.usage.estimated) {
        // 2026-08-17 政策：非流式完成缺 usage → 按请求体+响应体估算结算
        //（estimateUsage 单一真相；estimatedFor=usage_missing_nonstream 留痕）
        const estimated = estimateUsage(body, result.body, {
          providerName: channel.providerName,
          model: target.realModel,
        });
        await recordEstimatedOutcome(deps, tracers, {
          auth,
          requestId,
          externalModel,
          target,
          channel,
          reason: 'usage_missing_nonstream',
          usage: estimated,
          durationMs: result.durationMs,
          inputTokens: estimated.inputTokens,
          maxOutputTokens: ctx.maxOutputTokens,
          trace,
        });
      } else {
        await recordSuccess(
          deps,
          tracers,
          makeReceipt(
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
      // 后续租约恢复会按崩溃口径释放该请求，禁止 finally 误退款。
      return {
        kind: 'success',
        response: renderReject(c, {
          code: 'billing_receipt_unavailable',
          status: 503,
          message: '请求已完成，但账务收据暂时无法持久化',
          suggestion: '请勿立即重试；请使用请求 ID 联系管理员确认结果',
        }),
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
        : kind === 'images' || kind === 'images_edits'
          ? { created: Math.floor(Date.now() / 1000), data: [] }
          : kind === 'moderations'
            ? { id: requestId, model: externalModel, results: [] }
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
      void markChannelDeadCredential(deps.db, deps.router, channel.channelId, deps.logger);
    }
    return {
      kind: 'switch',
      error: {
        code: err.code,
        message: err.message,
        status: err.status ?? 502,
        suggestion: err.suggestion,
        upstreamCharge: upstreamCharge(err.code),
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
  // 上游 4xx：OpenAI 兼容语义原码透传（白名单 + sanitize）；5xx/畸形码收敛注册表码
  const passthrough =
    status >= 400 && status < 500
      ? upstreamPassthroughReject({
          code: err?.code ?? 'upstream_error',
          status,
          message: safeMessage,
          suggestion: err?.suggestion,
        })
      : null;
  return {
    kind: 'respond',
    response: renderReject(
      c,
      passthrough ?? {
        code: err?.code ?? 'upstream_error',
        status,
        message: safeMessage,
        suggestion: err?.suggestion,
      },
    ),
    error: {
      code: err?.code ?? 'upstream_error',
      message: safeMessage,
      status,
      suggestion: err?.suggestion,
      upstreamCharge: upstreamCharge(err?.code),
    },
  };
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

/**
 * 任务族尝试（video/music）：
 *   video —— 调上游提交（ai.chat endpoint=video）→ 解析 task_id →
 *            recordTaskSubmitted（任务行 + TTL 租约）→ 201 {id, task_id, status}
 *   music —— 不调上游（同步阻塞型，由 worker 代执行）：直接登记任务 → 201
 * 失败语义与同步尝试一致：可换渠道错误 → switch（上层换渠道/候选）；
 * 4xx 客户端问题 → 原样透传；任务行落库失败 → 503（预留保留，禁止误退款）。
 */
async function attemptTaskSubmit(
  deps: PipelineDeps,
  tracers: PipelineTracers,
  args: AttemptArgs & {
    channelDesc: ChannelDesc;
    trace: AttemptTraceContext;
  },
): Promise<AttemptOutcome> {
  const { c, auth, requestId, body, externalModel, kind, target, channel, channelDesc, ctx, trace } =
    args;
  const { ai, logger } = deps;
  const startedAt = Date.now();
  const descriptor = generationKindDescriptor(kind);
  if (!descriptor?.snapshotParams) {
    // 词表单一真相在描述符注册表：任务 kind 必有描述符与快照白名单
    return {
      kind: 'switch',
      error: channelError('upstream_error', `未知生成类型 ${kind}`, 500, 'unknown'),
    };
  }
  // units 单一真相：预扣上界（resolve）与结算快照同一实现（descriptors.ts）
  const units = descriptor.unitsUpperBoundOf(body, target.pricingUnit);
  const params = descriptor.snapshotParams(body);

  const persist = async (upstreamTaskId: string | null): Promise<Response> => {
    try {
      await recordTaskSubmitted(deps, tracers, {
        auth,
        requestId,
        externalModel,
        target,
        channel,
        kind: kind as GenerationKind,
        params,
        upstreamTaskId,
        units,
        durationMs: Date.now() - startedAt,
        trace,
      });
    } catch (error) {
      logger.error(
        { requestId, err: error instanceof Error ? error.message : String(error) },
        'generation task persistence failed',
      );
      // 任务行未落库：预留保留（租约恢复链释放），客户端收到可重试错误——
      // 与同步路径 billing_receipt_unavailable 同语义。
      return renderReject(c, {
        code: 'billing_receipt_unavailable',
        status: 503,
        message: '任务登记暂时无法持久化',
        suggestion: '请稍后重试；若已扣费请联系管理员核对',
      });
    }
    recordRequest(target.realModel, 201, Date.now() - startedAt);
    return c.json(
      {
        id: requestId,
        object: kind,
        model: externalModel,
        ...(upstreamTaskId !== null ? { task_id: upstreamTaskId } : {}),
        status: 'queued',
      },
      201,
      { 'x-request-id': requestId },
    );
  };

  // task_execute（同步阻塞型上游，如 music）：网关不调上游，worker 代执行
  if (descriptor.execution === 'task_execute') {
    return { kind: 'success', response: await persist(null) };
  }

  // task_poll：上游提交（提交型调用仍走 ai.chat 的重试/熔断/凭据面）
  const result = await ai.chat({ channel: channelDesc, request: body, ctx });
  if (result.status === 'success') {
    const parsed = ai.parseGenerationResponse?.({
      channel: channelDesc,
      endpoint: kind as 'video',
      body: result.body,
    });
    if (parsed && parsed.kind === 'task_submitted') {
      const response = await persist(parsed.taskId);
      // 任务行落库失败 → 503 已构建，但上游任务已提交（可能已计费）——按 respond
      // 语义穿出（不换渠道重提，防同一请求双任务）；成功则正常 success。
      if (response.status === 503) {
        return {
          kind: 'respond',
          response,
          error: {
            code: 'billing_receipt_unavailable',
            message: 'task persistence failed',
            status: 503,
            upstreamCharge: 'unknown',
          },
        };
      }
      return { kind: 'success', response };
    }
    // 200 但无 task_id（或协议不支持任务）→ 渠道级错误，换渠道
    const err = parsed?.kind === 'error' ? parsed.error : undefined;
    logger.warn({ requestId, channel: channel.key }, 'generation submit response unparsable');
    recordChannelFailure(channel.key);
    return {
      kind: 'switch',
      error: {
        code: err?.code ?? 'invalid_response',
        message: err?.message ?? '上游未返回任务号',
        status: err?.status ?? 502,
        upstreamCharge: upstreamCharge(err?.code ?? 'invalid_response'),
      },
    };
  }

  const err = result.error;
  if (err && isChannelSwitchable(err.code)) {
    logger.warn(
      { requestId, channel: channel.key, code: err.code },
      'generation submit failed, switching',
    );
    recordChannelFailure(channel.key);
    if (isDeadCredentialError(err)) {
      void markChannelDeadCredential(deps.db, deps.router, channel.channelId, deps.logger);
    }
    return {
      kind: 'switch',
      error: {
        code: err.code,
        message: err.message,
        status: err.status ?? 502,
        suggestion: err.suggestion,
        upstreamCharge: upstreamCharge(err.code),
      },
    };
  }
  const status =
    err?.status !== undefined && err.status >= 400 && err.status < 600 ? err.status : 502;
  const safeMessage = sanitizeUpstreamDetail(
    err?.message,
    sanitizeCtx(externalModel, target, channel),
  );
  const passthrough =
    status >= 400 && status < 500
      ? upstreamPassthroughReject({
          code: err?.code ?? 'upstream_error',
          status,
          message: safeMessage,
          suggestion: err?.suggestion,
        })
      : null;
  return {
    kind: 'respond',
    response: renderReject(
      c,
      passthrough ?? {
        code: err?.code ?? 'upstream_error',
        status,
        message: safeMessage,
        suggestion: err?.suggestion,
      },
    ),
    error: {
      code: err?.code ?? 'upstream_error',
      message: safeMessage,
      status,
      suggestion: err?.suggestion,
      upstreamCharge: upstreamCharge(err?.code),
    },
  };
}
