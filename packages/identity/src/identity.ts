/**
 * createIdentity facade:唯一装配面(app 只见 facade 与稳定契约)。
 * 内部组装 postgres store、jose 令牌与内置 OAuth provider 适配器;装配级可覆盖件
 * 显式可选(测试替身注入)。返回面不泄漏 Db/DbTx/drizzle 行类型/供应商 SDK。
 * cipher/logger/clock 经 port 注入——本包不编译依赖 runtime。
 */
import type { Db, TxRetryPolicy } from '@tillgate/db';
import { resolveConfig, validateOauthCreds, type IdentityConfigInput } from './domain/config.js';
import { postgresIdentityStore } from './adapters/postgres/identity-store';
import { createJoseSessionTokens } from './adapters/jwt/jose-tokens';
import { createGithubProvider } from './adapters/oauth/github';
import { createGoogleProvider } from './adapters/oauth/google';
import type { CredentialStore } from './ports/credential-store.js';
import type { ChallengeStore } from './ports/challenge-store.js';
import type { MfaStore } from './ports/mfa-store.js';
import type { OAuthStore } from './ports/oauth-store.js';
import type { AnchorStore } from './ports/anchor-store.js';
import type { SessionTokens } from './ports/session-tokens.js';
import type { OAuthProvider } from './ports/oauth-provider.js';
import type { SessionPayload } from './domain/session.js';
import type { Clock } from './ports/clock.js';
import type { LoggerLike } from './ports/logger.js';
import type { Mailer } from './ports/mailer.js';
import type { Captcha } from './ports/captcha.js';
import type { SessionRevocationStore } from './ports/session-revocation-store.js';
import type { OAuthStateStore } from './ports/oauth-state-store.js';
import type { SecretCipher } from './ports/secret-cipher.js';
import type { AuditPort } from './ports/audit.js';
import type { IdentityUseCaseContext } from './application/context.js';
import {
  registerCredential,
  type RegisterCredentialInput,
  type RegisterCredentialResult,
} from './application/register-credential';
import {
  authenticatePassword,
  type AuthenticatePasswordInput,
} from './application/authenticate-password';
import { changePassword, type ChangePasswordInput } from './application/change-password';
import { resetPassword, type ResetPasswordInput } from './application/reset-password';
import {
  beginChallenge,
  type BeginChallengeInput,
  type BeginChallengeResult,
} from './application/begin-challenge';
import {
  verifyChallenge,
  type VerifyChallengeInput,
  type VerifyChallengeResult,
} from './application/verify-challenge';
import { abortChallenge } from './application/abort-challenge';
import { enrollTotp, type EnrollTotpResult } from './application/enroll-totp';
import { confirmTotp } from './application/confirm-totp';
import { verifyMfa } from './application/verify-mfa';
import { verifyTotpOnly } from './application/verify-totp-only';
import { disableTotp } from './application/disable-totp';
import { findOAuthUser } from './application/find-oauth-user';
import { findPasswordUserIds } from './application/find-passwords';
import { linkOAuth, type LinkOAuthResult } from './application/link-oauth';
import { unlinkOAuth } from './application/unlink-oauth';
import { oauthAuthorize, type OAuthAuthorizeInput } from './application/oauth-authorize';
import {
  oauthCallback,
  type OAuthCallbackInput,
  type OAuthCallbackResult,
} from './application/oauth-callback';
import { signSession, type SignSessionInput } from './application/sign-session';
import { verifySession } from './application/verify-session';
import { validateSession } from './application/validate-session';
import { logout } from './application/logout';
import { advanceAnchor, revokeSessions, sessionValidAt } from './application/revocation';
import { verifyCaptcha } from './application/verify-captcha';

type IdentityStore = CredentialStore & ChallengeStore & MfaStore & OAuthStore & AnchorStore;

export interface CreateIdentityParams {
  readonly db: Db;
  readonly txRetry: TxRetryPolicy;
  readonly clock: Clock;
  readonly logger: LoggerLike;
  readonly config: IdentityConfigInput;
  /** 验证码邮件(装配注入 smtp 适配器;缺省 = 邮件通道 fail-closed) */
  readonly mailer?: Mailer;
  /** 人机验证(缺省 = captcha 动词 unavailable) */
  readonly captcha?: Captcha;
  /** jti 黑名单(缺省 = 无 jti 拒绝面,仅锚点线) */
  readonly sessionRevocation?: SessionRevocationStore;
  /** OAuth state 存储(缺省 = oauth 动词不可用) */
  readonly oauthStateStore?: OAuthStateStore;
  /** 自定义 OAuth provider / 覆盖内置 github、google(键须在 providers 词表内) */
  readonly oauthProviders?: Readonly<Record<string, OAuthProvider>>;
  /** TOTP secret 落库加密(装配注入 runtime.createCipher 产物) */
  readonly cipher?: SecretCipher;
  /** 审计发射(缺省 = 丢弃) */
  readonly auditSink?: AuditPort;
  /** 覆盖件(默认门禁测试替身;缺省 postgres 真实现) */
  readonly store?: IdentityStore;
  /** 覆盖会话令牌机制(缺省 jose HS256) */
  readonly tokens?: SessionTokens;
}

export interface Identity {
  readonly credentials: {
    register(input: RegisterCredentialInput): Promise<RegisterCredentialResult>;
  };
  readonly passwords: {
    authenticate(input: AuthenticatePasswordInput): Promise<{ userId: number }>;
    change(input: ChangePasswordInput): Promise<{ invalidBefore: string }>;
    reset(input: ResetPasswordInput): Promise<{ invalidBefore: string }>;
    /** 读面:批量返回已设密码的 userId 子集(邀请激活态投影;空入参返回空) */
    exists(input: { userIds: readonly number[] }): Promise<number[]>;
  };
  readonly challenges: {
    begin(input: BeginChallengeInput): Promise<BeginChallengeResult>;
    verify(input: VerifyChallengeInput): Promise<VerifyChallengeResult>;
    abort(input: { challengeId: string }): Promise<{ aborted: boolean }>;
  };
  readonly mfa: {
    enrollTotp(input: { userId: number; label?: string }): Promise<EnrollTotpResult>;
    confirmTotp(input: { userId: number; code: string }): Promise<{ recoveryCodes: string[] }>;
    verify(input: { userId: number; code: string }): Promise<{ method: 'totp' | 'recovery' }>;
    /** 仅 TOTP 的 step-up 验证——不消费恢复码，重放口径同 verify */
    verifyTotpOnly(input: { userId: number; code: string }): Promise<void>;
    disableTotp(input: { userId: number; code?: string }): Promise<{ disabled: boolean }>;
    /** 读面:注册状态(pending=已发起未确认,不参与登录验证;confirmed=生效) */
    status(input: { userId: number }): Promise<{ enrolled: boolean; confirmed: boolean }>;
  };
  readonly oauth: {
    findUser(input: { provider: string; subject: string }): Promise<number | null>;
    link(input: {
      userId: number;
      provider: string;
      subject: string;
      email?: string | null;
    }): Promise<LinkOAuthResult>;
    unlink(input: {
      userId: number;
      provider: string;
    }): Promise<{ unlinked: boolean; linkId: number }>;
    authorize(input: OAuthAuthorizeInput): Promise<{ url: string; state: string }>;
    callback(input: OAuthCallbackInput): Promise<OAuthCallbackResult>;
  };
  readonly sessions: {
    sign(input: SignSessionInput): Promise<string>;
    verify(token: string, realm: string): Promise<SessionPayload>;
    validate(token: string, realm: string): Promise<SessionPayload | null>;
    logout(token: string, realm: string): Promise<{ ok: true }>;
  };
  readonly revocation: {
    advance(input: { realm: string; userId: number; at?: Date }): Promise<string>;
    revoke(input: { realm: string; userId: number; at?: Date }): Promise<{ invalidBefore: string }>;
    validAt(input: { realm: string; userId: number; iat: Date | number }): Promise<boolean>;
  };
  readonly captcha: {
    verify(input: { token: string; remoteIp?: string }): Promise<{ ok: true }>;
  };
}

/** 上下文组装(根装配面私有;testing/harness 复用,不进 index 公共出口) */
export function buildIdentityContext(params: CreateIdentityParams): IdentityUseCaseContext {
  const { config, guards } = resolveConfig(params.config);
  const store = params.store ?? postgresIdentityStore;
  // 动态凭据源:每次动词调用解析当前快照(词表/凭据校验 fail-loud),装配覆盖件优先
  const oauthProvider = (name: string): OAuthProvider | null => {
    const override = params.oauthProviders?.[name];
    if (override != null) return override;
    const creds = config.oauth()[name];
    if (creds == null) return null;
    validateOauthCreds(creds, name);
    const adapterParams = {
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      ...(creds.endpoints != null ? { endpoints: creds.endpoints } : {}),
      logger: params.logger,
    };
    if (name === 'github') return createGithubProvider(adapterParams);
    if (name === 'google') return createGoogleProvider(adapterParams);
    return null;
  };
  return {
    db: params.db,
    txRetry: params.txRetry,
    clock: params.clock,
    logger: params.logger,
    config,
    guards,
    credentialStore: store,
    challengeStore: store,
    mfaStore: store,
    oauthStore: store,
    anchorStore: store,
    tokens: params.tokens ?? createJoseSessionTokens(config.sessions, params.clock),
    oauthProvider,
    ...(params.mailer != null ? { mailer: params.mailer } : {}),
    ...(params.captcha != null ? { captcha: params.captcha } : {}),
    ...(params.sessionRevocation != null ? { sessionRevocation: params.sessionRevocation } : {}),
    ...(params.oauthStateStore != null ? { oauthStateStore: params.oauthStateStore } : {}),
    ...(params.cipher != null ? { cipher: params.cipher } : {}),
    ...(params.auditSink != null ? { auditSink: params.auditSink } : {}),
  };
}

// eslint-disable-next-line max-lines-per-function -- facade 动词绑定平铺(注册即数据;拆分只会层层透传 ctx)
export function createIdentity(params: CreateIdentityParams): Identity {
  const ctx = buildIdentityContext(params);
  return {
    credentials: {
      register: (input) => registerCredential(ctx, input),
    },
    passwords: {
      authenticate: (input) => authenticatePassword(ctx, input),
      change: (input) => changePassword(ctx, input),
      reset: (input) => resetPassword(ctx, input),
      // 读面:批量返回已设密码的 userId 子集(纯读无临界区)
      exists: (input) => findPasswordUserIds(ctx, input),
    },
    challenges: {
      begin: (input) => beginChallenge(ctx, input),
      verify: (input) => verifyChallenge(ctx, input),
      abort: (input) => abortChallenge(ctx, input),
    },
    mfa: {
      enrollTotp: (input) => enrollTotp(ctx, input),
      confirmTotp: (input) => confirmTotp(ctx, input),
      verify: (input) => verifyMfa(ctx, input),
      verifyTotpOnly: (input) => verifyTotpOnly(ctx, input),
      disableTotp: (input) => disableTotp(ctx, input),
      status: async (input) => {
        const row = await ctx.mfaStore.loadTotp(ctx.db, input.userId);
        return { enrolled: row != null, confirmed: row?.confirmedAt != null };
      },
    },
    oauth: {
      findUser: (input) => findOAuthUser(ctx, input),
      link: (input) => linkOAuth(ctx, input),
      unlink: (input) => unlinkOAuth(ctx, input),
      authorize: (input) => oauthAuthorize(ctx, input),
      callback: (input) => oauthCallback(ctx, input),
    },
    sessions: {
      sign: (input) => signSession(ctx, input),
      verify: (token, realm) => verifySession(ctx, token, realm),
      validate: (token, realm) => validateSession(ctx, token, realm),
      logout: (token, realm) => logout(ctx, token, realm),
    },
    revocation: {
      advance: (input) => advanceAnchor(ctx, input),
      revoke: (input) => revokeSessions(ctx, input),
      validAt: (input) => sessionValidAt(ctx, input),
    },
    captcha: {
      verify: (input) => verifyCaptcha(ctx, input),
    },
  };
}
