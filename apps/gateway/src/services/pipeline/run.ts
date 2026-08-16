import type { Context } from 'hono';
import { getTracer } from '@ai-gateway/core';
import { renderReject } from '../../lib/http.js';
import { GatewayError, UpstreamRespondError } from '../../lib/errors.js';
import type { AuthEnv } from '../../middleware/auth.js';
import type {
  PipelineDeps,
  PipelineKind,
  PipelineTracers,
  RequestBudget,
  RequestTraceContext,
  TpmReservation,
} from './types.js';
import { admitRequest } from './steps/admission.js';
import { resolveRequest } from './steps/resolve.js';
import { checkRateLimits } from './steps/rate-limit.js';
import { authorizeRequest } from './steps/authorize.js';
import { dispatchCandidates, type DispatchState } from './steps/dispatch.js';

/**
 * LLM 请求管线编排器（chat/completions 与 embeddings 共享，杜绝两路由漂移）。
 *
 * 异常风格（2026-08）：本文件就是请求处理的顺序清单——
 *
 *   第一步  admitRequest       准入：drain 拒绝、客户端取消、模型越权(scope)检查
 *   第二步  resolveRequest     解析：模型路由、多模态分析、输入 token 估算、候选定价
 *   第三步  checkRateLimits    限流：RPM 原子判定 → TPM 原子预占(句柄) → 免费模型日限
 *   第四步  authorizeRequest   预扣：billing_requests 足额授权（四道闸门）
 *   第五步  dispatchCandidates 执行：候选×渠道循环调上游直到成功或耗尽
 *   第六步  收尾（finally）    失败信号 request.failed + TPM 句柄处置 + 资源释放
 *
 * 错误语义分级（结构化落地，三条路径类型上不相交）：
 *   - 可预期拒绝 = 步骤 throw GatewayError → 本文件唯一 catch 收口渲染（4xx/429/402/503）；
 *   - 上游响应透传 = UpstreamRespondError（内部信号，携带已构建响应）→ 原样返回；
 *   - 真正的服务端故障 = 其他异常原样上抛 → app.onError 兜底 500。
 *
 * TPM 所有权由 TpmReservation 句柄结构化：成功/取消→handedOff、计费未知→retained、
 * 未交付→release；契约由 tpm-reservation.characterization.test.ts 护栏验证。
 * finally 的失败信号只覆盖「进入候选循环之后」的未交付失败（dispatched 标记）——
 * 授权拒绝不发 request.failed（authorized 行由租约过期恢复链释放）。
 */

export type RunInference = (
  c: Context<AuthEnv>,
  kind: PipelineKind,
  body: Record<string, unknown>,
) => Promise<Response>;

export function createPipeline(deps: PipelineDeps): RunInference {
  const tracers: PipelineTracers = {
    upstream: getTracer('gateway.upstream'),
    billing: getTracer('gateway.billing'),
  };

  return async function runInference(c, kind, body) {
    const auth = c.var.auth;
    const requestId = c.var.requestId;

    const state: DispatchState = {
      lastError: null,
      deliveryAccepted: false,
    };
    // 逐步骤建立的资源（早期拒绝时为空，finally 统一处置）
    let budget: RequestBudget | null = null;
    let tpm: TpmReservation | null = null;
    let requestTrace: RequestTraceContext | null = null;
    let dispatched = false;

    try {
      // ---- 第一步：准入（drain / 取消 / scope）----
      const admitted = await admitRequest(deps, c, kind, body);
      budget = admitted.budget;

      // ---- 第二步：解析（路由 + 多模态 + 估算 + 候选定价）----
      const resolved = await resolveRequest(deps, kind, body, admitted.model, auth.coefficient);
      const estimatedTotalTokens = resolved.estInput + resolved.outputCap;

      // ---- 第三步：限流（RPM → TPM 预占 → 免费日限）----
      tpm = (await checkRateLimits(
        deps,
        auth,
        resolved.mapping,
        requestId,
        estimatedTotalTokens,
      )).tpm;

      // ---- 第四步：授权预扣（billing_requests：DB 权威）----
      const authorized = await authorizeRequest(deps, tracers, {
        auth,
        requestId,
        stream: admitted.stream,
        model: admitted.model,
        targets: resolved.targets,
        outputCap: resolved.outputCap,
      });
      requestTrace = authorized.requestTrace;

      // ---- 第五步：候选循环（主模型渠道 → fallback → 503）----
      dispatched = true;
      const response = await dispatchCandidates(deps, tracers, {
        c,
        auth,
        requestId,
        body,
        externalModel: admitted.model,
        estimatedTotalTokens,
        kind,
        targets: resolved.targets,
        outputCap: resolved.outputCap,
        budget: admitted.budget,
        stream: admitted.stream,
        requestTrace: authorized.requestTrace,
        state,
      });
      // 成功交付：TPM 移交结算回填（backfillTpm 归还 actual/释放 reserved）
      state.deliveryAccepted = true;
      tpm.handedOff();
      return response;
    } catch (error) {
      if (error instanceof GatewayError) {
        return renderReject(c, error.toReject());
      }
      if (error instanceof UpstreamRespondError) {
        state.lastError = error.channelError as DispatchState['lastError'];
        if (error.estimatedCancel) {
          // 用户取消（TTFB 期 aborted）已派发估算结算：移交结算处置
          state.deliveryAccepted = true;
          tpm?.handedOff();
        }
        return error.response;
      }
      throw error; // 真正的服务端故障 → app.onError 兜底 500
    } finally {
      // ---- 第六步：收尾（失败信号 + TPM 处置 + 资源释放）----
      if (!state.deliveryAccepted) {
        // 失败收尾 span：request.failed 是 billing 侧终态信号（released），
        // 与 recordSuccess/recordUncertain 的 finalize 同级——没有它失败 trace 无收尾节点。
        // 只覆盖进入候选循环之后的失败（授权拒绝由租约恢复链释放，不发终态信号）。
        if (dispatched && requestTrace) {
          const finalizeSpan = tracers.billing.startSpan(
            'billing.finalize',
            {},
            requestTrace.requestContext,
          );
          const failReason = state.lastError?.code ?? 'request_failed_before_delivery';
          finalizeSpan.setAttributes({
            'request.id': requestId,
            'billing.finalize': 'failed',
            'billing.failure_reason': failReason,
          });
          try {
            await deps.billing.signal({
              type: 'request.failed',
              requestId,
              reason: failReason,
              delivery: 'none',
              upstreamCharge: 'none',
            });
          } catch (e) {
            deps.logger.warn(
              { requestId, err: (e as Error).message },
              'billing failure signal failed',
            );
          } finally {
            finalizeSpan.end();
          }
        }
        // TPM 处置：未交付失败统一释放（2026-08-17 政策：unknown 不再保留）
        await tpm?.release();
      }
      budget?.dispose();
    }
  };
}
