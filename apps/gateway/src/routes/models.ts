import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import { isModelAllowed } from '../lib/model-scope.js';
import type { ModelRouter } from '../services/routing/model-router.js';

/**
 * GET /v1/models — 可用模型列表（OpenAI 格式，api-contract §2.2）
 * 鉴权后返回当前凭证可用的上架模型（status=0，走路由缓存）。
 * scope 过滤（S3）：JWT 签了 scope.models 白名单时只返回白名单内的上架模型，
 *   防止泄漏全部模型清单。静态 Key（allowedModels=null）不过滤，返回全部上架模型。
 */
export function modelsRoutes(router: ModelRouter): Hono<AuthEnv> {
  return new Hono<AuthEnv>().get('/', async (c) => {
    const auth = c.var.auth;
    const all = await router.listEnabledModels();
    const models =
      auth.allowedModels && auth.allowedModels.length > 0
        ? all.filter((name) => isModelAllowed(auth.allowedModels, name))
        : all;
    return c.json({
      object: 'list',
      data: models.map((name) => ({
        id: name,
        object: 'model',
        created: 0,
        owned_by: 'ai-gateway',
      })),
    });
  });
}
