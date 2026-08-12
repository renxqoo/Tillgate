/**
 * 会话/JWT 已抽到 @ai-gateway/identity。
 * 本文件重新导出，保持现有 `import ... from '../lib/session.js'` 可用，
 * 避免管理面路由大面积改 import。新代码请直接 import @ai-gateway/identity。
 *
 * 注意：admin-api 现在用独立的管理员会话（ADMIN_JWT_SECRET + ag_admin_session cookie），
 * 不再签发/验证用户面会话（用户会话已迁 client-api）。
 */
export {
  signSession,
  verifySession,
  SESSION_DEFAULT_TTL_S,
  SESSION_COOKIE,
  ADMIN_SESSION_COOKIE,
  cookieOptions,
  type SessionType,
  type SessionPayload,
  type SessionSignInput,
  type SessionVerifyResult,
} from '@ai-gateway/identity';
