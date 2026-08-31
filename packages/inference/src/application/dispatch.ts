import { sanitizeUpstreamDetail, type UpstreamError } from '@tillgate/ai';
import { routeFailure } from '../domain/routing/switchable';
import type { PreparedRequest } from './quote';
import type { AttemptContext, AttemptOutcome, ExecutionDeps } from './failover';

/** 上游 4xx 透传终局（OpenAI 兼容语义：客户端问题原码返回——不吞成 502、不空耗 fallback） */
export interface PassthroughDelivered {
  ok: true;
  passthrough: true;
  status: number;
  code: string;
  message?: string;
}

/**
 * 出站错误面脱敏（单点收口）：上游 passthrough message 在此过「内部模型名 → 对外名
 * 替换（候选链规范名 + 本次渠道绑定出站名逐项配对——厂商报错文本里是厂商自己的拼写）
 * + 内部寻址遮蔽 + 512 截断」。流式首字节前 / 非流式 / 任务提交三路共用本点——
 * 事件面、rawBody 与日志保真，仅出站字节脱敏。
 */
function outboundMessageOf(
  error: UpstreamError,
  prepared: PreparedRequest,
  channel: { upstreamModel: string },
): string | undefined {
  if (error.message === error.kind) return undefined;
  const redactions = prepared.candidates
    .filter((candidate) => candidate.realModel !== candidate.externalModel)
    .map((candidate) => ({ needle: candidate.realModel, replacement: candidate.externalModel }));
  if (channel.upstreamModel !== prepared.externalModel) {
    redactions.push({ needle: channel.upstreamModel, replacement: prepared.externalModel });
  }
  const sanitized = sanitizeUpstreamDetail(error.message, { redactions });
  return sanitized.length > 0 ? sanitized : undefined;
}

/**
 * 上游失败分派（非流式 / 流式首字节前共用）：
 * 可换 → 换渠道；4xx → 透传终局（收尾后原码返回）；其余 → 换候选。
 * 跨请求记忆记账：429/quota 进惩罚箱、死凭据按 channel 维计数（保护面）。
 * 惩罚箱是路由信号，单渠道直连（policy.enabled=false）不写（用户裁决 D3）；
 * 记账 await：同请求的有界等待判定/下一渠道的条件门消费该状态，
 * fire-and-forget 会因 CAS 读写竞态恒读到未落地（有界等待对当轮 429 失效）
 */
export async function dispatchFailure(
  deps: ExecutionDeps,
  ctx: AttemptContext,
  error: UpstreamError,
): Promise<AttemptOutcome<PassthroughDelivered>> {
  const smartRouting = deps.policy.latest().enabled;
  if (smartRouting && error.kind === 'rate_limited') {
    await deps.memory.recordPenalty(ctx.channel.channelId, 'rate_limited', error.retryAfterMs);
  } else if (smartRouting && error.kind === 'quota_exhausted') {
    await deps.memory.recordPenalty(ctx.channel.channelId, 'quota_exhausted');
  }
  if (error.deadCredential) {
    deps.health.recordDeadCredential(ctx.channel.channelId, true);
  }
  const action = routeFailure(error);
  if (action === 'switch_channel') return { kind: 'switch_channel', code: error.kind };
  if (action === 'respond') {
    // 透传≠免收尾：4xx = 上游确定未计费 → request.failed 三路释放后原码返回
    const status =
      error.status != null && error.status >= 400 && error.status < 500 ? error.status : 502;
    const message = outboundMessageOf(error, ctx.prepared, ctx.channel);
    const delivered = await deps.trace.withSpan(
      'billing.passthrough_4xx',
      {
        'request.id': ctx.requestId,
        'error.code': error.kind,
        'http.status_code': status,
      },
      async (span) => {
        span.setStatus({ code: 'error', message: error.kind });
        await deps.billing.signal({
          type: 'request_failed',
          requestId: ctx.requestId,
          reason: error.kind.slice(0, 64),
        });
        return {
          ok: true,
          passthrough: true,
          status,
          code: error.kind,
          ...(message != null ? { message } : {}),
        } as const;
      },
    );
    return { kind: 'respond', value: delivered };
  }
  return { kind: 'next_candidate', code: error.kind };
}
