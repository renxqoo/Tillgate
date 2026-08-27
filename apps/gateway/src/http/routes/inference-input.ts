/**
 * 推理入参组装（chat/stream 路由共用）：
 * auth 中间件的完整 AuthContext → inference 管线所需的计费/限流子集
 * （userId/apiKeyId/appId/allowedModels——RequestAuth 形状）。一处定义，
 * 各路由（端点表/engines 别名/gemini 原生/multipart 族）不再各抄一份。
 */
import type { AuthContext } from '../middleware/api-key';
import type { ChatInput, Endpoint } from '@tillgate/inference';

/** 推理入参组装（auth 取计费/限流所需子集；endpoint 随路由端点族） */
export function toInferenceInput(input: {
  requestId: string;
  auth: AuthContext;
  body: Record<string, unknown>;
  endpoint: Endpoint;
  /** 客户端断连取消信号（c.req.raw.signal；贯通到上游 fetch 与终止分类） */
  signal?: AbortSignal;
}): ChatInput {
  const { requestId, auth, body, endpoint, signal } = input;
  return {
    requestId,
    auth: {
      userId: auth.userId,
      apiKeyId: auth.apiKeyId,
      appId: auth.appId,
      allowedModels: auth.allowedModels,
    },
    body,
    endpoint,
    ...(signal != null ? { signal } : {}),
  };
}
