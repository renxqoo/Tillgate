/**
 * 认证/自身域 OpenAPI registry（routes/{auth,me}.ts 的契约面）。
 * 请求 schema 引用 contracts/auth.ts;响应 wire 形状在此声明（生成链单一真相）。
 */
import { z } from 'zod';
import { authContracts } from '../contracts/auth';
import { okTrue, type OpenApiEndpoint } from './shared';

/** 当前登录管理员（GET /v1/me） */
export const adminMeInfoSchema = z
  .object({
    id: z.number(),
    email: z.string(),
    displayName: z.string().nullable(),
    lastLoginAt: z.string().nullable(),
    twoFactorEnabled: z.boolean().optional().describe('邮箱验证码二次登录已开启'),
  })
  .meta({ id: 'AdminMeInfo', description: '当前登录管理员 (GET /v1/me,admin-api 管理面)' });

/** 登录两步流:密码正确后按 2FA 开关二分（发码半程 / 直接签发会话） */
const loginResponseSchema = z.union([
  z.object({
    twoFactorRequired: z.literal(true),
    challengeId: z.string().describe('2FA 半程挑战 id（verify 免二次鉴别）'),
  }),
  z.object({ token: z.string().describe('Bearer 会话 JWT'), adminId: z.number() }),
]);

/** 验码/改密后的会话签发面 */
const tokenResponseSchema = z.object({
  token: z.string().describe('Bearer 会话 JWT'),
  adminId: z.number(),
});

export const authEndpoints: readonly OpenApiEndpoint[] = [
  {
    method: 'post',
    path: '/v1/auth/login',
    tag: 'auth',
    summary: '管理员登录（可选 2FA 邮箱码两步流）',
    auth: 'public',
    body: authContracts.login,
    response: { schema: loginResponseSchema },
    errors: [400, 401, 429, 503],
  },
  {
    method: 'post',
    path: '/v1/auth/login/verify',
    tag: 'auth',
    summary: '2FA 邮箱验证码验签换会话',
    auth: 'public',
    body: authContracts.verify,
    response: { schema: tokenResponseSchema },
    errors: [400, 401, 503],
  },
  {
    method: 'post',
    path: '/v1/auth/logout',
    tag: 'auth',
    summary: '登出（jti 入吊销面）',
    response: { schema: okTrue },
    errors: [401],
  },
  {
    method: 'get',
    path: '/v1/me',
    tag: 'me',
    summary: '当前管理员资料',
    response: { schema: adminMeInfoSchema },
    errors: [401, 404],
  },
  {
    method: 'post',
    path: '/v1/me/password',
    tag: 'me',
    summary: '改密（验旧密 + 全网旧会话即刻下线,同拍返回新 token）',
    body: authContracts.changePassword,
    response: { schema: tokenResponseSchema },
    errors: [400, 401],
  },
  {
    method: 'post',
    path: '/v1/me/two-factor',
    tag: 'me',
    summary: '2FA 开关（开启前置 SMTP,fail-closed）',
    body: authContracts.twoFactor,
    response: {
      schema: z.object({ twoFactorEnabled: z.boolean().describe('开关后的生效状态' )}),
    },
    errors: [400, 401, 503],
  },
];
