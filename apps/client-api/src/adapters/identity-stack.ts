/**
 * identity 装配栈（装配面桥接件，仅 assembly.ts 引用）：
 * OAuth 凭证/SMTP 邮件/人机验证全部由集成设置 reader
 * 动态驱动——快照 getter 喂 identity、
 * 动态 mailer/captcha 包装，emailCodeRequired 的 auto 口径每请求求值。
 * apiBase/frontendUrl 为装配期 boot 解析（回调白名单是装配期契约）。
 */
import type { Db, TxRetryPolicy } from '@tillgate/db';
import type { IntegrationSettingsReader } from '@tillgate/control-plane';
import { createCipher, type Logger } from '@tillgate/runtime';
import type { Redis } from 'ioredis';
import {
  createIdentity,
  OAUTH_UPSTREAM_DEFAULTS,
  type Captcha,
  type Identity,
  type Mailer,
  type OAuthEndpointsOverride,
  type OAuthProviderCredentials,
} from '@tillgate/identity';
import type { ClientApiConfig } from '../config.js';
import { createRedisSessionRevocation } from './redis-session-revocation.js';
import { createRedisOAuthStateStore } from './redis-oauth-state.js';
import { createDynamicCaptcha } from './dynamic-captcha.js';
import { createDynamicLoginMailer } from './dynamic-login-mailer.js';
import {
  createRedisResetTokenStore,
  RESET_TOKEN_TTL_MINUTES,
  type ResetTokenStore,
} from './redis-reset-token.js';

/** OAuth provider 词表（identity 认识的键；凭据来源在集成设置快照） */
const OAUTH_PROVIDER_NAMES = ['github', 'google'] as const;

export interface IdentityStack {
  readonly identity: Identity;
  /** 动态 mailer（缺省恒存在；e2e 覆盖缝可注入/置空） */
  readonly mailer: Mailer | null;
  readonly captcha: Captcha;
  readonly resetTokens: ResetTokenStore;
  /** auto 口径每请求求值：on→true / off→false / auto→SMTP 生效 */
  readonly emailCodeRequired: () => boolean;
  /** 最新快照 effective 的 provider 键集（providers 端点/路由词表共用） */
  readonly oauthProviderNames: () => readonly string[];
  readonly apiBase: string;
  readonly frontendUrl: string;
}

// eslint-disable-next-line max-lines-per-function -- identity 装配根:oauth/mailer/captcha 动态化线性组装,分支即词表与开关判空
export function createIdentityStack(args: {
  config: ClientApiConfig;
  db: Db;
  redis: Redis;
  txRetry: TxRetryPolicy;
  logger: Logger;
  clock: () => Date;
  reader: IntegrationSettingsReader;
  /** 装配期 boot 解析的 OAuth 基地址（变更需重启） */
  apiBase: string;
  frontendUrl: string;
  mailerOverride?: Mailer | null;
}): IdentityStack {
  const { config, db, redis, txRetry, logger, clock, reader, apiBase } = args;

  // OAuth 凭证快照 getter（identity 同步契约→latest 面，stale-OK + 后台刷新）：
  // DB 凭据 + env 端点覆盖合并（ENDPOINTS_JSON 保持 env 专属）
  const oauthProviders = (): Record<string, OAuthProviderCredentials> => {
    const snapshot = reader.latest();
    const map: Record<string, OAuthProviderCredentials> = {};
    for (const name of OAUTH_PROVIDER_NAMES) {
      const resolved = snapshot.oauth[name];
      if (!resolved.effective || resolved.config == null) continue;
      const endpoints = parseEndpoints(config, name);
      map[name] = {
        clientId: resolved.config.clientId,
        clientSecret: resolved.config.clientSecret,
        ...(endpoints != null ? { endpoints } : {}),
      };
    }
    return map;
  };

  // 用户面邮件品牌（展示常量——非部署可变值）
  const mailBrand = {
    brand: 'Tillgate 控制台',
    brandEn: 'Tillgate Console',
    brandSub: 'TILLGATE · CONSOLE',
  };
  const mailer: Mailer | null =
    args.mailerOverride !== undefined
      ? args.mailerOverride
      : createDynamicLoginMailer({
          reader,
          brand: mailBrand,
          emailParams: {
            ttlMinutes: Math.ceil(config.CLIENT_CHALLENGE_TTL_MS / 60_000),
            maxAttempts: config.CLIENT_CHALLENGE_MAX_ATTEMPTS,
          },
          resetParams: { ttlMinutes: RESET_TOKEN_TTL_MINUTES },
          now: clock,
        });

  const emailCodeRequired = (): boolean => {
    if (config.EMAIL_CODE_REQUIRED === 'on') return true;
    if (config.EMAIL_CODE_REQUIRED === 'off') return false;
    // auto：覆盖缝注入时以 mailer 在场为准
    // （emailCodeRequired = mailer != null），缺省读快照 SMTP 生效
    if (args.mailerOverride !== undefined) return args.mailerOverride != null;
    return reader.latest().smtp.effective;
  };

  const captcha = createDynamicCaptcha({ reader });

  const identity = createIdentity({
    db,
    txRetry,
    clock: { now: clock },
    logger: { warn: (obj, msg) => logger.warn(obj as object, msg) },
    config: {
      identifiers: ['email'],
      // providers 是 identity 认识的词表（须非空）；凭据在 oauth getter 快照——
      // 未配凭据的 provider 运行时 oauth_provider_unconfigured → 路由 404
      providers: [...OAUTH_PROVIDER_NAMES],
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
      // 上游超时/重试(env 可调;缺省与 identity 装配缺省同源——境内直连
      // GitHub 丢包时曾拖满 socket 空闲窗,反代 502)
      oauthUpstream: {
        timeoutMs: config.OAUTH_UPSTREAM_TIMEOUT_MS ?? OAUTH_UPSTREAM_DEFAULTS.timeoutMs,
        attempts: config.OAUTH_UPSTREAM_ATTEMPTS ?? OAUTH_UPSTREAM_DEFAULTS.attempts,
        retryDelayMs: OAUTH_UPSTREAM_DEFAULTS.retryDelayMs,
      },
      oauthStateTtlSec: config.OAUTH_STATE_TTL_SECONDS,
      // 回调地址精确白名单（identity assertRedirectAllowed 消费；两 provider 常驻）
      oauthRedirectAllowlist: OAUTH_PROVIDER_NAMES.map(
        (name) => `${apiBase}/v1/oauth/${name}/callback`,
      ),
    },
    ...(mailer != null ? { mailer } : {}),
    captcha,
    sessionRevocation: createRedisSessionRevocation(redis),
    oauthStateStore: createRedisOAuthStateStore(redis),
    // TOTP secret 静态加密（S1：用户面 MFA 端点开放前即落密文形态；遗留明文行
    // 读取回落 + 重挂换密文收敛——见 identity loadedSecret）
    cipher: createCipher(config.ENCRYPTION_KEY),
  });

  return {
    identity,
    mailer,
    captcha,
    resetTokens: createRedisResetTokenStore(redis),
    emailCodeRequired,
    oauthProviderNames: () => {
      const snapshot = reader.latest();
      return OAUTH_PROVIDER_NAMES.filter((name) => snapshot.oauth[name].effective);
    },
    apiBase,
    frontendUrl: args.frontendUrl,
  };
}

/** 端点覆盖解析（env JSON：私有化/E2E mock 上游用；非法 JSON 启动期已 fail-loud） */
function parseEndpoints(
  config: ClientApiConfig,
  provider: string,
): OAuthEndpointsOverride | undefined {
  const json =
    provider === 'github' ? config.OAUTH_GITHUB_ENDPOINTS_JSON : config.OAUTH_GOOGLE_ENDPOINTS_JSON;
  if (!json) return undefined;
  return JSON.parse(json) as OAuthEndpointsOverride;
}
