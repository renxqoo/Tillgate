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
  twoFactor: z.object({
    totpCode: z.string().regex(/^\d{6}$/, 'totpCode must be 6 digits'),
    enabled: z.boolean(),
  }),
  /** TOTP 确认/解绑验证码:6 位数字(TOTP)或 10 位恢复码(去易混字母表) */
  totpCode: z.object({
    code: z.string().regex(/^([0-9]{6}|[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10})$/),
  }),
  /** TOTP 第二步登录:无挑战行(TOTP 验证无状态),重验凭证 + 验证器/恢复码 */
  loginTotp: z.object({
    email: z.string().trim().toLowerCase().email().max(255),
    password: z.string().min(1).max(256),
    code: z.string().regex(/^([0-9]{6}|[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10})$/),
  }),
  /** D6:管理员为本地账号用户重置密码（策略在 identity 单源校验） */
  setPassword: z.object({ password: z.string().min(1).max(256) }),
};
