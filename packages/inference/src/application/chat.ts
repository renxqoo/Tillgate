import { InferenceErrors } from '../domain/errors';
import { buildReceipt } from '../domain/usage/receipt';
import { usageForNonStream } from '../domain/usage/receipt-usage';
import {
  dispatchFailure,
  type AttemptContext,
  type AttemptOutcome,
  type ExecutionDeps,
  type PassthroughDelivered,
} from './failover';
import { signalSucceededWithRetry } from './signal-retry';

/** 非流式成功交付形态（200 JSON / 二进制；passthrough 见 PassthroughDelivered） */
export type ChatDelivered =
  | { ok: true; status: 200; body?: unknown; rawBody?: Uint8Array; rawContentType?: string }
  | PassthroughDelivered;

/**
 * 非流式尝试（v1 attempt-nonstream.ts 迁移）：同步调上游 → 成功**先结算后交付**
 * （未交付不结算——结算耗尽抛 finalize_unavailable，宁可让用户重试也不白送；
 * 预留滞留至租约到期由 recover 兜底，v1 B3 语义保留）→ 失败走统一分派。
 */
export function createChatAttempt(deps: ExecutionDeps) {
  return async (ctx: AttemptContext): Promise<AttemptOutcome<ChatDelivered>> => {
    const startedAt = Date.now();
    const result = await deps.upstream.chat(ctx.channel, {
      requestId: ctx.requestId,
      externalModel: ctx.prepared.externalModel,
      realModel: ctx.candidate.realModel,
      endpoint: ctx.prepared.endpoint,
      body: ctx.prepared.upstreamBody,
      ...(ctx.signal != null ? { signal: ctx.signal } : {}),
      deadlineMs: deps.defaults.upstream.deadlineMs,
    });
    const durationMs = Date.now() - startedAt;
    if (!result.ok) return dispatchFailure(deps, ctx, result.error);

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
      durationMs,
      body: ctx.prepared.body,
      responseBody: result.body,
      usage,
    });
    const finalized = await signalSucceededWithRetry(
      {
        billing: deps.billing,
        settleSignal: deps.defaults.settleSignal,
        onError: deps.onError,
      },
      ctx.requestId,
      receipt,
    );
    if (!finalized) {
      throw InferenceErrors.business('finalize_unavailable', { request_id: ctx.requestId });
    }
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
  };
}
