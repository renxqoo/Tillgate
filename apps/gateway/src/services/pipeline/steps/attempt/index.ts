import type { ChannelDesc } from '@ai-gateway/ai';
import { isTaskKind } from '@ai-gateway/ai';
import { SpanStatusCode } from '@ai-gateway/core';
import {
  channelError,
  upstreamLeaseMs,
  type AttemptOutcome,
  type AttemptTraceContext,
  type PipelineDeps,
  type PipelineTracers,
} from '../../types.js';
import { checkChannelLimits } from '../rate-limit.js';
import { attemptStream } from './stream.js';
import { attemptNonStream } from './non-stream.js';
import { attemptTaskSubmit } from './task-submit.js';
import type { AttemptArgs } from './types.js';

/**
 * 第五步（执行器）attempt/：单渠道尝试的传输模式族——
 *
 *   index         attemptChannel：渠道限流 → 租约 → 按请求形态分派传输模式
 *   stream        流式（stream.relay 生命周期、TTFB、责任域三分岔）
 *   non-stream    非流式（模态计量、估算结算、二进制透传）
 *   task-submit   任务族（video/music 提交、两阶段任务行 + TTL 租约）
 *   types         族契约（AttemptArgs / TransportArgs）
 *
 * 失败语义三路统一：switch（可换渠道，上层候选循环继续）/ respond（4xx 客户端
 * 问题原码透传）/ throw（未分类 = 真服务端故障，run.ts 兜底 500）。
 */

export type { AttemptArgs, TransportArgs } from './types.js';

export async function attemptChannel(
  deps: PipelineDeps,
  tracers: PipelineTracers,
  args: AttemptArgs,
): Promise<AttemptOutcome> {
  const { requestId, target, channel, ctx, stream, kind } = args;
  const { logger } = deps;

  // ---- 渠道级限流（保护上游 API key 配额；超限换下一个渠道）----
  const limited = await checkChannelLimits(deps, channel, args.estimatedTotalTokens, requestId);
  if (limited) {
    return { kind: 'switch', error: limited };
  }

  const channelDesc: ChannelDesc = {
    baseUrl: channel.baseUrl,
    apiKey: channel.apiKey,
    protocol: channel.protocol,
  };

  // ---- 任务族（execution ≠ sync）：提交即返回。upstream.started（带 TTL 租约）在
  // recordTaskSubmitted 内与任务行同序落库，不走下面的同步请求租约。----
  if (isTaskKind(kind)) {
    const upSpan = tracers.upstream.startSpan(`upstream ${channel.providerName}`);
    upSpan.setAttributes({
      'channel.id': channel.channelId,
      'channel.key': channel.key,
      'ai.model': target.realModel,
      'channel.attempt': ctx.attemptNo,
      'request.id': requestId,
      'generation.kind': kind,
    });
    try {
      const outcome = await attemptTaskSubmit(deps, tracers, {
        ...args,
        channelDesc,
        trace: { requestContext: args.requestTrace.requestContext, upSpan },
      });
      if (outcome.kind === 'success') {
        upSpan.setAttribute('http.status_code', 201);
      } else if (outcome.error) {
        upSpan.setAttributes({
          'http.status_code': outcome.error.status,
          'upstream.error_code': outcome.error.code,
        });
        upSpan.setStatus({ code: SpanStatusCode.ERROR, message: outcome.error.code });
      }
      return outcome;
    } catch (err) {
      logger.error({ requestId, channel: channel.key, err }, 'generation submit unexpected error');
      upSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      return {
        kind: 'switch',
        error: channelError('upstream_error', '网关内部错误', 500, 'unknown'),
      };
    } finally {
      upSpan.end();
    }
  }

  await deps.billing.signal({
    type: 'upstream.started',
    requestId,
    leaseOwner: requestId,
    // 租约覆盖整个请求预算（非流式无续期；deadline 是权威时间上界）
    leaseMs: upstreamLeaseMs(deps.env.BILLING_LEASE_SECONDS * 1_000, ctx.deadlineMs),
  });

  // 上游调用 Span（渠道级，OTel 链路追踪）
  const upSpan = tracers.upstream.startSpan(`upstream ${channel.providerName}`);
  upSpan.setAttributes({
    'channel.id': channel.channelId,
    'channel.key': channel.key,
    'ai.model': target.realModel,
    'ai.attempt_stream': stream,
    // 第几次渠道尝试（路线图节点显性化「换了 N 次渠」）
    'channel.attempt': ctx.attemptNo,
    'request.id': requestId,
  });
  const attemptTrace: AttemptTraceContext = {
    requestContext: args.requestTrace.requestContext,
    upSpan,
  };
  try {
    const outcome = stream
      ? await attemptStream(deps, tracers, {
          ...args,
          channelDesc,
          trace: attemptTrace,
        })
      : await attemptNonStream(deps, tracers, {
          ...args,
          channelDesc,
          trace: attemptTrace,
        });
    // 终态属性：上游真实状态码语义（成功 200 / 失败用映射后的错误码与状态）
    if (outcome.kind === 'success') {
      upSpan.setAttribute('http.status_code', 200);
    } else if (outcome.error) {
      upSpan.setAttributes({
        'http.status_code': outcome.error.status,
        'upstream.error_code': outcome.error.code,
      });
      // 失败尝试必须在 span 状态上可见（图谱标红 + errorText=错误码）；
      // aborted 是用户侧取消，按链路政策不标红（graph.ts 口径）。
      if (outcome.error.code !== 'aborted') {
        upSpan.setStatus({ code: SpanStatusCode.ERROR, message: outcome.error.code });
      }
    }
    return outcome;
  } catch (err) {
    logger.error({ requestId, channel: channel.key, err }, 'candidate unexpected error');
    upSpan.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      kind: 'switch',
      error: channelError('upstream_error', '网关内部错误', 500, 'unknown'),
    };
  } finally {
    upSpan.end();
  }
}
