import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../middleware/auth.js';
import { jsonBody } from '../lib/validation.js';
import { gatewayError } from '../lib/errors.js';
import { renderReject } from '../lib/http.js';
import type { RunInference } from '../services/pipeline/run.js';
import { encodeResponseForClient, geminiCodec } from '../services/protocol-codecs.js';

/**
 * 原生协议端点（模型名在 URL 的路径参数形态，注册表无法表达）：
 *   POST /v1beta/models/:modelAndAction  Gemini generateContent / streamGenerateContent
 *   POST /v1/engines/:model/embeddings    OpenAI 旧版 embeddings 别名
 *
 * 均翻译为规范形后走 chat / embeddings 管线；鉴权由 app.ts 的 use 前置挂载。
 */

const GEMINI_ACTION_RE = /^([a-zA-Z0-9._-]+):(generateContent|streamGenerateContent)$/;

export function nativeProtocolRoutes(runInference: RunInference): Hono<AuthEnv> {
  return new Hono<AuthEnv>()
    .post(
      '/v1beta/models/:modelAction',
      jsonBody(z.record(z.string(), z.unknown())),
      async (c) => {
        const modelAction = c.req.param('modelAction');
        const m = GEMINI_ACTION_RE.exec(modelAction ?? '');
        if (!m) {
          return renderReject(
            c,
            gatewayError('not_found', { message: '路径不存在（支持 :generateContent / :streamGenerateContent）' }).toReject(),
          );
        }
        const model = m[1]!;
        const action = m[2]!;
        const body = c.req.valid('json') as Record<string, unknown>;
        const canonical = geminiCodec.decodeRequest(body, model);
        canonical.model = model;
        if (action === 'streamGenerateContent') canonical.stream = true;
        const response = await runInference(c, 'chat', canonical);
        return encodeResponseForClient(response, geminiCodec, model);
      },
    )
    .post('/v1/engines/:model/embeddings', jsonBody(z.record(z.string(), z.unknown())), async (c) => {
      const model = c.req.param('model') ?? '';
      const body = c.req.valid('json') as Record<string, unknown>;
      return runInference(c, 'embeddings', { ...body, model });
    });
}
