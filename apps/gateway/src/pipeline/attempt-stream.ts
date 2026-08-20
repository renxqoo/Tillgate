/**
 * 流式尝试（run-chat 候选×渠道循环的执行层之一）：first_chunk/failed/success
 * 决定性事件锚定换渠窗口；上线（first_chunk 或零块完成）后续租保命 + 终态监听
 * 后台结算，管道立即交还路由。streamReceiptUsage 为本模块私有（唯一消费方）。
 */
import { estimateTextTokens } from '@ai-gateway/ai';
import { streamEstimateAttribution } from '@ai-gateway/domain';
import type { UsageReceipt } from '@ai-gateway/domain';
import { SpanStatusCode, withAsyncSpan } from '@ai-gateway/core';
import type { AttemptInput, AttemptOutcome } from './attempt-contract.js';
import { buildReceipt } from './receipt.js';
import { signalSucceededWithRetry } from './settle-retry.js';
import type { UpstreamStreamEvent } from './upstream-port.js';

/** 流式终态（success 事件）→ 收据 usage 形态（估算归属政策单一真相在 domain）。
 *  usage 缺失/不可信时输出 token 从扫描器累计的输出文本校准估算（与输入同一估算器）
 *  ——输出按 0 计费 = 「取消刷输出」「无 usage 供应商白嫖」两个真实漏收面。 */
function streamReceiptUsage(
  event: Extract<UpstreamStreamEvent, { type: 'success' }>,
  bpeInput: number,
  model: string,
): Pick<UsageReceipt, 'usage' | 'estimatedFor' | 'bytesRelayed' | 'streamAborted'> {
  const usage = event.usage;
  if (usage && !usage.estimated) {
    return {
      usage: {
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        estimated: false,
        ...(((usage as { cacheWriteTokens?: number }).cacheWriteTokens ?? 0) > 0
          ? { cacheWriteTokens: (usage as { cacheWriteTokens?: number }).cacheWriteTokens }
          : {}),
      },
      streamAborted: false,
    };
  }
  const terminated = event.terminated;
  // 输出 token 与输入侧同一估算器（BPE 主路径，model 可用时不再回落启发式——
  // 启发式对 CJK 高估 ~40%，实扣口径须与预扣同一分流点）
  const estOutput = estimateTextTokens(event.outputText ?? '', undefined, model);
  return {
    usage: {
      // input 实扣用 BPE 估算；字节保守上界只作预扣敞口，不得入实扣
      // （部分交付计费政策：金额向精确收敛，多收数倍是客诉磁铁）
      inputTokens: usage?.inputTokens ?? bpeInput,
      cachedInputTokens: 0,
      outputTokens: estOutput,
      estimated: true,
    },
    // 归属细分单一真相在 domain：用户取消 / 完成缺 usage / 上游故障 / 闲置超时 /
    // 网关停机分标签（部分交付即计费——2026-08-21 拍板，含上游故障截断）
    estimatedFor: streamEstimateAttribution(terminated),
    bytesRelayed: event.bytesRelayed ?? 0,
    streamAborted: terminated != null,
  };
}

export async function attemptStream(input: AttemptInput): Promise<AttemptOutcome> {
  const { tracer, ctx, deps, requestId, auth, body, upstreamBody, endpoint, candidate, channel, channelAttempt } = input;
  const startedAt = Date.now();
  const { streamResult, decisive } = await withAsyncSpan(tracer, 'upstream.attempt', {
    'request.id': requestId,
    'user.id': auth.userId,
    'channel.key': channel.channelName,
    'channel.attempt': channelAttempt,
    'ai.model': candidate.realModel,
    'upstream.stream': true,
  }, async (span) => {
    const s = await deps.upstream.chatStream(channel, {
      requestId, realModel: candidate.realModel, externalModel: body.model, endpoint, body: upstreamBody,
    });
    const d = await new Promise<UpstreamStreamEvent>((resolve) => {
      let settled = false;
      s.onEvent((event) => {
        if (settled) return;
        if (event.type === 'first_chunk' || event.type === 'failed' || event.type === 'success') {
          settled = true;
          resolve(event);
        }
      });
    });
    span.setAttributes({
      'upstream.event': d.type,
      'upstream.duration_ms': Date.now() - startedAt,
      ...(d.type === 'failed'
        ? {
            'upstream.ok': false,
            'upstream.error_code': d.code ?? 'upstream_error',
            ...(d.status != null ? { 'http.status_code': d.status } : {}),
            ...(d.deadCredential ? { 'upstream.dead_credential': true } : {}),
          }
        : { 'upstream.ok': true }),
    });
    if (d.type === 'failed') {
      span.setStatus({ code: SpanStatusCode.ERROR, message: d.code ?? 'upstream_error' });
    }
    return { streamResult: s, decisive: d };
  });
  if (decisive.type === 'failed') {
    return input.dispatchFailure(channel, decisive, decisive.status);
  }
  // 上线（first_chunk 或零块完成）：终态监听收尾，立即把管道交还路由
  // 长流续租（v1 withBillingLifecycle 语义）：租约 = authorizationTtlMs，每 1/3
  // 续一次——超过 TTL 的长流否则会被 recover 按滞留误释放 → 终态冲突 → 漏收。
  // 终态即停；续租次数上限防「终态永不到达」的协议违约泄漏（停后由 recover 兜底回收）。
  let streamAlive = true;
  const renewIntervalMs = Math.max(1_000, Math.floor(deps.config.authorizationTtlMs / 3));
  let renewCount = 0;
  const renewTimer = setInterval(() => {
    if (!streamAlive || renewCount >= 100) return;
    renewCount += 1;
    void deps.billing.signal(ctx, {
      type: 'lease.renewed',
      requestId,
      leaseOwner: 'gateway',
      leaseMs: deps.config.authorizationTtlMs,
    }).catch((error) => input.noteError(error, `stream lease renew request=${requestId}`));
  }, renewIntervalMs);
  renewTimer.unref?.();
  streamResult.onEvent(async (event) => {
    if (event.type !== 'success') return;
    const durationMs = Date.now() - startedAt;
    const finality = streamReceiptUsage(event, input.bpeInput, body.model);
    const receipt: UsageReceipt = {
      ...buildReceipt({
        requestId, userId: auth.userId, apiKeyId: auth.apiKeyId, appId: auth.appId ?? null, candidate,
        externalModel: body.model, channelId: channel.channelId, channelKey: channel.channelName,
        durationMs, fx: await input.fxPromise,
        body: body as Record<string, unknown>,
        usage: finality.usage.estimated
          ? { estimated: true, inputTokens: finality.usage.inputTokens, outputTokens: finality.usage.outputTokens }
          : {
              estimated: false,
              inputTokens: finality.usage.inputTokens,
              cachedInputTokens: finality.usage.cachedInputTokens,
              outputTokens: finality.usage.outputTokens,
              // 上游可信回传的缓存写 token 必须透传——结算公式按写价计费，
              // 丢弃会使 cacheWrite 并入 uncached 按输入价算（写价≠输入价即错账）
              ...((finality.usage.cacheWriteTokens ?? 0) > 0 ? { cacheWriteTokens: finality.usage.cacheWriteTokens } : {}),
            },
      }),
      ...(finality.estimatedFor !== undefined ? { estimatedFor: finality.estimatedFor } : {}),
      ...(finality.bytesRelayed !== undefined ? { bytesRelayed: finality.bytesRelayed } : {}),
      stream: true,
      streamAborted: finality.streamAborted,
    };
    // 结算 signal 退避重试：重试期间续租不停（streamAlive 保持 true）——
    // 200 已交付的请求不再因一次 DB 抖动被 recover 误释放成免费单；
    // 耗尽才停租约交 recover 兜底（有界损失 + 响亮日志）。
    const finalized = await signalSucceededWithRetry(deps.billing, ctx, requestId, receipt, input.noteError);
    if (!finalized) {
      input.noteError(new Error('signal retries exhausted'), `stream finalize giveup request=${requestId}`);
    }
    streamAlive = false;
    clearInterval(renewTimer);
  });
  return { kind: 'respond', response: { status: 200, stream: streamResult.stream, contentType: 'text/event-stream' } };
}
