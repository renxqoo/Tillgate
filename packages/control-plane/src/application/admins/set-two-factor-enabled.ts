/** 邮箱验证码二次登录开关（SMTP 前置校验在 app 编排——port 不判 SMTP） */
import type { AdminsDeps } from './admins-shared';

export function setTwoFactorEnabled(
  deps: AdminsDeps,
  input: { adminId: number; enabled: boolean },
): Promise<void> {
  return deps.store.setTwoFactorEnabled(deps.db, input);
}
