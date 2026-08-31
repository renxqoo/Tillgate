import { InferenceErrors } from '../domain/errors';
import { buildReceipt } from '../domain/usage/receipt';
import { usageForNonStream } from '../domain/usage/receipt-usage';
import {
  recordSettleSuccess,
  type AttemptContext,
  type AttemptOutcome,
  type ExecutionDeps,
} from './failover';
import { dispatchFailure, type PassthroughDelivered } from './dispatch';
import { signalSucceededWithRetry } from './signal-retry';
import type { UpstreamPort } from '../ports/upstream';

/** 非流式成功交付形态（200 JSON / 二进制；passthrough 见 PassthroughDelivered） */
export type ChatDelivered =
  | { ok: true; status: 200; body?: unknown; rawBody?: Uint8Array; rawContentType?: string }
  | PassthroughDelivered;

/** 上游非流式调用结果类型（端口 chat 面） */
type UpstreamChatResult = Awaited<ReturnType<UpstreamPort['chat']>>;

/**
 * 亚毫秒计时器（下界 1ms）：真实上游调用（HTTP 往返）不可能 0ms，Date.now 毫秒
 * 分辨率在本地 mock/keep-alive 下会量出假 0——按物理下界归一，
 * 避免 usage_logs.duration_ms 出现 0（usage 审计断言 >0）。
 */
function upstreamTimer(): { elapsedMs(): number } {
  const startedAt = performance.now();
  return { elapsedMs: () => Math.max(1, Math.round(performance.now() - startedAt)) };
}

/** 上游调用段（包 upstream.attempt span；ok/时长/usage 事后补属性） */
async function chatUpstreamWithSpan(
  deps: ExecutionDeps,
  ctx: AttemptContext,
): Promise<{ result: UpstreamChatResult; durationMs: number }> {
  const { elapsedMs } = upstreamTimer();
  const result = await deps.trace.withSpan(
    'upstream.attempt',
    {
      'request.id': ctx.requestId,
      'user.id': ctx.prepared.auth.userId,
      'channel.key': ctx.channel.channelName,
      'channel.attempt': ctx.channelAttempt,
      'ai.model': ctx.candidate.realModel,
      'upstream.stream': false,
    },
    async (span) => {
      const r = await deps.upstream.chat(ctx.channel, {
        requestId: ctx.requestId,
        externalModel: ctx.prepared.externalModel,
        upstreamModel: ctx.channel.upstreamModel,
        endpoint: ctx.prepared.endpoint,
        body: ctx.prepared.upstreamBody,
        ...(ctx.signal != null ? { signal: ctx.signal } : {}),
        deadlineMs: deps.defaults.upstream.deadlineMs,
        maxRetries: deps.policy.latest().retry.sameChannelMaxRetries,
      });
      if (r.ok) {
        span.setAttributes({
          'upstream.ok': true,
          'upstream.duration_ms': elapsedMs(),
          ...(r.usage != null
            ? {
                'tokens.input': r.usage.inputTokens,
                'tokens.output': r.usage.outputTokens,
              }
            : {}),
        });
      } else {
        span.setAttributes({
          'upstream.ok': false,
          'upstream.error_code': r.error.kind,
          ...(r.error.status != null ? { 'http.status_code': r.error.status } : {}),
        });
        span.setStatus({ code: 'error', message: r.error.kind });
      }
      return r;
    },
  );
  return { result, durationMs: elapsedMs() };
}

/** 成功半程：收据装配 → **先结算后交付**（未交付不结算——结算耗尽抛 finalize_unavailable，宁可让用户重试也不白送；预留滞留至租约到期由 recover 兜底） */
async function settleChatDelivered(
  deps: ExecutionDeps,
  ctx: AttemptContext,
  outcome: { result: Extract<UpstreamChatResult, { ok: true }>; durationMs: number },
): Promise<AttemptOutcome<ChatDelivered>> {
  const { result, durationMs } = outcome;
  const usage = usageForNonStream(
    result.usage,
    result.body,
    ctx.prepared.inputEstimate,
    deps.defaults.estimate,
  );
  const receipt = buildReceipt({
    requestId: ctx.requestId,
    auth: ctx.prepared.auth,
    candidate: ctx.candidate,
    externalModel: ctx.prepared.externalModel,
    channelId: ctx.channel.channelId,
    channelKey: ctx.channel.channelName,
    channel: ctx.channel,
    durationMs,
    body: ctx.prepared.body,
    responseBody: result.body,
    usage,
  });
  const finalized = await signalSucceededWithRetry(
    {
      billing: deps.billing,
      settleSignal: deps.defaults.settleSignal,
      trace: deps.trace,
      onError: deps.onError,
    },
    ctx.requestId,
    receipt,
  );
  // 结算成功 = 渠道真实可用：死凭据自愈 + 候选死记忆清零（fire-and-forget）
  recordSettleSuccess(deps, ctx);
  if (!finalized) {
    throw InferenceErrors.business('finalize_unavailable', { request_id: ctx.requestId });
  }
  return deliverChat(result);
}

/** 交付形态：二进制优先（raw 透传），否则 JSON body */
function deliverChat(
  result: Extract<UpstreamChatResult, { ok: true }>,
): AttemptOutcome<ChatDelivered> {
  if (result.rawBody != null) {
    return {
      kind: 'respond',
      value: {
        ok: true,
        status: 200,
        rawBody: result.rawBody,
        rawContentType: result.rawContentType ?? 'application/octet-stream',
      },
    };
  }
  return { kind: 'respond', value: { ok: true, status: 200, body: result.body } };
}

/**
 * 非流式尝试：同步调上游 → 成功先结算后交付 → 失败走统一分派。
 */
export function createChatAttempt(deps: ExecutionDeps) {
  return async (ctx: AttemptContext): Promise<AttemptOutcome<ChatDelivered>> => {
    const { result, durationMs } = await chatUpstreamWithSpan(deps, ctx);
    if (!result.ok) return dispatchFailure(deps, ctx, result.error);
    return settleChatDelivered(deps, ctx, { result, durationMs });
  };
}
