/**
 * 管理员认证/资料路由契约（P2;v1 routes/{auth,me}.ts 内联 zod 平移）。
 * zod 只做协议形状（长度/格式/上界），策略判定在 identity/domain（密码策略单源）。
 */
import { z } from 'zod';

export const authContracts = {
  login: z.object({
    email: z.string().trim().toLowerCase().email().max(255),
    password: z.string().min(1).max(256),
  }),
  verify: z.object({
    challengeId: z.string().uuid(),
    code: z.string().regex(/^\d{6}$/),
  }),
  changePassword: z.object({
    oldPassword: z.string().min(1).max(256),
    newPassword: z.string().min(1).max(256),
  }),
  twoFactor: z.object({ enabled: z.boolean() }),
  /** D6:管理员为本地账号用户重置密码（策略在 identity 单源校验） */
  setPassword: z.object({ password: z.string().min(1).max(256) }),
};
