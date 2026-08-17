import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import { isModelAllowed } from '../lib/model-scope.js';
import type { ModelRouter } from '../services/routing/model-router.js';

/**
 * GET /v1/models — 可用模型列表（按客户端协议三态输出，api-contract §2.2）
 * 鉴权后返回当前凭证可用的上架模型（status=0，走路由缓存）。
 * scope 过滤（S3）：JWT 签了 scope.models 白名单时只返回白名单内的上架模型，
 *   防止泄漏全部模型清单。静态 Key（allowedModels=null）不过滤，返回全部上架模型。
 * 格式检测（与 new-api 语义对齐）：
 *   anthropic-version 头 → Anthropic {data:[{id,...}]}（无 object 包装差异同构）
 *   x-goog-api-key 头   → Gemini {models:[{name:'models/x',...}]}
 *   缺省                → OpenAI {object:'list', data:[{id,object:'model',...}]}
 */
export function modelsRoutes(router: ModelRouter): Hono<AuthEnv> {
  return new Hono<AuthEnv>()
    .get('/', async (c) => {
      const auth = c.var.auth;
      const all = await router.listEnabledModels();
      const models =
        auth.allowedModels && auth.allowedModels.length > 0
          ? all.filter((name) => isModelAllowed(auth.allowedModels, name))
          : all;
      if (c.req.header('anthropic-version')) {
        return c.json({
          data: models.map((name) => ({ id: name, display_name: name, created_at: '2026-01-01T00:00:00Z', type: 'model' })),
          first_id: models[0] ?? null,
          last_id: models[models.length - 1] ?? null,
          has_more: false,
        });
      }
      if (c.req.header('x-goog-api-key')) {
        return c.json({
          models: models.map((name) => ({
            name: `models/${name}`,
            displayName: name,
            baseModelId: '',
            description: '',
            inputTokenLimit: 0,
            outputTokenLimit: 0,
            supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
          })),
          nextPageToken: null,
        });
      }
      return c.json({
        object: 'list',
        data: models.map((name) => ({
          id: name,
          object: 'model',
          created: 0,
          owned_by: 'ai-gateway',
        })),
      });
    })
    .get('/:model', async (c) => {
      const auth = c.var.auth;
      const name = c.req.param('model')?.replace(/^models\//, '') ?? '';
      const all = await router.listEnabledModels();
      if (!all.includes(name) || !isModelAllowed(auth.allowedModels, name)) {
        return c.json({ error: { message: `model '${name}' not found`, type: 'invalid_request_error', code: 'model_not_found' } }, 404);
      }
      return c.json({ id: name, object: 'model', created: 0, owned_by: 'ai-gateway' });
    });
}
