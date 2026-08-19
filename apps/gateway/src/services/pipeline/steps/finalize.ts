import { resolveCalibration, type GenerationKind, type Usage } from '@ai-gateway/ai';
import { estimateCancelledUsage, asUserSideCancel } from '../usage-estimator.js';
import type { EstimateAttribution, UsageReceipt } from '@ai-gateway/ledger';
import { SpanStatusCode } from '@ai-gateway/core';
import { generationTasks } from '@ai-gateway/db/schema';
import type { RequestTraceContext, AttemptTraceContext } from '../types.js';
import type { AuthContext } from '../../../middleware/auth.js';
import { recordBillingWakeupFailed } from '../../../lib/metrics.js';
import type { ChannelCache } from '../../routing/model-router.js';
import type { CandidateTarget, PipelineDeps, PipelineTracers } from '../types.js';

/**
 * 第六步：计费收尾（结算收据组装与收尾产线）。
 *
 *   - makeReceipt：durable receipt（价格快照 + mappingId，结算幂等键）
 *   - recordSuccess / recordReleasedFailure / recordEstimatedOutcome：
 *     succeeded / 释放不扣（上游异常·drain·崩溃）/ 估算结算（取消·完成缺 usage）
 *     三条收尾产线（2026-08-17 政策：uncertain 冻结路径删除）——任何一条 trace
 *     必有 billing.finalize（或 billing.estimate）节点
 *   - withBillingLifecycle：长流租约续期 + 「收据落库前不许 EOF」
 */

export function makeReceipt(
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
      units: usage.units ?? 0,
    },
    inputPrice: target.inputPrice,
    outputPrice: target.outputPrice,
    cacheInputPrice: target.cacheInputPrice,
    unitPrice: target.unitPrice,
    coefficient: target.coefficient,
    durationMs,
    stream,
    streamAborted,
    mappingId: target.mappingId,
    billingPolicyFingerprint: target.billingPolicyFingerprint,
  };
}

/** 上游是否确定未计费（白名单）：决定失败路径退不退款 */
export function upstreamCharge(code: string | undefined): 'none' | 'unknown' {
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
      'server_draining',
      'invalid_config',
    ].includes(code)
    ? 'none'
    : 'unknown';
}

/** 先把不可变收据提交 PostgreSQL，再 best-effort 唤醒 worker。 */
export async function recordSuccess(
  deps: PipelineDeps,
  tracers: PipelineTracers,
  receipt: UsageReceipt,
  trace?: RequestTraceContext,
): Promise<void> {
  const { billing, billingDispatcher, logger } = deps;
  // 收尾 span：流式生命周期可能晚于根 span 结束，显式以请求上下文为父保证同 trace
  const span = tracers.billing.startSpan('billing.finalize', {}, trace?.requestContext);
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

/**
 * 释放型收尾（2026-08-17 政策）：上游服务端异常（超时/5xx/截断/断连/静默）、
 * server_draining、网关崩溃——未获完整服务一律释放不扣（宁可漏收不误收）。
 * 旧口径「转 uncertain 冻结等人工」已随政策删除（人工复核期望价值≈0）。
 */
export async function recordReleasedFailure(
  deps: PipelineDeps,
  tracers: PipelineTracers,
  requestId: string,
  reason: string,
  trace?: RequestTraceContext | AttemptTraceContext,
): Promise<void> {
  const span = tracers.billing.startSpan('billing.finalize', {}, trace?.requestContext);
  try {
    span.setAttributes({
      'request.id': requestId,
      'billing.finalize': 'released',
      'billing.release_reason': reason,
    });
    // 释放收尾必须能回答「扣没扣钱」：signal 终态 + 释放金额（未扣费证据）
    const result = await deps.billing.signal({
      type: 'request.failed',
      requestId,
      reason,
      delivery: 'none',
      upstreamCharge: 'none',
    });
    span.setAttributes({
      'billing.state': result.status,
      ...(result.amountReleased !== undefined
        ? { 'billing.amount_released': result.amountReleased }
        : {}),
    });
    span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
  } finally {
    span.end();
  }
}

/**
 * 估算结算（2026-08-17 政策）：可信 usage 缺失且属于允许估算的归属
 * （用户取消 ∪ 完成缺 usage）→ 立即估算结算（recordSuccess/settled），
 * 不再冻结 uncertain。链路上必须有显式「估算」步骤节点（billing.estimate：
 * 标注非真实获取 + 全部估算参数），receipt 带 estimatedFor 归属与
 * bytesRelayed（validateReceipt 结构化把关 + 审计数据源）。
 */
export interface EstimatedOutcomeArgs {
  auth: AuthContext;
  requestId: string;
  externalModel: string;
  target: CandidateTarget;
  channel: ChannelCache;
  /** 估算归属（EstimateAttribution：用户取消三态 + 完成缺 usage 两态） */
  reason: EstimateAttribution;
  durationMs: number;
  inputTokens: number;
  maxOutputTokens: number;
  /** 流式：估算 output = bytesRelayed × tokensPerByte（校准值） */
  bytesRelayed?: number;
  /** 非流式：直接给定从响应体估算的 usage（estimateUsage 单一真相） */
  usage?: Usage;
  trace?: AttemptTraceContext | RequestTraceContext;
}

export async function recordEstimatedOutcome(
  deps: PipelineDeps,
  tracers: PipelineTracers,
  args: EstimatedOutcomeArgs,
): Promise<void> {
  const span = tracers.billing.startSpan('billing.estimate', {}, args.trace?.requestContext);
  try {
    const { tokensPerByte } = resolveCalibration(
      args.channel.providerName,
      args.target.realModel,
    );
    // 非流式（usage 缺失完成）：usage 由响应体估算（attempt 侧 estimateUsage 单一真相）；
    // 流式：output = bytesRelayed × tokensPerByte（取消/完成缺 usage 同公式）
    const usage =
      args.usage ??
      estimateCancelledUsage({
        model: args.target.realModel,
        providerName: args.channel.providerName,
        inputTokens: args.inputTokens,
        bytesRelayed: args.bytesRelayed ?? 0,
        maxOutputTokens: args.maxOutputTokens,
      });
    span.setAttributes({
      'request.id': args.requestId,
      'usage.estimated': true,
      'estimate.reason': args.reason,
      'estimate.bytes_relayed': args.bytesRelayed ?? 0,
      'estimate.tokens_per_byte': tokensPerByte,
      // 估算出的 usage 本体（usage.*，与 finalize/真实 usage 同键；estimate.* 是参数）
      'usage.input_tokens': usage.inputTokens,
      'usage.cached_input_tokens': usage.cachedInputTokens,
      'usage.output_tokens': usage.outputTokens,
      'estimate.input_tokens': usage.inputTokens,
      'estimate.output_tokens': usage.outputTokens,
    });
    const receipt = makeReceipt(
      args.auth,
      args.requestId,
      args.externalModel,
      args.target,
      args.channel,
      usage,
      args.durationMs,
      true,
      true,
    );
    receipt.estimatedFor = args.reason;
    if (args.bytesRelayed !== undefined) receipt.bytesRelayed = args.bytesRelayed;
    await recordSuccess(deps, tracers, receipt, args.trace);
  } finally {
    span.end();
  }
}

/**
 * 异步生成任务提交收尾（video/music，两阶段账本的任务形态）：
 *
 *   INSERT generation_tasks（收据模板 + 单位快照 + expires_at）→
 *   signal upstream.started（租约 = 任务 TTL，worker 轮询期续租）
 *
 * 资金语义：提交只预留（authorize 已在第四步完成），完成由 worker 轮询驱动——
 * succeeded 时以收据模板填 units 结算 / failed·expired 时 request.failed 释放。
 * 顺序不变量：任务行先落（崩溃时 authorized/in_flight 由租约恢复链释放），
 * upstream.started 后置（客户端拿到 201 即代表任务已持久化）。
 */
export interface TaskSubmittedArgs {
  auth: AuthContext;
  requestId: string;
  externalModel: string;
  target: CandidateTarget;
  channel: ChannelCache;
  /** 生成类型（词表：packages/ai descriptors；DB CHECK 当前为 video|music） */
  kind: GenerationKind;

  /** 提交参数快照（zod 校验后的 canonical body 子集） */
  params: Record<string, unknown>;
  /** video：上游任务号（music 无——由 worker 代执行） */
  upstreamTaskId: string | null;
  /** 结算单位快照（按次=1；按秒=时长） */
  units: number;
  durationMs: number;
  trace?: AttemptTraceContext | RequestTraceContext;
}

export async function recordTaskSubmitted(
  deps: PipelineDeps,
  tracers: PipelineTracers,
  args: TaskSubmittedArgs,
): Promise<void> {
  const span = tracers.billing.startSpan('billing.finalize', {}, args.trace?.requestContext);
  try {
    // 收据模板：除 usage.units 外全部字段定型（价格快照 + mappingId 幂等键）；
    // worker 终态时填 units 即成完整收据——不让 worker 反解 quote。
    const template = makeReceipt(
      args.auth,
      args.requestId,
      args.externalModel,
      args.target,
      args.channel,
      { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, estimated: false, units: 0, raw: null },
      args.durationMs,
      false,
      false,
    );
    const ttlMs = deps.env.GENERATION_TASK_TTL_SECONDS * 1_000;
    const now = new Date();
    await deps.db.insert(generationTasks).values({
      id: args.requestId,
      requestId: args.requestId,
      userId: args.auth.userId,
      apiKeyId: args.auth.apiKeyId,
      mappingId: args.target.mappingId,
      channelId: args.channel.channelId,
      upstreamTaskId: args.upstreamTaskId,
      kind: args.kind,
      status: 'queued',
      params: args.params,
      receiptTemplate: template as unknown as Record<string, unknown>,
      unitsSnapshot: String(args.units),
      expiresAt: new Date(now.getTime() + ttlMs),
      createdAt: now,
      updatedAt: now,
    });
    const result = await deps.billing.signal({
      type: 'upstream.started',
      requestId: args.requestId,
      leaseOwner: args.requestId,
      // 租约覆盖任务 TTL：worker 轮询期续租；未续到 → recoverOnce 按崩溃口径释放
      leaseMs: ttlMs + 30_000,
    });
    span.setAttributes({
      'request.id': args.requestId,
      'billing.finalize': 'task_submitted',
      'generation.kind': args.kind,
      'generation.upstream_task_id': args.upstreamTaskId ?? '',
      'generation.units_snapshot': args.units,
      'billing.state': result.status,
      'channel.final': args.channel.key,
    });
  } finally {
    span.end();
  }
}

/** 长流续租；底层流结束后先等待 durable receipt，再允许客户端看到 EOF。 */
export function withBillingLifecycle(
  deps: PipelineDeps,
  stream: ReadableStream<Uint8Array>,
  requestId: string,
  completion: Promise<void>,
): ReadableStream<Uint8Array> {
  const billing = deps.billing;
  const rateLimiter = deps.rateLimiter;
  const logger = deps.logger;
  const leaseMs = deps.env.BILLING_LEASE_SECONDS * 1_000;
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
        // 收据落库失败时内容已全部交付——把连接炸掉会让 SDK 重试、重复生成
        //（非流式同场景是 503 billing_receipt_unavailable；流式无法收回已交付
        // 内容，正确降级是照常 EOF：预扣留在 in_flight，租约过期后由租约
        // 恢复链按崩溃口径释放，责任可追溯）。
        try {
          await completion;
        } catch (err) {
          logger.error(
            { requestId, err: err instanceof Error ? err.message : String(err) },
            'durable receipt failed after stream delivered; reservation frozen for recovery',
          );
        }
      },
      cancel() {
        clear();
      },
    }),
  );
}

export { asUserSideCancel };
