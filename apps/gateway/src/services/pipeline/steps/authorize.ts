import { Decimal } from '@ai-gateway/wallet/metering';
import { context as otelContext, trace as otelTrace } from '@opentelemetry/api';
import { SpanStatusCode, formatTraceParent } from '@ai-gateway/core';
import { GatewayError, translateAuthorizeError } from '../../../lib/errors.js';
import type { AuthContext } from '../../../middleware/auth.js';
import type { PipelineDeps, PipelineTracers, CandidateTarget } from '../types.js';

/**
 * 第四步：授权预扣（billing_requests 足额授权，DB 权威）。
 *
 * durable receipt 携带实际成功渠道价格快照；任意成功响应缺少可信 usage →
 * 完成态缺 usage 则估算结算（2026-08-17 政策）；估算值只用于授权上限，不替代真实结算（requirements 5.11）。
 */

export interface AuthorizeResult {
  authorization: Awaited<ReturnType<PipelineDeps['billing']['authorize']>>;
  /** 请求级链路上下文：后续所有 span 的父（含根 span traceparent，落列供 worker 挂回） */
  requestTrace: { requestContext: ReturnType<typeof otelContext.active> };
  /** 候选链最贵预扣估算（元，日志/拒绝文案用） */
  maxEstimate: Decimal;
}

export interface AuthorizeArgs {
  auth: AuthContext;
  requestId: string;
  stream: boolean;
  /** 客户端请求的对外模型名 */
  model: string;
  targets: CandidateTarget[];
  outputCap: number;
}

/**
 * 授权拒绝统一抛 GatewayError（run.ts 边界收口渲染并释放 TPM）；
 * 未分类异常原样上抛——那是真正的服务端故障（500 路径）。
 */
export async function authorizeRequest(
  deps: PipelineDeps,
  tracers: PipelineTracers,
  args: AuthorizeArgs,
): Promise<AuthorizeResult> {
  const { auth, requestId, stream, model, targets, outputCap } = args;
  // ---- 足额授权（billing_requests：DB 权威）----
  const maxEstimate = targets.reduce(
    (max, t) => (t.estimate.gt(max) ? t.estimate : max),
    new Decimal(0),
  );
  // 请求级链路上下文：后续所有 span（authorize/upstream/finalize）的父
  const requestTrace = { requestContext: otelContext.active() };
  // 根 span traceparent：落列 billing_requests，worker 结算时挂回同一 trace
  const rootSpanContext = otelTrace.getSpan(requestTrace.requestContext)?.spanContext();
  const traceParent = rootSpanContext ? formatTraceParent(rootSpanContext) : null;

  const authSpan = tracers.billing.startSpan('billing.authorize');
  authSpan.setAttribute('request.id', requestId);
  try {
    const authorization = await deps.billing.authorize({
      requestId,
      userId: auth.userId,
      apiKeyId: auth.apiKeyId,
      appId: auth.appId,
      stream,
      traceParent,
      reservationLimit: String(deps.env.BILLING_RESERVATION_MAX),
      authorizationTtlMs: deps.env.BILLING_AUTHORIZATION_TTL_SECONDS * 1_000,
      quote: {
        maxOutputTokens: outputCap,
        // 整条候选链（主模型 + fallback）全部为显式免费模型才允许 0 元授权；
        // 任一 fallback 收费则按最贵候选正常预扣，杜绝免费主模型降到收费模型后透支。
        explicitlyFree: targets.length > 0 && targets.every((t) => t.isFree),
        candidates: targets.map((target) => ({
          mappingId: target.mappingId,
          externalModel: model,
          realModel: target.realModel,
          inputPrice: target.inputPrice,
          outputPrice: target.outputPrice,
          cacheInputPrice: target.cacheInputPrice,
          unitPrice: target.unitPrice,
          coefficient: target.coefficient,
          inputTokenUpperBound: target.inputTokenUpperBound,
          unitUpperBound: target.unitUpperBound,
          billingPolicyFingerprint: target.billingPolicyFingerprint,
        })),
      },
    });
    authSpan.setAttributes({
      'billing.result': 'authorized',
      // 预估敞口（非冻结额），结算按实扣
      'billing.amount_reserved': authorization.reservedAmount,
      'billing.available_balance': authorization.availableBalance,
      'billing.replayed': authorization.replayed,
    });
    deps.logger.debug(
      {
        requestId,
        userId: auth.userId,
        maxEstimate: maxEstimate.toString(),
        reservedAmount: authorization.reservedAmount,
      },
      'billing authorized',
    );
    return { authorization, requestTrace, maxEstimate };
  } catch (error) {
    // 授权拒绝统一翻译（表驱动单一真相）：已分类拒绝直接 throw GatewayError
    // （携带 span 属性与 backlog 日志负载）；未分类 = 真正的服务端故障，原样上抛。
    try {
      translateAuthorizeError(error, {
        maxEstimate: maxEstimate.toString(),
        reservationMax: String(deps.env.BILLING_RESERVATION_MAX),
      });
    } catch (translated) {
      if (translated instanceof GatewayError) {
        authSpan.setAttributes({
          'billing.result': 'rejected',
          'billing.reject_code': translated.code,
          'billing.amount_required': maxEstimate.toString(),
        });
        authSpan.setStatus({ code: SpanStatusCode.ERROR, message: translated.code });
        if (translated.log) {
          deps.logger.error(
            { requestId, ...translated.log },
            'billing settlement backlog closed admission',
          );
        }
      }
      throw translated;
    }
    authSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'unclassified' });
    throw error;
  } finally {
    authSpan.end();
  }
}
