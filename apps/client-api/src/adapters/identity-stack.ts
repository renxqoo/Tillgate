/**
 * identity 装配栈（从 assembly.ts 拆出——铁律 5 max-lines 收口；装配面桥接件，
 * 仅 assembly.ts 引用）：OAuth 凭证映射 + SMTP 登录邮件（缺省按环境构造，测试缝
 * 显式注入/置空）+ Redis 吊销/OAuth state + createIdentity 全量配置。
 * emailCodeRequired 的 auto 口径：SMTP 已配置即强制两级登录（v1 语义）。
 */
import type { Db, TxRetryPolicy } from '@tillgate/db';
import type { Logger } from '@tillgate/runtime';
import type { Redis } from 'ioredis';
import {
  createIdentity,
  type Identity,
  type Mailer,
  type OAuthEndpointsOverride,
  type OAuthProviderCredentials,
} from '@tillgate/identity';
import type { ClientApiConfig } from '../config.js';
import { createRedisSessionRevocation } from './redis-session-revocation.js';
import { createRedisOAuthStateStore } from './redis-oauth-state.js';
import { createSmtpLoginMailer } from './smtp-login-mailer.js';
import {
  createRedisResetTokenStore,
  RESET_TOKEN_TTL_MINUTES,
  type ResetTokenStore,
} from './redis-reset-token.js';
import { createTurnstileCaptcha } from './turnstile-captcha.js';

export interface IdentityStack {
  readonly identity: Identity;
  readonly oauthProviders: Record<string, OAuthProviderCredentials>;
  readonly mailer: Mailer | null;
  readonly resetTokens: ResetTokenStore;
  readonly emailCodeRequired: boolean;
  readonly apiBase: string;
}

/** 端点覆盖解析（JSON 已在 config 预校验；此处仅反序列化） */
function parseEndpoints(json: string | undefined): OAuthEndpointsOverride | undefined {
  if (!json) return undefined;
  return JSON.parse(json) as OAuthEndpointsOverride;
}

export function createIdentityStack(args: {
  config: ClientApiConfig;
  db: Db;
  redis: Redis;
  txRetry: TxRetryPolicy;
  logger: Logger;
  clock: () => Date;
  mailerOverride?: Mailer | null;
}): IdentityStack {
  const { config, db, redis, txRetry, logger, clock, mailerOverride } = args;

  const oauthProviders: Record<string, OAuthProviderCredentials> = {};
  if (config.OAUTH_GITHUB_CLIENT_ID != null && config.OAUTH_GITHUB_CLIENT_SECRET != null) {
    const endpoints = parseEndpoints(config.OAUTH_GITHUB_ENDPOINTS_JSON);
    oauthProviders.github = {
      clientId: config.OAUTH_GITHUB_CLIENT_ID,
      clientSecret: config.OAUTH_GITHUB_CLIENT_SECRET,
      ...(endpoints != null ? { endpoints } : {}),
    };
  }
  if (config.OAUTH_GOOGLE_CLIENT_ID != null && config.OAUTH_GOOGLE_CLIENT_SECRET != null) {
    const endpoints = parseEndpoints(config.OAUTH_GOOGLE_ENDPOINTS_JSON);
    oauthProviders.google = {
      clientId: config.OAUTH_GOOGLE_CLIENT_ID,
      clientSecret: config.OAUTH_GOOGLE_CLIENT_SECRET,
      ...(endpoints != null ? { endpoints } : {}),
    };
  }
  const smtpReady =
    config.SMTP_HOST != null && config.SMTP_USER != null && config.SMTP_PASS != null;
  // 用户面邮件品牌（展示常量——非部署可变值）
  const mailBrand = {
    brand: 'Tillgate 控制台',
    brandEn: 'Tillgate Console',
    brandSub: 'TILLGATE · CONSOLE',
  };
  let mailer: Mailer | null;
  if (mailerOverride === undefined) {
    mailer = smtpReady
      ? createSmtpLoginMailer(
          {
            host: config.SMTP_HOST as string,
            port: config.SMTP_PORT,
            user: config.SMTP_USER as string,
            pass: config.SMTP_PASS as string,
            from: config.SMTP_FROM ?? (config.SMTP_USER as string),
          },
          mailBrand,
          {
            ttlMinutes: Math.ceil(config.CLIENT_CHALLENGE_TTL_MS / 60_000),
            maxAttempts: config.CLIENT_CHALLENGE_MAX_ATTEMPTS,
          },
          { ttlMinutes: RESET_TOKEN_TTL_MINUTES },
          clock,
        )
      : null;
  } else {
    mailer = mailerOverride;
  }
  let emailCodeRequired = mailer != null; // auto：SMTP 已配置即强制两级登录（v1 口径）
  if (config.EMAIL_CODE_REQUIRED === 'on') emailCodeRequired = true;
  else if (config.EMAIL_CODE_REQUIRED === 'off') emailCodeRequired = false;

  const apiBase = config.OAUTH_API_BASE ?? 'http://localhost:8081';
  const identity = createIdentity({
    db,
    txRetry,
    clock: { now: clock },
    logger: { warn: (obj, msg) => logger.warn(obj as object, msg) },
    config: {
      identifiers: ['email'],
      // providers 是 identity 认识的词表（须非空）；凭证映射在 oauth——
      // 未配凭证的 provider 运行时 oauth_provider_unconfigured → 路由 404
      providers: ['github', 'google'],
      challengeKinds: ['email_code'],
      realms: ['user'],
      passwordPolicy: { minLength: config.CLIENT_PASSWORD_MIN_LENGTH, maxLength: 128 },
      challenge: {
        digits: 6,
        ttlMs: config.CLIENT_CHALLENGE_TTL_MS,
        cooldownMs: config.CLIENT_CHALLENGE_COOLDOWN_MS,
        maxAttempts: config.CLIENT_CHALLENGE_MAX_ATTEMPTS,
      },
      codePepper: config.CLIENT_CODE_PEPPER,
      // TOTP 词表必填项（用户面暂不开放 MFA 端点——identity 配置契约）
      totp: { issuer: config.CLIENT_TOTP_ISSUER, stepSec: 30, windowSteps: 1, recoveryCount: 8 },
      sessions: {
        user: {
          issuer: 'tillgate:user',
          secret: config.JWT_SECRET,
          ttlSec: config.SESSION_TTL_SECONDS,
        },
      },
      oauth: oauthProviders,
      oauthStateTtlSec: config.OAUTH_STATE_TTL_SECONDS,
      // 回调地址精确白名单（identity assertRedirectAllowed 消费；两 provider 常驻）
      oauthRedirectAllowlist: [
        `${apiBase}/v1/oauth/github/callback`,
        `${apiBase}/v1/oauth/google/callback`,
      ],
    },
    ...(mailer != null ? { mailer } : {}),
    ...(config.CAPTCHA_SECRET_KEY != null
      ? {
          captcha: createTurnstileCaptcha({
            secretKey: config.CAPTCHA_SECRET_KEY,
            verifyUrl: config.CAPTCHA_VERIFY_URL,
          }),
        }
      : {}),
    sessionRevocation: createRedisSessionRevocation(redis),
    oauthStateStore: createRedisOAuthStateStore(redis),
  });

  return {
    identity,
    oauthProviders,
    mailer,
    resetTokens: createRedisResetTokenStore(redis),
    emailCodeRequired,
    apiBase,
  };
}
