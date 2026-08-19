import type { UpstreamError } from '@ai-gateway/ai';
import { estimateInputTokens } from '@ai-gateway/ai';
import { SpanStatusCode } from '@ai-gateway/core';
import { upstreamPassthroughReject, type GatewayReject } from '../../../../lib/errors.js';
import { renderReject } from '../../../../lib/http.js';
import { rewriteSseModel } from '../../../../lib/sse-model-rewrite.js';
import { sanitizeUpstreamDetail } from '../../../../lib/upstream-error-sanitize.js';
import { recordChannelFailure, recordRequest } from '../../../../lib/metrics.js';
import {
  isChannelSwitchable,
  isDeadCredentialError,
  markChannelDeadCredential,
} from '../../../routing/channel-policy.js';
import {
  sanitizeCtx,
  type AttemptOutcome,
  type PipelineDeps,
  type PipelineTracers,
} from '../../types.js';
import {
  asUserSideCancel,
  makeReceipt,
  recordEstimatedOutcome,
  recordReleasedFailure,
  recordSuccess,
  upstreamCharge,
  withBillingLifecycle,
} from '../finalize.js';
import type { TransportArgs } from './types.js';

/**
 * 流式传输模式：ai 包契约——流开始前失败 → 返回含错误帧的流 + 重放 failed 事件
 * （onEvent 注册时同步重放），据此判断是否换渠道；流开始后的事件在流期间异步到达。
 * 含 stream.relay 生命周期、TTFB 锚定（first_chunk）、责任域三分岔
 * （取消/完成缺 usage → 估算结算；上游异常 → 释放不扣）。
 */
export async function attemptStream(
  deps: PipelineDeps,
  tracers: PipelineTracers,
  args: TransportArgs,
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

/** SSE 响应头（流式透传） */
export function sseResponse(stream: ReadableStream<Uint8Array>, requestId: string): Response {
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-request-id': requestId,
    },
  });
}
