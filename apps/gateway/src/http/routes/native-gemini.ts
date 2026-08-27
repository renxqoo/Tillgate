import { requestSummaryOf } from '../middleware/request-log.js';
/**
 * Gemini 原生协议端点：
 * POST /v1beta/models/:modelAction —— 模型名在 URL 的路径参数形态，端点注册表表达不了。
 * 翻译函数来自 @tillgate/ai gemini-chat 协议模块（与出站共用一套真相）；译为规范形
 * 后走 chat 管线（鉴权/白名单/计费/限流与所有端点完全一致）。
 */
import { Hono, type Context } from 'hono';
import { HttpErrors } from '@tillgate/http';
import type { Inference } from '@tillgate/inference';
import {
  admissionTokenUpperBound,
  canonicalStreamToGeminiStream,
  chatResponseToGemini,
  defaultInferenceDefaults,
  geminiRequestToChat,
  type OutputCapConfig,
} from '@tillgate/inference';
import type { AuthEnv } from '../middleware/api-key';
import { requestSignalOf, toInferenceInput } from './inference-input';
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

/** Gemini 外部体 → 规范形 chat body（模型名与流式标志注入） */
function canonicalGeminiBody(
  raw: Record<string, unknown>,
  model: string,
  stream: boolean,
): Record<string, unknown> {
  const canonical = geminiRequestToChat(raw, model) as unknown as Record<string, unknown>;
  canonical.model = model;
  canonical.stream = stream;
  return canonical;
}

/** 入站解析（路径参数 + JSON 体 + 日志摘要）；不合法形态直接抛业务错 */
async function readGeminiRequest(
  c: Context<AuthEnv>,
): Promise<{ model: string; stream: boolean; raw: Record<string, unknown> }> {
  const parsed = parseModelAction(c.req.param('modelAction'));
  if (parsed == null) {
    throw HttpErrors.business('not_found', {
      detail: 'Path not found (supported: :generateContent / :streamGenerateContent)',
    });
  }
  const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const summary = requestSummaryOf(c.req.method, raw);
  if (summary != null) c.set('requestLogSummary', summary);
  if (!raw) {
    throw GatewayErrors.business('invalid_body', {
      detail: 'Request body must be a JSON object',
    });
  }
  return { ...parsed, raw };
}

/** 准入预占估算（输入 + 输出上界；与 chat 端点同式——gemini 原生恒 chat 族） */
function geminiAdmissionEstimate(
  outputCap: OutputCapConfig | undefined,
  canonical: Record<string, unknown>,
): number {
  const config =
    outputCap ??
    (() => {
      const defaults = defaultInferenceDefaults().output;
      return { defaultMax: defaults.defaultMaxOutputTokens, exposureCap: defaults.exposureCap };
    })();
  return admissionTokenUpperBound('chat', canonical, config);
}

export function geminiNativeRoutes(deps: {
  inference: Inference;
  rateLimit?: RateLimitGate;
  outputCap?: OutputCapConfig;
  /** 服务端 drain 信号（与客户端断连信号合成） */
  drainSignal?: AbortSignal;
}): Hono<AuthEnv> {
  return new Hono<AuthEnv>().post('/v1beta/models/:modelAction', async (c) => {
    const { model, stream, raw } = await readGeminiRequest(c);

    const auth = c.get('auth');
    const requestId = c.get('requestId');
    const canonical = canonicalGeminiBody(raw, model, stream);

    const admit = await admitRequest(deps.rateLimit, {
      requestId,
      auth,
      estimatedTokens: geminiAdmissionEstimate(deps.outputCap, canonical),
    });
    try {
      const input = toInferenceInput({
        requestId,
        auth,
        body: canonical,
        endpoint: 'chat',
        signal: requestSignalOf(c.req.raw.signal, deps.drainSignal),
      });
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
