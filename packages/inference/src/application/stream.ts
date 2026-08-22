import type { UsageReceipt } from '../domain/usage/receipt';
import { buildReceipt } from '../domain/usage/receipt';
import { usageForStream } from '../domain/usage/receipt-usage';
import type { UpstreamStreamEvent } from '../ports/upstream';
import {
  dispatchFailure,
  type AttemptContext,
  type AttemptOutcome,
  type ExecutionDeps,
  type PassthroughDelivered,
} from './failover';
import { signalSucceededWithRetry } from './signal-retry';

/** 流式成功交付形态（透传管道；first_chunk 前的 4xx 走 PassthroughDelivered） */
export type StreamDelivered = {
  ok: true;
  status: 200;
  stream: ReadableStream<Uint8Array>;
  contentType: 'text/event-stream';
};

/**
 * 流式尝试（v1 attempt-stream.ts 迁移）：first_chunk/failed/success 决定性事件锚定
 * 换渠窗口；上线（first_chunk 或零块完成）后续租保命 + 终态监听后台结算，管道立即
 * 交还路由。长流续租：租约 = authorizationTtlMs，每 1/3 续一次（下限 1s）——超过
 * TTL 的长流否则会被 recover 按滞留误释放 → 终态冲突 → 漏收；续期次数上限防
 * 「终态永不到达」的协议违约泄漏（停后由 recover 兜底回收）。结算重试期间续租
 * 不停（alive 保持到结算收尾）——200 已交付的请求不再因一次 DB 抖动被 recover
 * 误释放成免费单；耗尽才停租约交 recover 兜底（有界损失 + 响亮日志）。
 */
export function createStreamAttempt(deps: ExecutionDeps) {
  return async (
    ctx: AttemptContext,
  ): Promise<AttemptOutcome<StreamDelivered | PassthroughDelivered>> => {
    const startedAt = Date.now();
    const result = await deps.upstream.chatStream(ctx.channel, {
      requestId: ctx.requestId,
      externalModel: ctx.prepared.externalModel,
      realModel: ctx.candidate.realModel,
      endpoint: ctx.prepared.endpoint,
      body: ctx.prepared.upstreamBody,
      ...(ctx.signal != null ? { signal: ctx.signal } : {}),
      deadlineMs: deps.defaults.upstream.deadlineMs,
    });
    let firstChunkAt = 0;
    let alive = false;
    let renewCount = 0;
    let renewTimer: ReturnType<typeof setInterval> | undefined;
    const startLease = (): void => {
      alive = true;
      const intervalMs = Math.max(
        deps.defaults.streamLease.minRenewIntervalMs,
        Math.floor(deps.defaults.authorization.ttlMs / 3),
      );
      renewTimer = setInterval(() => {
        if (!alive || renewCount >= deps.defaults.streamLease.maxRenewals) return;
        renewCount += 1;
        void deps.billing
          .signal({
            type: 'lease_renewed',
            requestId: ctx.requestId,
            leaseOwner: 'inference',
            leaseMs: deps.defaults.authorization.ttlMs,
          })
          .catch((error) => deps.onError?.(error, `stream lease renew request=${ctx.requestId}`));
      }, intervalMs);
      renewTimer.unref?.();
    };
    /** 终态收尾（后台）：收据（命中候选价 + 可信/估算 usage + 归属）→ signal 重试 */
    const settle = async (
      terminal: Extract<UpstreamStreamEvent, { type: 'success' }>,
    ): Promise<void> => {
      const finality = usageForStream(terminal, ctx.prepared.inputEstimate, deps.defaults.estimate);
      const receipt: UsageReceipt = {
        ...buildReceipt({
          requestId: ctx.requestId,
          auth: ctx.prepared.auth,
          candidate: ctx.candidate,
          externalModel: ctx.prepared.externalModel,
          channelId: ctx.channel.channelId,
          channelKey: ctx.channel.channelName,
          durationMs: Date.now() - startedAt,
          body: ctx.prepared.body,
          usage: finality.usage,
        }),
        stream: true,
        streamAborted: finality.streamAborted,
        ...(finality.estimatedFor !== undefined ? { estimatedFor: finality.estimatedFor } : {}),
        ...(finality.bytesRelayed !== undefined ? { bytesRelayed: finality.bytesRelayed } : {}),
        ...(firstChunkAt > 0
          ? {
              // 上游锚点 = 本次渠道发起（换渠后即成功渠道）；客户端锚点 = 请求进入
              //（含授权/路由与换渠等待——用户从提交到首 token 的真实体感）
              upstreamTtftMs: Math.max(0, firstChunkAt - startedAt),
              clientTtftMs: Math.max(0, firstChunkAt - ctx.requestStartedAt),
            }
          : {}),
      };
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
        deps.onError?.(
          new Error('signal retries exhausted'),
          `stream finalize giveup request=${ctx.requestId}`,
        );
      }
      alive = false;
      if (renewTimer != null) clearInterval(renewTimer);
    };

    // 决定性事件锚定：first_chunk（上线）/ failed（首字节前失败，可换渠）/
    // success（零块完成——决定性即终态）。同一订阅继续监听终态做后台结算。
    const decisive = await new Promise<UpstreamStreamEvent>((resolve) => {
      let settled = false;
      result.onEvent((event) => {
        if (event.type === 'first_chunk') {
          if (firstChunkAt === 0) firstChunkAt = event.atMs;
          if (!settled) {
            settled = true;
            startLease();
            resolve(event);
          }
          return;
        }
        if (event.type === 'success') {
          if (!settled) {
            settled = true;
            resolve(event);
          }
          void settle(event);
          return;
        }
        if (event.type === 'failed' && !settled) {
          settled = true;
          resolve(event);
        }
      });
    });
    if (decisive.type === 'failed') return dispatchFailure(deps, ctx, decisive.error);
    // 上线（first_chunk 或零块完成）：管道立即交还路由
    return {
      kind: 'respond',
      value: { ok: true, status: 200, stream: result.stream, contentType: 'text/event-stream' },
    };
  };
}
