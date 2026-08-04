import { Hono } from 'hono'

/**
 * GET /v1/models — 可用模型列表（OpenAI 格式）
 * TODO(gateway): 鉴权（双凭证）→ 按凭证 scope 过滤上架模型
 */
export const modelsRoutes = new Hono().get('/', (c) =>
  c.json({
    object: 'list',
    data: [],
  }),
)
