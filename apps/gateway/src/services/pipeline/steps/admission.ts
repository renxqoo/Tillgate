import type { Context } from 'hono';
import type { AuthEnv } from '../../../middleware/auth.js';
import { isModelAllowed } from '../../../lib/model-scope.js';
import { gatewayError } from '../../../lib/errors.js';
import { ServiceDrainingError } from '../../runtime/request-lifecycle.js';
import type { PipelineDeps, PipelineKind, RequestBudget } from '../types.js';

/**
 * 第一步：准入（drain / 客户端取消 / 模型越权三查）。
 *
 * 顺序即安全语义：drain 拒绝在资源分配之前；scope 校验（S3）在任何
 * 路由/计费之前——拿到受限凭证却调贵模型的越权计费在结构上不可达。
 * 可预期拒绝统一 throw GatewayError（run.ts 边界一个 catch 收口渲染）。
 */

export interface AdmissionResult {
  budget: RequestBudget;
  /** 对外模型名（客户端请求体里的 model） */
  model: string;
  stream: boolean;
}

export async function admitRequest(
  deps: PipelineDeps,
  c: Context<AuthEnv>,
  kind: PipelineKind,
  body: Record<string, unknown>,
): Promise<AdmissionResult> {
  const model = body.model as string;
  const stream = kind === 'chat' && body.stream === true;

  let budget: RequestBudget;
  try {
    budget = deps.lifecycle.create(c.req.raw.signal);
  } catch (error) {
    // drain 期间拒绝新请求（在途请求不受影响，见 request-lifecycle）
    if (error instanceof ServiceDrainingError) {
      throw gatewayError('server_draining');
    }
    throw error;
  }
  if (budget.signal.aborted) {
    throw gatewayError('request_cancelled');
  }

  // ---- JWT scope.models 越权校验（S3）：白名单外的模型直接 403（防越权计费）----
  if (!isModelAllowed(c.var.auth.allowedModels, model)) {
    throw gatewayError('model_not_allowed', {
      message: `模型「${model}」不在当前凭证的可用范围内`,
    });
  }

  return { budget, model, stream };
}
