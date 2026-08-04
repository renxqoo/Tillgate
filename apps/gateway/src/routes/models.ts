import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { modelMappings } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import type { AuthEnv } from '../middleware/auth.js';

/**
 * GET /v1/models — 可用模型列表（OpenAI 格式，api-contract §2.2）
 * 鉴权后返回当前凭证可用的上架模型（status=0）。
 * scope 过滤：JWT 的 scope.models 配了只返回 scope 内的（静态 Key 不过滤）。
 */
export function modelsRoutes(db: Db): Hono<AuthEnv> {
  return new Hono<AuthEnv>().get('/', async (c) => {
    const auth = c.var.auth;
    // 查所有上架模型
    const mappings = await db.query.modelMappings.findMany({
      where: eq(modelMappings.status, 0),
      columns: { externalName: true },
    });
    // scope 过滤（JWT scope.models 配了只返回匹配的）
    let models = mappings.map((m) => m.externalName);
    if (auth.credentialType === 'jwt') {
      // JWT scope 内有 models 限制时过滤（需要从 auth 取 scope——当前 AuthContext 没存 scope）
      // 最小闭环：JWT 不过滤（scope.models 过滤后续加，需要 AuthContext 存 scope）
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
  });
}
