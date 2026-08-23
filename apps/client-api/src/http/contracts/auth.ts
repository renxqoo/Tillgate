/**
 * 认证契约：注册/登录（公开，两步验证码流）/ 验码 / 改密。
 * zod 只做协议形状（长度/格式/上界），密码强度策略在 identity 域单源校验。
 */
import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(1).max(128),
  captchaToken: z.string().max(4096).optional(),
  /** 邀请归因 aff 码（u{base36}；非法形态由域规则拒绝，不阻断注册） */
  aff: z.string().trim().max(32).optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(1).max(128),
});

export const verifySchema = z.object({
  challengeId: z.string().uuid(),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'verification code must be 6 digits'),
  aff: z.string().trim().max(32).optional(),
});

export const passwordSchema = z.object({
  oldPassword: z.string().min(1).max(128),
  newPassword: z.string().min(1).max(128),
});

/** 找回密码第一步:仅邮箱(存在性不泄漏——响应恒 {ok:true}) */
export const forgotSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
});

/** 找回密码第二步:一次性链接令牌 + 新密码(策略在 identity 单源校验) */
export const forgotResetSchema = z.object({
  token: z.string().min(20).max(128),
  password: z.string().min(1).max(128),
});
