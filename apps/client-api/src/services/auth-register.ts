import { and, eq } from 'drizzle-orm';
import { randomInt } from 'node:crypto';
import {
  hashPassword,
  issueLoginCodeChallenge,
  abortLoginCodeChallenge,
  verifyLoginCodeChallenge,
  LoginCodeCooldownError,
  CodeVerifyError,
  type LoginCodeVerified,
  CaptchaError,
} from '@ai-gateway/identity';
import { FlowError, HttpError, pgSqlState } from '@ai-gateway/http';
import { users } from '@ai-gateway/db/schema';
import type { ClientServices } from './index.js';
import type { ClientApiConfig } from '../config.js';
import { audited, defaultDisplayName, issueSession, type VerifySuccess } from './auth-common.js';

/**
 * 邮箱自助注册流程（两步：注册 → 邮箱验证码 → 建号并自动登录）：
 *
 * 第一步 register()：IP 限流 → 人机验证门禁（fail-closed）→ 邮箱占用检查
 *   （唯一索引兜底并发）→ 密码哈希随挑战存 Redis（不落明文）→ 发码。
 *
 * 第二步 verifyRegistration()：验码（一次性消费防重放）→ 建号（并发撞邮箱
 *   由唯一索引兜底 → 语义化 409）→ 赠额（幂等）→ 签发会话。
 *
 * 失败分支在判定处直接 throw FlowError，errorHandler 统一出响应；
 * 审计由 audited() 收口随成败一并落库。
 */

/** 同 IP 注册请求（含发码）上限/小时——防批量刷号 */
export const REGISTER_IP_LIMIT_PER_HOUR = 5;

export interface RegisterInput {
  email: string;
  password: string;
  ip: string;
  /** 浏览器 widget 产生的人机验证 token（启用 captcha 时必填） */
  captchaToken?: string;
  /** 可信服务间调用豁免（路由层已恒定时间校验 x-internal-token） */
  captchaExempt?: boolean;
}

export type RegisterSuccess = { kind: 'code_required'; challengeId: string };

export async function register(
  s: ClientServices,
  config: ClientApiConfig,
  input: RegisterInput,
): Promise<RegisterSuccess> {
  return audited(
    s,
    { action: 'auth.register', detail: () => ({ email: input.email.slice(0, 64), ip: input.ip }) },
    async () => {
      const email = input.email.trim().toLowerCase();

      // 注册开关：关闭时先于 captcha/限流短路；FlowError('disabled') 经
      // audited() 落 auth.register.disabled 审计（探测行为可观测）
      if (!config.registerEnabled) {
        throw new FlowError('disabled', { code: 'REGISTER_DISABLED' });
      }

      // IP 限流（先记数再判断：每次请求都计入配额）
      const reqKey = `register:req:${input.ip}`;
      const n = await s.redis.incr(reqKey);
      if (n === 1) await s.redis.expire(reqKey, 3600);
      if (n > REGISTER_IP_LIMIT_PER_HOUR) {
        throw new FlowError('rate_limited', {
          code: 'REGISTER_RATE_LIMITED',
          message: '注册请求过于频繁，请稍后再试',
          headers: { 'retry-after': '3600' },
        });
      }

      // 人机验证门禁（位于 IP 限流之后：垃圾请求先吃便宜的 429，再谈验签）。
      // 厂商不可用 fail-closed——打瘫 Turnstile 不能换来自动放行。
      if (s.captcha && !input.captchaExempt) {
        const token = input.captchaToken?.trim();
        if (!token) throw new FlowError('captcha_required', { code: 'CAPTCHA_REQUIRED' });
        try {
          await s.captcha.verify({ token, remoteIp: input.ip });
        } catch (e) {
          if (!(e instanceof CaptchaError)) throw e;
          if (e.reason === 'unavailable') {
            throw new FlowError('captcha_unavailable', { code: 'CAPTCHA_UNAVAILABLE' });
          }
          throw new FlowError('captcha_invalid', { code: 'CAPTCHA_INVALID' });
        }
      }

      // 邮箱占用检查（DB 唯一索引 users_local_email_uq 兜底并发）
      const existing = await s.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.issuer, 'local'), eq(users.email, email)))
        .limit(1);
      if (existing.length > 0) {
        throw new FlowError('email_taken', {
          code: 'EMAIL_TAKEN',
          message: '该邮箱已注册，请直接登录',
        });
      }

      // fail-closed：SMTP 未配置 → 503（与登录同口径）
      if (!s.mailer) {
        throw new FlowError('mailer_unavailable', {
          code: 'TWO_FACTOR_UNAVAILABLE',
          message: '注册需邮箱验证码，但服务端未配置 SMTP——请联系管理员（不降级）',
        });
      }

      // 密码哈希在签发时计算并存入挑战（Redis 不落明文；验证通过直接用于建号）
      const code = String(randomInt(100000, 1000000));
      const passwordHash = await hashPassword(input.password);
      let challengeId: string;
      try {
        challengeId = await issueLoginCodeChallenge(s.redis, 'user', email, code, { passwordHash });
      } catch (e) {
        if (e instanceof LoginCodeCooldownError) {
          throw new FlowError('code_rate_limited', {
            code: 'CODE_RATE_LIMITED',
            message: '验证码发送过于频繁，请 1 分钟后再试',
            headers: { 'retry-after': '60' },
          });
        }
        throw e;
      }
      try {
        await s.mailer.sendLoginCode(email, code, { ip: input.ip });
      } catch {
        await abortLoginCodeChallenge(s.redis, 'user', email, challengeId);
        throw new FlowError('code_send_failed', { code: 'CODE_SEND_FAILED' });
      }

      return { kind: 'code_required', challengeId };
    },
  );
}

export async function verifyRegistration(
  s: ClientServices,
  config: ClientApiConfig,
  input: { challengeId: string; code: string },
): Promise<VerifySuccess> {
  return audited(
    s,
    {
      action: 'auth.register.verify',
      detail: (kind) => (kind === 'email_taken' ? { reason: 'concurrent' } : {}),
      targetId: (o) => (o.kind === 'success' ? o.userId : null),
    },
    async () => {
      // 开关关闭即拒：防「发码后开关翻转」窗口内既有挑战继续建号
      // （普通 HttpError 不经 audited() 落业务审计，与原路由行为一致）
      if (!config.registerEnabled) throw new HttpError('REGISTER_DISABLED');

      let verified: LoginCodeVerified;
      try {
        verified = await verifyLoginCodeChallenge(s.redis, 'user', input.challengeId, input.code);
      } catch (e) {
        if (e instanceof CodeVerifyError) {
          if (e.reason === 'CODE_INVALID') {
            throw new FlowError('code_invalid', { code: 'CODE_INVALID' });
          }
          throw new FlowError('challenge_invalid', {
            code: 'CHALLENGE_INVALID',
            message: '验证码已过期、不存在或错误次数过多，请重新注册',
          });
        }
        throw e;
      }
      const email = verified.subjectId.trim().toLowerCase();
      const passwordHash = verified.data?.passwordHash;
      if (!passwordHash) {
        throw new FlowError('challenge_invalid', {
          code: 'CHALLENGE_INVALID',
          message: '验证码已过期、不存在或错误次数过多，请重新注册',
        });
      }

      try {
        const [created] = await s.db
          .insert(users)
          .values({
            issuer: 'local',
            subject: email,
            identityProvider: 'local',
            email,
            displayName: defaultDisplayName(),
            passwordHash,
          })
          .returning({ id: users.id, email: users.email });
        const session = await issueSession(s, config, created!.id);
        return {
          kind: 'success',
          token: session.token,
          userId: created!.id,
          email: created!.email ?? email,
          gifted: session.gifted,
        };
      } catch (e) {
        // 并发注册同一邮箱：唯一索引 users_local_email_uq 兜底 → 语义化 409
        if (e instanceof Error && pgSqlState(e) === '23505') {
          throw new FlowError('email_taken', {
            code: 'EMAIL_TAKEN',
            message: '该邮箱已注册，请直接登录',
          });
        }
        throw e;
      }
    },
  );
}
