import { generationKindDescriptor, type GenerationKind } from '@ai-gateway/ai';
import { upstreamPassthroughReject } from '../../../../lib/errors.js';
import { renderReject } from '../../../../lib/http.js';
import { sanitizeUpstreamDetail } from '../../../../lib/upstream-error-sanitize.js';
import { recordChannelFailure, recordRequest } from '../../../../lib/metrics.js';
import {
  isChannelSwitchable,
  isDeadCredentialError,
  markChannelDeadCredential,
} from '../../../routing/channel-policy.js';
import {
  channelError,
  sanitizeCtx,
  type AttemptOutcome,
  type PipelineDeps,
  type PipelineTracers,
} from '../../types.js';
import { recordTaskSubmitted, upstreamCharge } from '../finalize.js';
import type { TransportArgs } from './types.js';

/**
 * 任务族传输模式（video/music）：
 *   video —— 调上游提交（ai.chat endpoint=video）→ 解析 task_id →
 *            recordTaskSubmitted（任务行 + TTL 租约）→ 201 {id, task_id, status}
 *   music —— 不调上游（同步阻塞型，由 worker 代执行）：直接登记任务 → 201
 * 失败语义与同步尝试一致：可换渠道错误 → switch（上层换渠道/候选）；
 * 4xx 客户端问题 → 原样透传；任务行落库失败 → 503（预留保留，禁止误退款）。
 */
export async function attemptTaskSubmit(
  deps: PipelineDeps,
  tracers: PipelineTracers,
  args: TransportArgs,
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
