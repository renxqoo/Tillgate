/**
 * 认证路由装配（动词文件聚合处）：能力探测 / 登出 / 改密在本文件；
 * 注册两步制在 auth-register.ts、登录（含两级验证码）在 auth-login.ts。
 * 共享 deps 形状与协议助手在此定义——本层只编排 facade 动词与协议闸，
 * 业务规则单源在 identity/accounts（DESIGN §4）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import {
  jsonBody,
  parseAcceptLanguage,
  socketAddressFromContext,
  trustedClientIp,
} from '@tokenlens/http';
import { sha256Hex } from '@tokenlens/billing';
import type { Identity, PasswordPolicy } from '@tokenlens/identity';
import type { AuthFailureGuard, KeyBruteForceGuard } from '@tokenlens/runtime';
import { passwordSchema } from '../contracts/auth.js';
import type { SessionEnv } from '../middleware/session.js';
import { registerRoutes } from './auth-register.js';
import { loginRoutes } from './auth-login.js';

/** 前端能力探测（登录/注册页按钮渲染依据；无个人数据） */
export interface ClientCapabilities {
  readonly registerEnabled: boolean;
  readonly captchaSiteKey: string | null;
  readonly emailCodeRequired: boolean;
}

/** 密码信封：注册期封装进挑战载荷、验码期开封（挑战库不落明文——v1「只存哈希」的等价保持） */
export interface PasswordSealer {
  seal(plaintext: string): string;
  open(sealed: string): string;
}

export interface AuthDeps {
  readonly capabilities: ClientCapabilities;
  readonly passwordPolicy: PasswordPolicy;
  readonly sealer: PasswordSealer;
  readonly trustedProxyHops: number;
  /** captcha 未配置（siteKey null）时为 null——探测/校验整体关闭 */
  readonly captcha: Pick<Identity['captcha'], 'verify'> | null;
  readonly registerLimiter: { hit(key: string, windowSeconds: number): Promise<number> };
  readonly registerIpLimitPerHour: number;
  /** 注册限频窗口（秒）——Retry-After 与计数窗口同源 */
  readonly registerWindowSeconds: number;
  readonly emailTaken: (email: string) => Promise<boolean>;
  readonly challenges: Pick<Identity['challenges'], 'begin' | 'verify'>;
  readonly registerCredential: Identity['credentials']['register'];
  readonly provision: (input: { email: string }) => Promise<{ id: number; email: string | null }>;
  readonly onboarding: (input: {
    userId: number;
    affCode?: string;
  }) => Promise<{ gift: { status: string } }>;
  readonly authenticate: Identity['passwords']['authenticate'];
  readonly changePassword: Identity['passwords']['change'];
  readonly guards: { emailIp: KeyBruteForceGuard; ip: AuthFailureGuard };
  readonly userStatus: (userId: number) => Promise<number | null>;
  readonly touchLastLogin: (userId: number) => Promise<void>;
  readonly sign: (userId: number) => Promise<string>;
  readonly logout: (token: string) => Promise<void>;
}

export function bearerToken(header: string | undefined): string {
  return header != null && header.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : '';
}

/** 爆破守卫键：邮箱+IP 双维（v1 口径） */
export function guardKeyOf(email: string, ip: string): string {
  return sha256Hex(`${email}:${ip}`);
}

/** Accept-Language → identity delivery locale（'zh' 之外一律 en） */
export function localeOf(c: Parameters<MiddlewareHandler<SessionEnv>>[0]): 'en' | 'zh' {
  return parseAcceptLanguage(c.req.header('accept-language')) === 'zh' ? 'zh' : 'en';
}

/** 真实 socket 对端地址必须注入：置 null 时全部请求落到进程级常量桶——
 *  注册限频与登录 IP 锁退化为「全站一个桶」的自伤开关（app.request 测试 → null 合法） */
export function clientIpOf(
  deps: { trustedProxyHops: number },
  c: Parameters<MiddlewareHandler<SessionEnv>>[0],
): string {
  return trustedClientIp({
    headers: c.req.raw.headers,
    trustedProxyHops: deps.trustedProxyHops,
    socketAddress: socketAddressFromContext(c),
  });
}

export function authRoutes(deps: AuthDeps, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/auth/capabilities', (c) => c.json(deps.capabilities));

  app.post('/v1/auth/logout', session, async (c) => {
    await deps.logout(bearerToken(c.req.header('authorization')));
    return c.json({ ok: true });
  });

  app.post('/v1/auth/password', session, jsonBody(passwordSchema), async (c) => {
    const body = c.req.valid('json');
    const userId = c.get('userId');
    await deps.changePassword({
      userId,
      realm: 'user',
      currentPassword: body.oldPassword,
      newPassword: body.newPassword,
    });
    // 改密即吊销全部旧会话；当场重签返回新 token（v1 口径）
    const token = await deps.sign(userId);
    return c.json({ token });
  });

  app.route('/', registerRoutes(deps));
  app.route('/', loginRoutes(deps));
  return app;
}
