import type { UsageReceipt } from '../domain/usage/receipt';
import { buildReceipt } from '../domain/usage/receipt';
import { usageForStream } from '../domain/usage/receipt-usage';
import type { UpstreamPort, UpstreamStreamEvent } from '../ports/upstream';
import type { SpanHandle } from '../ports/trace';
import {
  LEASE_OWNER,
  recordSettleSuccess,
  type AttemptContext,
  type AttemptOutcome,
  type ExecutionDeps,
} from './failover';
import { dispatchFailure, type PassthroughDelivered } from './dispatch';
import { signalSucceededWithRetry } from './signal-retry';

/** 流式成功交付形态（透传管道；first_chunk 前的 4xx 走 PassthroughDelivered） */
export interface StreamDelivered {
  ok: true;
  status: 200;
  stream: ReadableStream<Uint8Array>;
  contentType: 'text/event-stream';
}

/** 流式租约可变状态（单点持有：首块时刻 / 存活位 / 续租计数 / 续租定时器） */
interface StreamLeaseState {
  firstChunkAt: number;
  alive: boolean;
  renewCount: number;
  renewTimer: ReturnType<typeof setInterval> | undefined;
}

/** 流式收尾上下文（依赖 + 尝试上下文 + 起点时刻 + 可变状态） */
interface StreamSettleCtx {
  deps: ExecutionDeps;
  ctx: AttemptContext;
  startedAt: number;
  state: StreamLeaseState;
}

/** 上线续租保命：租约 = authorizationTtlMs，每 1/3 续一次（下限 1s）——超过 TTL 的长流否则会被 recover 按滞留误释放 → 终态冲突 → 漏收；续期次数上限防「终态永不到达」的协议违约泄漏（停后由 recover 兜底回收） */
function startStreamLease(sc: StreamSettleCtx): void {
  sc.state.alive = true;
  const intervalMs = Math.max(
    sc.deps.defaults.streamLease.minRenewIntervalMs,
    Math.floor(sc.deps.defaults.authorization.ttlMs / 3),
  );
  sc.state.renewTimer = setInterval(() => {
    if (!sc.state.alive || sc.state.renewCount >= sc.deps.defaults.streamLease.maxRenewals) {
      return;
    }
    sc.state.renewCount += 1;
    void sc.deps.billing
      .signal({
        type: 'lease_renewed',
        requestId: sc.ctx.requestId,
        leaseOwner: LEASE_OWNER,
        leaseMs: sc.deps.defaults.authorization.ttlMs,
      })
      .catch((error) => sc.deps.onError?.(error, `stream lease renew request=${sc.ctx.requestId}`));
  }, intervalMs);
  sc.state.renewTimer.unref?.();
}

/** 终态收尾（后台）：收据（命中候选价 + 可信/估算 usage + 归属）→ signal 重试。结算重试期间续租不停（alive 保持到结算收尾）——200 已交付的请求不再因一次 DB 抖动被 recover 误释放成免费单；耗尽才停租约交 recover 兜底（有界损失 + 响亮日志） */
/** 流式终态收据 = 基础收据 + 流式覆写（中断标记/估算归属/证据字节/TTFT 观测） */
function streamReceiptOf(
  sc: StreamSettleCtx,
  finality: ReturnType<typeof usageForStream>,
): UsageReceipt {
  const { ctx, startedAt, state } = sc;
  return {
    ...buildReceipt({
      requestId: ctx.requestId,
      auth: ctx.prepared.auth,
      candidate: ctx.candidate,
      externalModel: ctx.prepared.externalModel,
      channelId: ctx.channel.channelId,
      channelKey: ctx.channel.channelName,
      // 计时下界 1ms：Date.now 毫秒分辨率在本地 mock 下可量出假 0（与 chat.ts 同约束）
      durationMs: Math.max(1, Date.now() - startedAt),
      body: ctx.prepared.body,
      usage: finality.usage,
    }),
    stream: true,
    streamAborted: finality.streamAborted,
    ...(finality.estimatedFor !== undefined ? { estimatedFor: finality.estimatedFor } : {}),
    ...(finality.bytesRelayed !== undefined ? { bytesRelayed: finality.bytesRelayed } : {}),
    ...(finality.outputEvidenceBytes !== undefined
      ? { outputEvidenceBytes: finality.outputEvidenceBytes }
      : {}),
    ...(state.firstChunkAt > 0
      ? {
          // 上游锚点 = 本次渠道发起（换渠后即成功渠道）；客户端锚点 = 请求进入
          //（含授权/路由与换渠等待——用户从提交到首 token 的真实体感）
          upstreamTtftMs: Math.max(0, state.firstChunkAt - startedAt),
          clientTtftMs: Math.max(0, state.firstChunkAt - ctx.requestStartedAt),
        }
      : {}),
  };
}

async function settleStream(
  sc: StreamSettleCtx,
  terminal: Extract<UpstreamStreamEvent, { type: 'success' }>,
): Promise<void> {
  const { deps, ctx, state } = sc;
  const finality = usageForStream(terminal, ctx.prepared.inputEstimate, deps.defaults.estimate);
  const receipt = streamReceiptOf(sc, finality);
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
    deps.onError?.(
      new Error('signal retries exhausted'),
      `stream finalize giveup request=${ctx.requestId}`,
    );
  }
  state.alive = false;
  if (state.renewTimer != null) clearInterval(state.renewTimer);
}

/** 终态收尾失败兜底：结算链意外崩溃（重试器外的异常）时停续租定时器，防泄漏 */
function crashStreamSettle(sc: StreamSettleCtx, error: unknown): void {
  sc.state.alive = false;
  if (sc.state.renewTimer != null) clearInterval(sc.state.renewTimer);
  sc.deps.onError?.(error, `stream settle crashed request=${sc.ctx.requestId}`);
}

/** 决定性事件锚定：first_chunk（上线）/ failed（首字节前失败，可换渠）/ success（零块完成——决定性即终态）。同一订阅继续监听终态做后台结算 */
async function awaitDecisiveEvent(
  sc: StreamSettleCtx,
  onEvent: (cb: (event: UpstreamStreamEvent) => void) => void,
): Promise<UpstreamStreamEvent> {
  // 终态收尾的根句柄在订阅建立时（请求作用域内）捕获一次并闭包持有——终态事件
  // 可能由全局 sweep 定时器（他人的异步上下文）触发，靠 ALS 现取会挂错请求的根
  const rootTrace = sc.deps.trace.captureRoot();
  return await new Promise<UpstreamStreamEvent>((resolve) => {
    let settled = false;
    onEvent((event) => {
      if (event.type === 'first_chunk') {
        if (sc.state.firstChunkAt === 0) sc.state.firstChunkAt = event.atMs;
        if (!settled) {
          settled = true;
          startStreamLease(sc);
          resolve(event);
        }
        return;
      }
      if (event.type === 'success') {
        if (!settled) {
          settled = true;
          resolve(event);
        }
        // 后台结算不得反噬数据面：挂请求根 span 并计入根生命周期（captureRoot
        // 在请求作用域内捕获——fire-and-forget 不再逃逸成孤儿 trace/时窗）；
        // 意外异常经 onError 观察 + 停租（回调不外溢；正常路径 settle 内部自停租）
        void rootTrace
          .runInBackground(() => settleStream(sc, event))
          .catch((error) => crashStreamSettle(sc, error));
        return;
      }
      if (event.type === 'failed' && !settled) {
        settled = true;
        resolve(event);
      }
    });
  });
}

/** 决定性事件 → span 属性回填（ok/错误码/TTFT；零块完成 success 无失败面） */
function markDecisiveSpan(
  span: SpanHandle,
  args: { startedAt: number; state: StreamLeaseState; decisive: UpstreamStreamEvent },
): void {
  const { startedAt, state, decisive } = args;
  if (decisive.type === 'first_chunk') {
    span.setAttributes({
      'upstream.ok': true,
      'upstream.ttft_ms': Math.max(0, state.firstChunkAt - startedAt),
    });
  } else if (decisive.type === 'failed') {
    span.setAttributes({
      'upstream.ok': false,
      'upstream.error_code': decisive.error.kind,
      ...(decisive.error.status != null ? { 'http.status_code': decisive.error.status } : {}),
    });
    span.setStatus({ code: 'error', message: decisive.error.kind });
  }
}

/** 上游调用 → 决定性事件整段包 upstream.attempt span（终态后台结算在此上下文里发起——settle_signal 自然挂本 span 之下） */
async function streamUpstreamWithSpan(
  deps: ExecutionDeps,
  ctx: AttemptContext,
): Promise<{
  result: Awaited<ReturnType<UpstreamPort['chatStream']>>;
  decisive: UpstreamStreamEvent;
}> {
  const startedAt = Date.now();
  return await deps.trace.withSpan(
    'upstream.attempt',
    {
      'request.id': ctx.requestId,
      'user.id': ctx.prepared.auth.userId,
      'channel.key': ctx.channel.channelName,
      'channel.attempt': ctx.channelAttempt,
      'ai.model': ctx.candidate.realModel,
      'upstream.stream': true,
    },
    async (span) => {
      const r = await deps.upstream.chatStream(ctx.channel, {
        requestId: ctx.requestId,
        externalModel: ctx.prepared.externalModel,
        upstreamModel: ctx.channel.upstreamModel,
        endpoint: ctx.prepared.endpoint,
        body: ctx.prepared.upstreamBody,
        ...(ctx.signal != null ? { signal: ctx.signal } : {}),
        deadlineMs: deps.defaults.upstream.deadlineMs,
        maxRetries: deps.policy.latest().retry.sameChannelMaxRetries,
      });
      const state: StreamLeaseState = {
        firstChunkAt: 0,
        alive: false,
        renewCount: 0,
        renewTimer: undefined,
      };
      const decisive = await awaitDecisiveEvent({ deps, ctx, startedAt, state }, r.onEvent);
      markDecisiveSpan(span, { startedAt, state, decisive });
      return { result: r, decisive };
    },
  );
}

/**
 * 流式尝试：first_chunk/failed/success 决定性事件锚定
 * 换渠窗口；上线后管道立即交还路由，终态监听与续租保命在后台进行。
 */
export function createStreamAttempt(deps: ExecutionDeps) {
  return async (
    ctx: AttemptContext,
  ): Promise<AttemptOutcome<StreamDelivered | PassthroughDelivered>> => {
    const { result, decisive } = await streamUpstreamWithSpan(deps, ctx);
    if (decisive.type === 'failed') return dispatchFailure(deps, ctx, decisive.error);
    // 上线（first_chunk 或零块完成）：管道立即交还路由
    return {
      kind: 'respond',
      value: { ok: true, status: 200, stream: result.stream, contentType: 'text/event-stream' },
    };
  };
}
