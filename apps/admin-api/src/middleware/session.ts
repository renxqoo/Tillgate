/**
 * 会话中间件已抽到 @ai-gateway/identity。
 * 本文件重新导出管理面所需类型/函数，保持现有 import 可用。
 *
 * 拆分后：admin-api 不再处理用户会话（用户面 userSessionMiddleware 已随 client-api 迁出）。
 *        管理面用 adminAuthMiddleware（@ai-gateway/identity）校验管理员会话。
 */
export {
  type AdminEnv,
  type LegacyAdminEnv,
  type ClientEnv,
  type UserSessionContext,
  type AdminSessionContext,
  adminAuthMiddleware,
  tryResolveAdminSession,
  resolveUserSession,
  userSessionMiddleware,
} from '@ai-gateway/identity';
