import { estimateUsage } from '@ai-gateway/ai';
import { isModalityKind, modalityUsage } from '../../../modality-usage.js';
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
  sanitizeCtx,
  type AttemptOutcome,
  type PipelineDeps,
  type PipelineTracers,
} from '../../types.js';
import { makeReceipt, recordEstimatedOutcome, recordSuccess, upstreamCharge } from '../finalize.js';
import type { TransportArgs } from './types.js';

/** 非流式传输模式：成功 → 计量 + 透传上游响应；失败 → 换渠道或直接返回 */
export async function attemptNonStream(
  deps: PipelineDeps,
  tracers: PipelineTracers,
  args: TransportArgs,
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
