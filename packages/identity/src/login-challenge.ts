/**
 * 登录验证码挑战适配层：identity-core 统一挑战（PG 挑战表）之上的 app 面薄封装。
 *
 *   发码 = core beginChallenge（code 内生 6 位、冷却/替换/哈希落库，DB 不变量兜底）
 *          → effects.deliver 注入 mailer 出境；投递失败 core 自动作废（可立即重发）
 *   验码 = core verifyChallenge（CAS 计错+消费）→ 翻译回 CodeVerifyError 三态语义
 *   作废 = core abortChallenge（幂等）
 *
 * 语义契约：TTL 300s / 5 次 / 60s 冷却；目标经归一化（大小写变体不分裂冷却键）、
 * 计错由 DB CHECK 封顶。
 * 挑战目标统一为投递邮箱（identifier）；归属校验在 verify 的 expectEmail 完成——
 * 跨 kind 重放（登录码用于 2FA 等）被 subject 比对拦下。
 */
import {
  createIdentity,
  ChallengeCooldownError,
  ChallengeInvalidError,
  CodeInvalidError,
  type AnyPgDatabase,
  type Identity,
} from '@ai-gateway/identity-core';
import type { Mailer } from './mailer.js';
import { CodeVerifyError, LoginCodeCooldownError } from './errors.js';

export const LOGIN_CODE_TTL_S = 300;
export const LOGIN_CODE_MAX_TRIES = 5;
export const LOGIN_CODE_RESEND_COOLDOWN_S = 60;

export type LoginCodeNamespace = 'admin' | 'user';
export type LoginCodePurpose = 'login' | 'register';

export interface LoginCodeVerified {
  /** 挑战目标（投递邮箱，归一化小写） */
  subjectId: string;
  /** 附加字段（注册场景暂存的密码哈希等，验证成功时原样返回） */
  data?: Record<string, string>;
}

/** ns × purpose → core 挑战 kind（单一真相；冷却/活挑战唯一性均按 kind 分桶） */
function kindOf(ns: LoginCodeNamespace, purpose: LoginCodePurpose): string {
  if (ns === 'admin') return 'admin_login_code';
  return purpose === 'register' ? 'user_register_code' : 'user_login_code';
}

export interface LoginCodeChallenger {
  /** 发码（含冷却与投递；成功返回 challengeId） */
  issue(
    ns: LoginCodeNamespace,
    input: { email: string; purpose?: LoginCodePurpose; payload?: Record<string, string>; ip: string },
  ): Promise<string>;
  /** 验码：expectEmail 给定时必须与挑战目标一致（跨 kind/跨主体重放在此拦截） */
  verify(
    ns: LoginCodeNamespace,
    input: { challengeId: string; code: string; expectEmail?: string },
  ): Promise<LoginCodeVerified>;
  /** 幂等作废（验码失败后的显式放弃） */
  abort(challengeId: string): Promise<void>;
}

export function createLoginCodeChallenger(
  db: AnyPgDatabase,
  options: { mailer: Mailer | null },
): LoginCodeChallenger {
  // 邮件正文携带请求 IP：按收件邮箱键控（同邮箱并发 issue 被冷却期结构性挡住，
  // 键控无碰撞——共享单个可变串会把 A 的 IP 发进 B 的邮件，隐私串号）
  const deliverIps = new Map<string, string>();
  const identity: Identity = createIdentity(db, {
    identifiers: ['email'],
    providers: [],
    challenges: ['user_login_code', 'user_register_code', 'admin_login_code'],
    challenge: {
      digits: 6,
      ttlMs: LOGIN_CODE_TTL_S * 1000,
      cooldownMs: LOGIN_CODE_RESEND_COOLDOWN_S * 1000,
      maxAttempts: LOGIN_CODE_MAX_TRIES,
    },
    effects: {
      deliver: async ({ to, code }) => {
        if (!options.mailer) throw new Error('SMTP mailer not configured');
        const ip = deliverIps.get(to) ?? '';
        try {
          await options.mailer.sendLoginCode(to, code, { ip });
        } finally {
          deliverIps.delete(to);
        }
      },
    },
  });

  return {
    async issue(ns, input) {
      const kind = kindOf(ns, input.purpose ?? 'login');
      deliverIps.set(input.email.trim().toLowerCase(), input.ip);
      try {
        const { challengeId } = await identity.beginChallenge({
          kind,
          target: { identifier: { kind: 'email', value: input.email } },
          payload: input.payload,
        });
        return challengeId;
      } catch (error) {
        if (error instanceof ChallengeCooldownError) {
          throw new LoginCodeCooldownError(Math.ceil(error.retryAfterMs / 1000));
        }
        throw error;
      }
    },

    async verify(ns, input) {
      let verified;
      try {
        verified = await identity.verifyChallenge({
          challengeId: input.challengeId,
          code: input.code,
        });
      } catch (error) {
        if (error instanceof ChallengeInvalidError) {
          throw new CodeVerifyError('CHALLENGE_INVALID');
        }
        if (error instanceof CodeInvalidError) {
          throw new CodeVerifyError(
            error.remainingAttempts > 0 ? 'CODE_INVALID' : 'CHALLENGE_EXHAUSTED',
          );
        }
        throw error;
      }
      const identifier = verified.target.identifier;
      const subjectId = identifier?.value ?? '';
      // 归属校验（可选）：调用方预知主体时强制比对，防跨 kind/跨主体重放
      if (identifier == null || subjectId === '') {
        throw new CodeVerifyError('CHALLENGE_INVALID');
      }
      if (
        input.expectEmail !== undefined &&
        subjectId !== input.expectEmail.trim().toLowerCase()
      ) {
        throw new CodeVerifyError('CHALLENGE_INVALID');
      }
      const payload = verified.payload as Record<string, string> | null;
      return {
        subjectId,
        data: payload && Object.keys(payload).length > 0 ? payload : undefined,
      };
    },

    async abort(challengeId) {
      await identity.abortChallenge({ challengeId });
    },
  };
}
