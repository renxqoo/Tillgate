import { Hono } from 'hono';

/**
 * POST /v1/chat/completions — 对话补全（OpenAI 格式，含 SSE 流式）
 * TODO(gateway): 完整链路——鉴权 → 预扣 → 限流 → 路由 → 渠道选择 → ai 包调用 → 计量事件
 */
export const chatCompletionsRoutes = new Hono().post('/', (c) =>
  c.json(
    {
      error: {
        message: 'gateway 主链路实现中（下一阶段）',
        type: 'not_implemented',
        code: 'not_implemented',
        param: null,
        request_id: null,
        suggestion: null,
      },
    },
    501,
  ),
);
