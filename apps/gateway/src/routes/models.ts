import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { modelMappings } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import type { AuthEnv } from '../middleware/auth.js';
import { isModelAllowed } from '../lib/model-scope.js';

/**
 * GET /v1/models — 可用模型列表（OpenAI 格式，api-contract §2.2）
 * 鉴权后返回当前凭证可用的上架模型（status=0）。
 * scope 过滤（S3）：JWT 签了 scope.models 白名单时只返回白名单内的上架模型，
 *   防止泄漏全部模型清单（auth.allowedModels 已在鉴权阶段从 JWT scope 解析）。
 *   静态 Key（allowedModels=null）不过滤，返回全部上架模型。
 */
export function modelsRoutes(db: Db): Hono<AuthEnv> {
  return new Hono<AuthEnv>().get('/', async (c) => {
    const auth = c.var.auth;
    // 查所有上架模型
    const mappings = await db.query.modelMappings.findMany({
      where: eq(modelMappings.status, 0),
      columns: { externalName: true },
    });
    // scope 过滤：allowedModels 非空（JWT scope.models）时取交集，空/null（静态 Key）返回全部
    const all = mappings.map((m) => m.externalName);
    const models = auth.allowedModels && auth.allowedModels.length > 0
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
