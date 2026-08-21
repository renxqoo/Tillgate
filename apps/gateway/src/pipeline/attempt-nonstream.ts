/**
 * 非流式尝试（run-chat 候选×渠道循环的执行层之一）：同步调上游 → 成功先结算
 * 后交付（未交付不结算——结算耗尽 503 宁可让用户重试也不白送）；失败走统一分派。
 */
import { estimateOutputTokens } from '@ai-gateway/ai';
import { SpanStatusCode, withAsyncSpan } from '@ai-gateway/core';
import { AppError } from '../http/error-map.js';
import type { AttemptInput, AttemptOutcome } from './attempt-contract.js';
import { buildReceipt } from './receipt.js';
import { signalSucceededWithRetry } from './settle-retry.js';

export async function attemptNonStream(input: AttemptInput): Promise<AttemptOutcome> {
  const {
    tracer,
    ctx,
    deps,
    requestId,
    auth,
    body,
    upstreamBody,
    endpoint,
    candidate,
    channel,
    channelAttempt,
  } = input;
  const startedAt = Date.now();
  const result = await withAsyncSpan(
    tracer,
    'upstream.attempt',
    {
      'request.id': requestId,
      'user.id': auth.userId,
      'channel.key': channel.channelName,
      'channel.attempt': channelAttempt,
      'ai.model': candidate.realModel,
      'upstream.stream': false,
    },
    async (span) => {
      const r = await deps.upstream.chat(channel, {
        requestId,
        realModel: candidate.realModel,
        externalModel: body.model,
        endpoint,
        body: upstreamBody,
      });
      if (r.ok) {
        span.setAttributes({
          'upstream.ok': true,
          'upstream.duration_ms': Date.now() - startedAt,
          ...(r.usage
            ? { 'tokens.input': r.usage.inputTokens, 'tokens.output': r.usage.outputTokens }
            : {}),
        });
      } else {
        span.setAttributes({
          'upstream.ok': false,
          'upstream.error_code': r.error.code ?? 'upstream_error',
          ...(r.status != null ? { 'http.status_code': r.status } : {}),
          ...(r.error.deadCredential ? { 'upstream.dead_credential': true } : {}),
        });
        span.setStatus({ code: SpanStatusCode.ERROR, message: r.error.code ?? 'upstream_error' });
      }
      return r;
    },
  );
  const durationMs = Date.now() - startedAt;
  if (result.ok) {
    // 结算 signal 退避重试：瞬时 DB 抖动自愈；耗尽上抛 503（未交付不结算——
    // 与流式「已交付尽力结算」纪律相反，宁可让用户重试也不白送）
    const receipt = buildReceipt({
      requestId,
      userId: auth.userId,
      apiKeyId: auth.apiKeyId,
      appId: auth.appId ?? null,
      candidate,
      externalModel: body.model,
      channelId: channel.channelId,
      channelKey: channel.channelName,
      durationMs,
      fx: await input.fxPromise,
      body: body as Record<string, unknown>,
      responseBody: result.body,
      usage: result.usage
        ? {
            estimated: false,
            inputTokens: result.usage.inputTokens,
            cachedInputTokens: result.usage.cachedInputTokens,
            outputTokens: result.usage.outputTokens,
            ...((result.usage.cacheWriteTokens ?? 0) > 0
              ? { cacheWriteTokens: result.usage.cacheWriteTokens }
              : {}),
          }
        : {
            estimated: true,
            inputTokens: input.bpeInput,
            outputTokens: estimateOutputTokens(result.body, { model: body.model }),
          },
    });
    const finalized = await signalSucceededWithRetry(
      deps.billing,
      ctx,
      requestId,
      receipt,
      input.noteError,
      deps.config.signalFinalize,
    );
    if (!finalized)
      throw new AppError(
        503,
        'finalize_unavailable',
        'Request completed but settlement is temporarily unavailable, please retry',
      );
    if (result.rawBody) {
      return {
        kind: 'respond',
        response: {
          status: 200,
          rawBody: result.rawBody,
          rawContentType: result.rawContentType ?? 'application/octet-stream',
        },
      };
    }
    return { kind: 'respond', response: { status: 200, body: result.body } };
  }
  return input.dispatchFailure(channel, result.error, result.status);
}
