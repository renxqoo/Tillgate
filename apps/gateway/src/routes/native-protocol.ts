/**
 * 原生协议端点（v1 对位）：模型名在 URL 的路径参数形态——端点注册表（固定路径）表达不了。
 *   POST /v1beta/models/:modelAction  Gemini generateContent / streamGenerateContent
 *
 * 转换函数全部来自共享包 packages/ai（gemini-chat 协议模块——与出站共用一套真相）；
 * 译为规范形后走 chat 管线（鉴权/白名单/计费/限流与所有端点完全一致）。
 */
import { Hono } from 'hono';
import {
  canonicalStreamToGeminiStream,
  chatResponseToGemini,
  geminiRequestToChat,
} from '@ai-gateway/ai';
import type { createRunChat } from '../pipeline/run-chat.js';
import type { ChatCompletionBody, ChatResponse } from '../pipeline/run-chat.js';
import { AppError } from '../http/error-map.js';
import type { AuthEnv } from '../middleware/api-key.js';

type RunChat = ReturnType<typeof createRunChat>;

const GEMINI_ACTION_RE = /^([a-zA-Z0-9._-]+):(generateContent|streamGenerateContent)$/;

export function geminiNativeRoutes(runChat: RunChat): Hono<AuthEnv> {
  return new Hono<AuthEnv>().post('/v1beta/models/:modelAction', async (c) => {
    const modelAction = c.req.param('modelAction');
    const m = GEMINI_ACTION_RE.exec(modelAction ?? '');
    if (!m) {
      throw new AppError(404, 'not_found', '路径不存在（支持 :generateContent / :streamGenerateContent）');
    }
    const model = m[1]!;
    const stream = m[2] === 'streamGenerateContent';
    const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!raw) throw new AppError(400, 'invalid_body', '请求体必须为 JSON 对象');

    const auth = c.get('auth');
    const canonical = geminiRequestToChat(raw, model) as unknown as ChatCompletionBody;
    canonical.model = model;
    canonical.stream = stream;

    const result = await runChat(auth.ctx, {
      userId: auth.userId,
      apiKeyId: auth.apiKeyId,
      appId: auth.appId,
      allowedModels: auth.allowedModels,
      rpmLimit: auth.rpmLimit,
      tpmLimit: auth.tpmLimit,
      userRpmLimit: auth.userRpmLimit,
      userTpmLimit: auth.userTpmLimit,
    }, canonical, 'chat');

    return encodeGemini(result, model);
  });
}

function encodeGemini(result: ChatResponse, model: string): Response {
  if ('stream' in result) {
    return new Response(canonicalStreamToGeminiStream(result.stream, model), {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  }
  if ('rawBody' in result) {
    return new Response(result.rawBody, { status: 200, headers: { 'content-type': result.rawContentType } });
  }
  return Response.json(chatResponseToGemini(result.body));
}
