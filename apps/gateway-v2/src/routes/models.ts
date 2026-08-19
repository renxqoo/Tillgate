/**
 * GET /v1/models + /:model —— 上架模型目录（OpenAI 形状；老网关同款）。
 * 数据来自 model_mappings(status=0)；鉴权已由 /v1/* 中间件覆盖。
 */
import { Hono } from 'hono';
import type { Db, Repositories } from '@ai-gateway/repository';
import { createRepositories } from '@ai-gateway/repository';
import { readOnly } from '@ai-gateway/service';
import type { RunContext } from '@ai-gateway/service';
import type { AuthEnv } from '../middleware/api-key.js';
import { AppError } from '../http/error-map.js';

export function modelsRoutes(deps: { db: Db; repos?: Repositories; ctx: RunContext }): Hono<AuthEnv> {
  const repos = deps.repos ?? createRepositories();
  const app = new Hono<AuthEnv>();

  app.get('/', async (c) => {
    const all = await repos.modelMapping.listEnabledModels(readOnly(deps.ctx, deps.db));
    return c.json({
      object: 'list',
      data: all.map((m) => ({
        id: m.externalName,
        object: 'model',
        owned_by: 'ai-gateway',
        pricing_unit: m.pricingUnit,
      })),
    });
  });

  app.get('/:model', async (c) => {
    const model = c.req.param('model');
    const all = await repos.modelMapping.listEnabledModels(readOnly(deps.ctx, deps.db));
    const found = all.find((m) => m.externalName === model);
    if (!found) throw new AppError(404, 'model_not_found', `模型「${model}」不存在`);
    return c.json({ id: found.externalName, object: 'model', owned_by: 'ai-gateway', pricing_unit: found.pricingUnit });
  });

  return app;
}
