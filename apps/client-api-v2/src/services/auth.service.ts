/**
 * 账户服务：注册 / 登录 / 改密 / 资料（+ 邮箱验证码两步流与人机验证门禁）。
 *
 * 安全语义：
 *   - 登录失败统一 401（账号不存在/密码错/无密码同响应同耗时——verifyPassword 哑哈希防枚举）
 *   - 爆破防护双层（装配注入，Redis 形态生效）：per-邮箱哈希 + per-IP；fail-open
 *   - 改密原子推进会话失效线（R5-2）——旧 token 全网即刻失效，新 token 同拍返回
 *   - 注册赠送幂等：refType='gift' + refId=`signup:{userId}`
 *
 * 邮箱验证码模式（装配注入 emailCodeRequired；缺省 = SMTP 已配置即强制）：
 *   register → {kind:'code_required'}（密码哈希存挑战，不落明文）→ verifyRegistration 建号
 *   login    → 密码对 → {kind:'code_required'}（不签会话）→ verifyLogin 签会话
 *   SMTP 未配置而模式强制 → 503 fail-closed（绝不静默降级为单密码）
 * 人机验证（captcha 装配注入）：token 缺失 400 / 验签失败 400 / 厂商不可达 503 fail-closed。
 */
import { hashPassword, verifyPassword, assertPasswordPolicy } from '@ai-gateway/identity-core';
import {
  signSession,
  createLoginCodeChallenger,
  CaptchaError,
  CodeVerifyError,
  DeliveryFailedError,
  LoginCodeCooldownError,
  type Mailer,
  type CaptchaService,
  type LoginCodeChallenger,
} from '@ai-gateway/identity';
import { sha256Hex } from '@ai-gateway/http';
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories } from '@ai-gateway/repository';
import type { KeyBruteForceGuard, AuthFailureGuard, GuardCheck } from '@ai-gateway/core';
import type { RunContext, WalletApi } from '@ai-gateway/service';
import { AppError } from '../http/error-map.js';
import type { FixedWindowCounter } from './rate-counter.js';

/** 密码策略（identity-core 默认口径：长度 10..128；强度判定在哈希前的纯规则层） */
const PASSWORD_POLICY = { minLength: 10, maxLength: 128 };

export interface AuthServiceDeps {
  db: Db;
  repos?: Repositories;
  wallet: WalletApi;
  jwtSecret: string;
  sessionTtlSeconds: number;
  registerEnabled: boolean;
  /** 注册赠送额度（'0' = 关闭） */
  giftAmount: string;
  /** per-邮箱爆破锁（Redis；不可达时登录 fail-closed 503） */
  loginGuard: KeyBruteForceGuard;
  /** per-IP 鉴权失败锁（同上） */
  ipGuard: AuthFailureGuard;
  /** 注册限流计数器（Redis；hit 失败注册 fail-closed 503） */
  registerLimiter: FixedWindowCounter;
  registerIpLimitPerHour: number;
  /** SMTP 发信（邮箱验证码模式的前置；null = 未配置） */
  mailer: Mailer | null;
  /** 人机验证（null = 未启用） */
  captcha: CaptchaService | null;
  /** 邀请归因（注册建号后尽力而为调用；结果不影响注册；缺省 no-op——未启用邀请功能） */
  referral?: { apply(ctx: RunContext, inviteeId: number, affCode: string): Promise<unknown> };
  /** 强制邮箱验证码（两级登录）：装配决定（缺省 = SMTP 已配置即强制） */
  emailCodeRequired: boolean;
}

export interface RegisterSuccess {
  kind: 'success';
  token: string;
  userId: number;
  email: string;
  gifted: boolean;
}
export type RegisterResult = RegisterSuccess | { kind: 'code_required'; challengeId: string };
export type LoginResult = { kind: 'success'; token: string; userId: number } | { kind: 'code_required'; challengeId: string };

export interface AuthService {
  register(
    ctx: RunContext,
    input: { email: string; password: string; ip: string; captchaToken?: string; aff?: string },
  ): Promise<RegisterResult>;
  /** 两步注册第二步：验码建号（一次性消费防重放；开关翻转窗口内拒绝） */
  verifyRegistration(
    ctx: RunContext,
    input: { challengeId: string; code: string; aff?: string },
  ): Promise<RegisterSuccess>;
  login(
    ctx: RunContext,
    input: { email: string; password: string; ip: string },
  ): Promise<LoginResult>;
  /** 两步登录第二步：验码签会话（状态复查 + lastLogin） */
  verifyLogin(
    ctx: RunContext,
    input: { challengeId: string; code: string },
  ): Promise<{ token: string; userId: number }>;
  changePassword(
    ctx: RunContext,
    input: { userId: number; oldPassword: string; newPassword: string },
  ): Promise<{ token: string }>;
  profile(
    ctx: RunContext,
    userId: number,
  ): Promise<{
    id: number;
    email: string | null;
    displayName: string | null;
    isEnterprise: boolean;
    createdAt: Date;
    accounts: Awaited<ReturnType<WalletApi['accounts']>>;
  }>;
  updateDisplayName(
    ctx: RunContext,
    userId: number,
    displayName: string,
  ): Promise<{ displayName: string }>;
  /** 前端能力探测：注册开关 / captcha siteKey / 邮箱验证码模式 */
  capabilities(): { registerEnabled: boolean; captchaSiteKey: string | null; emailCodeRequired: boolean };
}

const sys = (ctx: RunContext): RunContext => ({ ...ctx, actor: { kind: 'system' } });

/** 发码统一错误翻译（注册/登录共用；模块级纯函数） */
function translateIssueError(e: unknown): never {
  if (e instanceof LoginCodeCooldownError) {
    throw new AppError(429, 'code_rate_limited', '验证码发送过于频繁，请 1 分钟后再试');
  }
  if (e instanceof DeliveryFailedError) {
    throw new AppError(502, 'code_send_failed', '验证码发送失败，请稍后再试');
  }
  throw e;
}
const asUser = (ctx: RunContext, userId: number): RunContext => ({
  ...ctx,
  actor: { kind: 'user', id: userId },
});

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { db, wallet } = deps;
  const repos = deps.repos ?? createRepositories();
  const challenger: LoginCodeChallenger | null = deps.mailer
    ? createLoginCodeChallenger(db, { mailer: deps.mailer })
    : null;

  const issue = (userId: number) =>
    signSession({ type: 'user', id: userId, expiresInSeconds: deps.sessionTtlSeconds }, deps.jwtSecret);

  /** 人机验证门禁（位于限流之后：垃圾请求先吃便宜的 429；fail-closed——打瘫厂商不能换自动放行） */
  async function assertCaptcha(token: string | undefined, ip: string): Promise<void> {
    if (!deps.captcha) return;
    const t = token?.trim();
    if (!t) throw new AppError(400, 'captcha_required', '需要人机验证');
    try {
      await deps.captcha.verify({ token: t, remoteIp: ip });
    } catch (e) {
      if (e instanceof CaptchaError) {
        if (e.reason === 'unavailable') {
          throw new AppError(503, 'captcha_unavailable', '人机验证服务不可用，请稍后再试');
        }
        throw new AppError(400, 'captcha_invalid', '人机验证未通过');
      }
      throw e;
    }
  }

  function requireChallenger(): LoginCodeChallenger {
    if (!challenger) {
      throw new AppError(503, 'two_factor_unavailable', '需邮箱验证码，但服务端未配置 SMTP（不降级为单密码）');
    }
    return challenger;
  }

  /** 建号 + 赠送 + 邀请归因 + 签会话（两步注册的收尾；单步注册共用） */
  async function createAccountAndSession(
    ctx: RunContext,
    email: string,
    passwordHash: string,
    aff?: string,
  ): Promise<RegisterSuccess> {
    let created: { id: number };
    try {
      created = await db.transaction(async (tx) =>
        repos.userAccount.insertLocalUser(
          { db: tx, ...sys(ctx) },
          { email, passwordHash, displayName: email.split('@')[0]!.slice(0, 64) },
        ),
      );
    } catch (e) {
      // 并发撞邮箱：唯一索引兜底 → 语义化 409
      if (e instanceof Error && (e as { code?: string }).code === '23505') {
        throw new AppError(409, 'email_taken', '该邮箱已注册，请直接登录');
      }
      throw e;
    }
    // 注册赠送：幂等键 gift:signup:{userId}；失败不回滚建号（键可补发，账不受损）
    let gifted = false;
    if (deps.giftAmount !== '0') {
      try {
        await wallet.credit(sys(ctx), {
          userId: created.id,
          amount: deps.giftAmount,
          refType: 'gift',
          refId: `signup:${created.id}`,
          memo: '注册赠送',
        });
        gifted = true;
      } catch (e) {
        console.error('[client-api] gift credit failed (backfillable via refKey):', e);
      }
    }
    // 邀请归因（自声明 aff 码）：尽力而为——非法码/自邀/重复被邀静默跳过，绝不阻断注册
    if (aff) {
      await deps.referral?.apply(sys(ctx), created.id, aff).catch(() => undefined);
    }
    return { kind: 'success', token: await issue(created.id), userId: created.id, email, gifted };
  }

  return {
    async register(ctx, input) {
      if (!deps.registerEnabled) {
        throw new AppError(403, 'register_disabled', '注册通道未开放');
      }
      const email = input.email.trim().toLowerCase();

      // 同 IP 每小时注册上限（防批量刷号；先记数：每次请求都计入配额）
      // 计数器失败 = Redis 不可达 → fail-closed 拒绝注册
      let regHits: number;
      try {
        regHits = await deps.registerLimiter.hit(`register:${input.ip}`, 3600);
      } catch {
        throw new AppError(503, 'rate_counter_unavailable', '频率计数器不可用，请稍后再试');
      }
      if (regHits > deps.registerIpLimitPerHour) {
        throw new AppError(429, 'register_rate_limited', '注册请求过于频繁，请稍后再试');
      }

      await assertCaptcha(input.captchaToken, input.ip);
      assertPasswordPolicy(input.password, PASSWORD_POLICY);

      // 两步注册：密码哈希随挑战存（不落明文），验码通过直接用于建号
      if (deps.emailCodeRequired) {
        const existing = await repos.userAccount.findByLocalEmail({ db, ...sys(ctx) }, email);
        if (existing) {
          throw new AppError(409, 'email_taken', '该邮箱已注册，请直接登录');
        }
        const passwordHash = await hashPassword(input.password);
        const codes = requireChallenger();
        try {
          const challengeId = await codes.issue('user', {
            email,
            purpose: 'register',
            payload: { passwordHash },
            ip: input.ip,
          });
          return { kind: 'code_required', challengeId };
        } catch (e) {
          translateIssueError(e);
        }
      }

      const existing = await repos.userAccount.findByLocalEmail({ db, ...sys(ctx) }, email);
      if (existing) {
        throw new AppError(409, 'email_taken', '该邮箱已注册，请直接登录');
      }
      const passwordHash = await hashPassword(input.password);
      return createAccountAndSession(ctx, email, passwordHash, input.aff);
    },

    async verifyRegistration(ctx, input) {
      // 防发码后开关翻转的窗口内既有挑战继续建号
      if (!deps.registerEnabled) throw new AppError(403, 'register_disabled', '注册通道未开放');
      const codes = requireChallenger();
      let verified;
      try {
        verified = await codes.verify('user', { challengeId: input.challengeId, code: input.code });
      } catch (e) {
        if (e instanceof CodeVerifyError) {
          if ((e as { reason?: string }).reason === 'CODE_INVALID') {
            throw new AppError(400, 'code_invalid', '验证码错误');
          }
          throw new AppError(400, 'challenge_invalid', '验证码已过期或错误次数过多，请重新注册');
        }
        throw e;
      }
      const email = verified.subjectId.trim().toLowerCase();
      const passwordHash = verified.data?.passwordHash;
      if (!passwordHash) {
        throw new AppError(400, 'challenge_invalid', '验证码已过期或错误次数过多，请重新注册');
      }
      return createAccountAndSession(ctx, email, passwordHash, input.aff);
    },

    async login(ctx, input) {
      const email = input.email.trim().toLowerCase();
      const guardKey = sha256Hex(email);

      // 爆破锁检查（Redis 必配；不可达 fail-closed 503——防护不在即拒绝）
      let byKey: GuardCheck, byIp: GuardCheck;
      try {
        [byKey, byIp] = await Promise.all([
          deps.loginGuard.isLocked(guardKey),
          deps.ipGuard.isLocked(input.ip),
        ]);
      } catch {
        throw new AppError(503, 'auth_guard_unavailable', '鉴权防护不可用，请稍后再试');
      }
      const retry = byKey.locked ? byKey.retryAfterSec : byIp.locked ? byIp.retryAfterSec : 0;
      if (retry > 0) {
        throw new AppError(429, 'login_locked', '尝试过于频繁，请稍后再试');
      }

      const account = await repos.userAccount.findByLocalEmail({ db, ...sys(ctx) }, email);
      // 哑哈希：账号不存在也做等量 scrypt 计算（响应耗时一致——防枚举）
      const ok = await verifyPassword(input.password, account?.passwordHash ?? null);

      if (!ok || !account) {
        // 记失败（best-effort 之外唯一语义：不可达时不吞 401 的正确性，仅防护缺失并大声记日志）
        await Promise.all([
          deps.loginGuard.recordFailure(guardKey).catch(() => undefined),
          deps.ipGuard.recordFailure(input.ip).catch(() => undefined),
        ]);
        throw new AppError(401, 'invalid_credentials', '邮箱或密码错误');
      }
      if (account.status !== 0) {
        throw new AppError(403, 'account_unavailable', '账号不可用');
      }
      await deps.loginGuard.recordSuccess(guardKey).catch(() => undefined);

      // 强制邮箱验证（fail-closed）：密码对不签会话，发码走第二步
      if (deps.emailCodeRequired) {
        const codes = requireChallenger();
        try {
          const challengeId = await codes.issue('user', {
            email: account.email ?? email,
            ip: input.ip,
          });
          return { kind: 'code_required', challengeId };
        } catch (e) {
          translateIssueError(e);
        }
      }

      await db.transaction(async (tx) =>
        repos.userAccount.touchLastLogin({ db: tx, ...sys(ctx) }, account.id),
      );
      return { kind: 'success', token: await issue(account.id), userId: account.id };
    },

    async verifyLogin(ctx, input) {
      const codes = requireChallenger();
      let verified;
      try {
        verified = await codes.verify('user', { challengeId: input.challengeId, code: input.code });
      } catch (e) {
        if (e instanceof CodeVerifyError) {
          if ((e as { reason?: string }).reason === 'CODE_INVALID') {
            throw new AppError(400, 'code_invalid', '验证码错误');
          }
          throw new AppError(400, 'challenge_invalid', '验证码已过期或错误次数过多，请重新登录');
        }
        throw e;
      }
      const email = verified.subjectId.trim().toLowerCase();
      const account = await repos.userAccount.findByLocalEmail({ db, ...sys(ctx) }, email);
      if (!account) throw new AppError(401, 'invalid_credentials', '邮箱或密码错误');
      if (account.status !== 0) throw new AppError(403, 'account_unavailable', '账号不可用');
      await db.transaction(async (tx) =>
        repos.userAccount.touchLastLogin({ db: tx, ...sys(ctx) }, account.id),
      );
      return { token: await issue(account.id), userId: account.id };
    },

    async changePassword(ctx, input) {
      const runCtx = asUser(ctx, input.userId);
      const account = await repos.userAccount.findById({ db, ...runCtx }, input.userId);
      if (!account) throw new AppError(401, 'unauthorized', '账号不存在');

      const ok = await verifyPassword(input.oldPassword, account.passwordHash ?? null);
      if (!ok || account.status !== 0) {
        throw new AppError(401, 'invalid_credentials', '原密码错误');
      }
      assertPasswordPolicy(input.newPassword, PASSWORD_POLICY);

      const passwordHash = await hashPassword(input.newPassword);
      // 失效线 = 现在；新 token 在事务提交后签发，iat 严格在线后（见 signSession iatMs）
      const invalidBefore = new Date();
      await db.transaction(async (tx) =>
        repos.userAccount.updatePassword(
          { db: tx, ...runCtx },
          { userId: input.userId, passwordHash, invalidBefore },
        ),
      );
      return { token: await issue(input.userId) };
    },

    async profile(ctx, userId) {
      const runCtx = asUser(ctx, userId);
      const account = await repos.userAccount.findById({ db, ...runCtx }, userId);
      if (!account) throw new AppError(401, 'unauthorized', '账号不存在');
      const accounts = await wallet.accounts(runCtx, userId);
      return {
        id: account.id,
        email: account.email,
        displayName: account.displayName,
        isEnterprise: await repos.user.isEnterprise({ db, ...runCtx }, userId),
        createdAt: account.createdAt,
        accounts,
      };
    },

    async updateDisplayName(ctx, userId, displayName) {
      const runCtx = asUser(ctx, userId);
      const updated = await db.transaction(async (tx) =>
        repos.userAccount.updateDisplayName({ db: tx, ...runCtx }, { userId, displayName }),
      );
      if (!updated) throw new AppError(401, 'unauthorized', '账号不存在');
      return { displayName };
    },

    capabilities() {
      return {
        registerEnabled: deps.registerEnabled,
        captchaSiteKey: deps.captcha?.siteKey ?? null,
        emailCodeRequired: deps.emailCodeRequired,
      };
    },
  };
}
