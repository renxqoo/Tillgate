/**
 * Gemini 原生协议端点（v1 routes/native-protocol.ts 迁移）：
 * POST /v1beta/models/:modelAction —— 模型名在 URL 的路径参数形态，端点注册表表达不了。
 * 翻译函数来自 @tillgate/ai gemini-chat 协议模块（与出站共用一套真相）；译为规范形
 * 后走 chat 管线（鉴权/白名单/计费/限流与所有端点完全一致）。
 */
import { Hono } from 'hono';
import { HttpErrors } from '@tillgate/http';
import type { Inference } from '@tillgate/inference';
import {
  canonicalStreamToGeminiStream,
  chatResponseToGemini,
  conservativeInputTokenUpperBound,
  geminiRequestToChat,
} from '@tillgate/inference';
import type { AuthEnv } from '../middleware/api-key';
import { toInferenceInput } from './inference-input';
import { admitRequest, type RateLimitGate } from '../middleware/rate-limit';
import { encodeDelivered, sseResponse } from '../openai-envelope';
import { GatewayErrors } from '../openai-error-face';

const GEMINI_ACTION_RE = /^([a-zA-Z0-9._-]+):(generateContent|streamGenerateContent)$/;

/** 解析「模型名:动作」路径参数；不匹配支持的封闭动作集 → null（含捕获组形状防御） */
function parseModelAction(
  modelAction: string | undefined,
): { model: string; stream: boolean } | null {
  const m = GEMINI_ACTION_RE.exec(modelAction ?? '');
  const [, model, action] = m ?? [];
  if (m == null || model == null || action == null) return null;
  return { model, stream: action === 'streamGenerateContent' };
}

export function geminiNativeRoutes(deps: {
  inference: Inference;
  rateLimit?: RateLimitGate;
}): Hono<AuthEnv> {
  return new Hono<AuthEnv>().post('/v1beta/models/:modelAction', async (c) => {
    const parsed = parseModelAction(c.req.param('modelAction'));
    if (parsed == null) {
      throw HttpErrors.business('not_found', {
        detail: 'Path not found (supported: :generateContent / :streamGenerateContent)',
      });
    }
    const { model, stream } = parsed;
    const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!raw) {
      throw GatewayErrors.business('invalid_body', {
        detail: 'Request body must be a JSON object',
      });
    }

    const auth = c.get('auth');
    const requestId = c.get('requestId');
    const canonical = geminiRequestToChat(raw, model) as unknown as Record<string, unknown>;
    canonical.model = model;
    canonical.stream = stream;

    const admit = await admitRequest(deps.rateLimit, {
      requestId,
      auth,
      estimatedTokens: conservativeInputTokenUpperBound(canonical),
    });
    try {
      const input = toInferenceInput({ requestId, auth, body: canonical, endpoint: 'chat' });
      const result = stream ? await deps.inference.stream(input) : await deps.inference.chat(input);
      if ('stream' in result && result.ok && result.status === 200) {
        return sseResponse(canonicalStreamToGeminiStream(result.stream, model), requestId);
      }
      return await encodeDelivered(c.json.bind(c), result, {
        model,
        requestId,
        encodeResponse: (body) => chatResponseToGemini(body),
      });
    } catch (error) {
      await admit.release();
      throw error;
    }
  });
}
