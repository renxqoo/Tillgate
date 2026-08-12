/**
 * 管理面鉴权中间件已抽到 @ai-gateway/identity（adminAuthMiddleware）。
 * 本文件重新导出，保持现有 import 可用。
 *
 * 拆分后：adminAuthMiddleware 改读 ADMIN_SESSION_COOKIE + 验签 ADMIN_JWT_SECRET + 回查 admins 表。
 *        这是「用户面 bug 无法波及管理员」的执行点。
 */
export { adminAuthMiddleware } from '@ai-gateway/identity';
