import { Hono } from 'hono'

/**
 * POST /oauth/token — 企业 Agent 换 Token（client_credentials）
 * TODO(gateway): Basic Auth / body 传参 → App 校验 → 签发 JWT（coefficient 快照）
 */
export const oauthTokenRoutes = new Hono().post('/', (c) =>
  c.json(
    {
      error: 'invalid_request',
      error_description: 'oauth 签发实现中（下一阶段）',
    },
    400,
  ),
)
