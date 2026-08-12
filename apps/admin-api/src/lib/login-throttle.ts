/**
 * 登录限流已抽到 @ai-gateway/identity（新增 namespace 参数区分用户/管理员）。
 * 本文件重新导出，保持现有 import 可用。新代码请直接 import @ai-gateway/identity。
 *
 * 注意：拆分后管理员登录调用时 namespace 应传 'admin'，与用户登录（'user'）的锁定键空间隔离。
 */
export {
  checkLoginThrottle,
  recordLoginFailure,
  resetLoginFailures,
  clientIp,
  LOGIN_FAIL_THRESHOLD,
  LOGIN_FAIL_WINDOW_S,
  LOGIN_LOCK_DURATION_S,
  type ThrottleCheck,
} from '@ai-gateway/identity';
