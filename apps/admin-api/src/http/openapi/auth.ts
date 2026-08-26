/**
 * 认证/自身域 OpenAPI registry（routes/{auth,me}.ts 的契约面）。
 * 请求 schema 引用 contracts/auth.ts;响应 wire 形状在此声明（生成链单一真相）。
 */
import * as z from 'zod';
import { authContracts } from '../contracts/auth';
import { okTrue, type OpenApiEndpoint } from './shared';

/** 当前登录管理员（GET /v1/me;role/permissions = RBAC 前端导航过滤单一事实来源） */
export const adminMeInfoSchema = z
  .object({
    id: z.number(),
    email: z.string(),
    displayName: z.string().nullable(),
    lastLoginAt: z.string().nullable(),
    twoFactorEnabled: z.boolean().optional().describe('邮箱验证码二次登录已开启'),
    totpEnabled: z.boolean().optional().describe('TOTP 验证器已绑定（接管第二因子）'),
    role: z
      .object({
        id: z.number(),
        code: z.string(),
        name: z.string(),
        isSuper: z.boolean().describe('超管隐式全量（can() 短路;permissions 下发全码）'),
      })
      .describe('动态 RBAC 角色对象（roles 表）'),
    permissions: z
      .array(z.string())
      .describe('本人全量授权码（<域>:<动词>;超管 = enforced 全码——导航/按钮显隐单一事实源）'),
  })
  .meta({ id: 'AdminMeInfo', description: '当前登录管理员 (GET /v1/me,admin-api 管理面)' });

/** 登录两步流:密码正确后按第二因子二分（totp=验证器 App / email=发码半程 / 直接签发会话） */
const loginResponseSchema = z.union([
  z.object({
    twoFactorRequired: z.literal(true),
    method: z.literal('totp').describe('TOTP 已绑定——客户端改走 /v1/auth/login/totp'),
  }),
  z.object({
    twoFactorRequired: z.literal(true),
    method: z.literal('email').optional().describe('邮箱验证码（旧形态）'),
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
    path: '/v1/auth/login/totp',
    tag: 'auth',
    summary: 'TOTP 第二步登录（重验凭证 + 验证器/恢复码）',
    auth: 'public',
    body: authContracts.loginTotp,
    response: { schema: tokenResponseSchema },
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
    method: 'get',
    path: '/v1/me/menus',
    tag: 'me',
    summary: '本人菜单树（group+page 两级,按授权过滤——sidebar 数据源）',
    response: {
      schema: z.object({
        groups: z.array(
          z.object({
            id: z.number(),
            i18nKey: z.string().nullable(),
            name: z.string(),
            items: z.array(
              z.object({
                id: z.number(),
                i18nKey: z.string().nullable(),
                name: z.string(),
                path: z.string().nullable(),
                icon: z.string().nullable(),
                code: z.string().nullable(),
              }),
            ),
          }),
        ),
      }),
    },
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
    path: '/v1/me/totp/enroll',
    tag: 'me',
    summary: 'TOTP 挂起注册（返回 base32 密钥与 otpauth URL,扫码确认前不参与登录）',
    response: {
      schema: z.object({
        secret: z.string().describe('base32 密钥（仅本次返回）'),
        otpauthUrl: z.string().describe('otpauth:// 二维码内容'),
      }),
    },
    errors: [401],
  },
  {
    method: 'post',
    path: '/v1/me/totp/confirm',
    tag: 'me',
    summary: 'TOTP 确认绑定（验当前码 → 生效 + 整组恢复码,仅此一次返回明文）',
    body: authContracts.totpCode,
    response: {
      schema: z.object({
        recoveryCodes: z.array(z.string()).describe('一次性恢复码(保存后不可再取)'),
      }),
    },
    errors: [400, 401],
  },
  {
    method: 'post',
    path: '/v1/me/totp/disable',
    tag: 'me',
    summary: 'TOTP 解绑（须持有效验证器/恢复码）',
    body: authContracts.totpCode,
    response: { schema: okTrue },
    errors: [400, 401],
  },
  {
    method: 'post',
    path: '/v1/me/two-factor/code',
    tag: 'me',
    summary: '2FA 开关确认码发送（本人邮箱;60s 冷却,SMTP 未生效 fail-closed 503）',
    response: {
      schema: z.object({ challengeId: z.string().uuid().describe('确认挑战 id') }),
    },
    errors: [401, 429, 503],
  },
  {
    method: 'post',
    path: '/v1/me/two-factor',
    tag: 'me',
    summary: '2FA 开关（邮箱码自证——先发码,验码确认;主体绑定防跨主体重放）',
    body: authContracts.twoFactor,
    response: {
      schema: z.object({ twoFactorEnabled: z.boolean().describe('开关后的生效状态') }),
    },
    errors: [400, 401],
  },
];
