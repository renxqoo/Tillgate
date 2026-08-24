/**
 * 模型目录路由（v1 routes/models.ts 迁移）：GET /v1/models(/:model)。
 * 数据源 = control-plane 只读目录（listEnabledMappings）；白名单过滤（App JWT scope）；
 * 三协议形状（anthropic-version / x-goog-api-key 头探测）；404 不泄漏目录。
 */
import { Hono } from 'hono';
import { HttpErrors } from '@tillgate/http';
import type { EnabledModelRow } from '@tillgate/control-plane';
import type { AuthEnv } from '../middleware/api-key';

export interface ModelsReader {
  listEnabledMappings(): Promise<EnabledModelRow[]>;
}

export function modelsRoutes(reader: ModelsReader): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get('/', async (c) => {
    const auth = c.get('auth');
    const all = await reader.listEnabledMappings();
    const allowed = auth?.allowedModels ?? null;
    const visible = all.filter((m) => allowed == null || allowed.includes(m.externalName));
    const names = visible.map((m) => m.externalName);
    // 协议形状：Anthropic SDK（anthropic-version 头）/ Gemini SDK（x-goog-api-key 头）
    // 各自的原生列表形——OpenAI 形为缺省
    if (c.req.header('anthropic-version')) {
      return c.json({
        data: names.map((name) => ({
          id: name,
          display_name: name,
          created_at: '2026-01-01T00:00:00Z',
          type: 'model',
        })),
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
      data: visible.map((m) => ({
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
    const all = await reader.listEnabledMappings();
    const found = all.find((m) => m.externalName === model);
    if (!found || (auth?.allowedModels != null && !auth.allowedModels.includes(model))) {
      // 白名单外与不存在同口径 404（不泄漏目录）
      throw HttpErrors.business('not_found', { model, detail: `Model ${model} not found` });
    }
    return c.json({
      id: found.externalName,
      object: 'model',
      owned_by: 'ai-gateway',
      pricing_unit: found.pricingUnit,
    });
  });

  return app;
}
