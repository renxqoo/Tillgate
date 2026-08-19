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
    const auth = c.get('auth');
    const all = await repos.modelMapping.listEnabledModels(readOnly(deps.ctx, deps.db));
    const allowed = auth?.allowedModels ?? null;
    const names = all
      .filter((m) => allowed == null || allowed.includes(m.externalName))
      .map((m) => m.externalName);
    // 协议形状（v1 对位）：Anthropic SDK（anthropic-version 头）/ Gemini SDK
    // （x-goog-api-key 头）各自的原生列表形——OpenAI 形为缺省
    if (c.req.header('anthropic-version')) {
      return c.json({
        data: names.map((name) => ({ id: name, display_name: name, created_at: '2026-01-01T00:00:00Z', type: 'model' })),
        first_id: names[0] ?? null,
        last_id: names[names.length - 1] ?? null,
        has_more: false,
      });
    }
    if (c.req.header('x-goog-api-key')) {
      return c.json({
        models: names.map((name) => ({
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
      data: all
        .filter((m) => allowed == null || allowed.includes(m.externalName))
        .map((m) => ({
          id: m.externalName,
          object: 'model',
          owned_by: 'ai-gateway',
          pricing_unit: m.pricingUnit,
        })),
    });
  });

  app.get('/:model', async (c) => {
    const model = c.req.param('model').replace(/^models\//, ''); // Gemini 风格前缀剥离
    const auth = c.get('auth');
    const all = await repos.modelMapping.listEnabledModels(readOnly(deps.ctx, deps.db));
    const found = all.find((m) => m.externalName === model);
    if (!found || ((auth?.allowedModels ?? null) != null && !auth!.allowedModels!.includes(model))) {
      // 白名单外与不存在同口径 404（不泄漏目录）
      throw new AppError(404, 'model_not_found', `模型「${model}」不存在`);
    }
    return c.json({ id: found.externalName, object: 'model', owned_by: 'ai-gateway', pricing_unit: found.pricingUnit });
  });

  return app;
}
