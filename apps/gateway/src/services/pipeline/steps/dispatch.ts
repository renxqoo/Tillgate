import { GatewayError, UpstreamRespondError, gatewayError } from '../../../lib/errors.js';
import type { AuthContext, AuthEnv } from '../../../middleware/auth.js';
import type { Context } from 'hono';
import { estimateInputTokens } from '@ai-gateway/ai';
import { reserveFallbackDims } from './rate-limit.js';
import { attemptChannel } from './attempt.js';
import { recordEstimatedOutcome } from './finalize.js';
import {
  channelError,
  type AttemptCtx,
  type CandidateTarget,
  type ChannelError,
  type PipelineDeps,
  type PipelineKind,
  type PipelineTracers,
  type RequestBudget,
  type RequestTraceContext,
} from '../types.js';

/**
 * 第五步（调度）：候选循环 = 主模型渠道 → 全失败 → fallback 模型渠道 → 全失败 → 503。
 *
 * G3：fallback 模型的限流维在派发前判定（超限→换候选）。
 * 渠道「进货额度」精确硬闸：路由选渠前原子预留在途上游成本敞口，
 * 余额（进货额度 - 已消耗 - 在途）不足本次上游预估 → 跳过改试下一渠道（没钱即拦截）。
 *
 * state 是调用方（run.ts）的每请求失败上下文：switch 失败边执行边写；
 * respond/耗尽/未分类异常以 throw 穿出双层循环，run.ts 的 catch/finally
 * 收口（与旧实现同语义）。
 */

export interface DispatchState {
  lastError: ChannelError | null;
  deliveryAccepted: boolean;
}

export interface DispatchArgs extends Omit<DispatchConfig, 'state'> {}

interface DispatchConfig {
  c: Context<AuthEnv>;
  auth: AuthContext;
  requestId: string;
  body: Record<string, unknown>;
  externalModel: string;
  estimatedTotalTokens: number;
  kind: PipelineKind;
  targets: CandidateTarget[];
  outputCap: number;
  budget: RequestBudget;
  stream: boolean;
  requestTrace: RequestTraceContext;
  state: DispatchState;
}

export async function dispatchCandidates(
  deps: PipelineDeps,
  tracers: PipelineTracers,
  args: DispatchArgs & { state: DispatchState },
): Promise<Response> {
  const {
    c,
    auth,
    requestId,
    body,
    externalModel,
    estimatedTotalTokens,
    kind,
    targets,
    outputCap,
    budget,
    stream,
    requestTrace,
    state,
  } = args;

  for (const [targetIdx, target] of targets.entries()) {
    // G3：fallback 模型的限流维收口（主渠道全挂才走到这；超限→换候选）
    if (targetIdx > 0) {
      const fbLimited = await reserveFallbackDims(
        deps,
        auth,
        target,
        estimatedTotalTokens,
        requestId,
      );
      if (fbLimited) {
        state.lastError = fbLimited;
        continue;
      }
    }
    const channels = target.channels ?? (await deps.router.getChannels(target.realModel));
    target.channels = channels;
    if (channels.length === 0) continue;

    let attemptNo = 0;
    for (const channel of channels) {
      if (budget.signal.aborted) break;
      attemptNo += 1;
      // 渠道「进货额度」精确硬闸：路由选渠前原子预留在途上游成本敞口。
      // 余额（进货额度 - 已消耗 - 在途）不足本次上游预估 → 跳过改试下一渠道（没钱即拦截）。
      let reservation: { allowed: boolean; remaining: string };
      try {
        reservation = await deps.billing.reserveChannel({
          requestId,
          channelId: channel.channelId,
          amount: target.upstreamEstimate.toString(),
        });
      } catch (error) {
        deps.logger.warn(
          { requestId, channel: channel.key, err: (error as Error).message },
          'channel reserve failed, skipping',
        );
        state.lastError = channelError('channel_budget_exhausted', '渠道额度不足');
        continue;
      }
      if (!reservation.allowed) {
        deps.logger.warn(
          { requestId, channel: channel.key, remaining: reservation.remaining },
          'channel upstream budget exhausted, skipping',
        );
        state.lastError = channelError('channel_budget_exhausted', '渠道额度不足');
        continue;
      }
      const ctx: AttemptCtx = {
        requestId,
        model: target.realModel,
        providerName: channel.providerName,
        attemptNo,
        endpoint: kind === 'embeddings' ? 'embeddings' : undefined,
        paramRules: target.paramRules ?? undefined,
        maxOutputTokens: outputCap,
        // 每次 fallback 只拿整个请求预算的剩余值，绝不重置 deadline。
        deadlineMs: budget.remainingMs(),
        signal: budget.signal,
      };
      deps.logger.info(
        { requestId, channel: channel.key, model: target.realModel, stream },
        'candidate attempt',
      );
      const outcome = await attemptChannel(deps, tracers, {
        c,
        auth,
        requestId,
        body,
        externalModel,
        estimatedTotalTokens,
        kind,
        target,
        channel,
        ctx,
        stream,
        requestTrace,
      });
      if (outcome.kind === 'success') {
        return outcome.response;
      }
      if (outcome.kind === 'respond') {
        const estimatedCancel = outcome.error.code === 'aborted';
        if (estimatedCancel) {
          // 用户侧取消（TTFB 期，一个数据块未流动）：仅 input 估算结算，
          // 不走 request.failed（bytesRelayed=0 → output 估算为 0）。
          void deps.completions.track(
            recordEstimatedOutcome(deps, tracers, {
              auth,
              requestId,
              externalModel,
              target,
              channel,
              reason: 'aborted',
              bytesRelayed: 0,
              durationMs: Date.now(),
              inputTokens: estimateInputTokens(body, {
                providerName: channel.providerName,
                model: target.realModel,
              }),
              maxOutputTokens: outputCap,
              trace: requestTrace,
            }),
          );
        }
        // 已构建的客户端响应以信号异常穿出双层循环（run.ts 捕获后原样返回）
        throw new UpstreamRespondError(outcome.response, outcome.error, estimatedCancel);
      }
      state.lastError = outcome.error;
      if (budget.signal.aborted) break;
    }
  }
  // 全部候选耗尽：throw 统一 503（run.ts 收口渲染）
  throw exhaustedError(deps, requestId, externalModel, state.lastError);
}

/**
 * 全部候选耗尽的统一拒绝：message 用通用文案（上游原文可能带真实模型名/
 * 供应商细节）；code 统一 no_available_channel——内部失败原因
 * （circuit_open/dead_credential/channel_budget_exhausted…）泄漏渠道
 * 拓扑语义，只进日志与 trace，不出站。
 */
export function exhaustedError(
  deps: PipelineDeps,
  requestId: string,
  externalModel: string,
  lastError: ChannelError | null,
): GatewayError {
  if (lastError) {
    deps.logger.warn(
      { requestId, model: externalModel, code: lastError.code, channelHint: 'see trace' },
      'all candidates exhausted',
    );
  }
  return gatewayError('no_available_channel', {
    message: `模型「${externalModel}」所有渠道均不可用`,
    ...(lastError?.suggestion !== undefined ? { suggestion: lastError.suggestion } : {}),
  });
}
