/**
 * 装配配置解析(fail fast:词表形状/去重/数值界在 createIdentity 时一次性全查,
 * 铁律 3 零默认——一切可变值必填注入)。
 */
import { identityErrors } from './errors.js';
import { BUILTIN_IDENTIFIER_KINDS, VOCAB_RE, type ValidationGuards } from './identifier.js';
import { resolvePasswordPolicy, type PasswordPolicy } from './password.js';
import { assertSessionTtlSec, type SessionRealmConfig } from './session.js';
import { CHALLENGE_BOUNDS } from './challenge.js';

export interface ChallengeConfig {
  readonly digits: number;
  readonly ttlMs: number;
  readonly cooldownMs: number;
  readonly maxAttempts: number;
}

export interface TotpConfig {
  readonly issuer: string;
  readonly stepSec: number;
  readonly windowSteps: number;
  readonly recoveryCount: number;
}

/** OAuth 上游端点覆盖(部分覆盖即可,未覆盖项用适配器公网缺省;测试/私有化网关) */
export interface OAuthEndpointsOverride {
  readonly authorizeUrl?: string;
  readonly tokenUrl?: string;
  readonly profileUrl?: string;
  readonly emailsUrl?: string;
}

export interface OAuthProviderCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly endpoints?: OAuthEndpointsOverride;
}

export interface IdentityConfigInput {
  /** 标识词表(内置 {email,phone,username} 的非空子集) */
  readonly identifiers: readonly string[];
  readonly providers: readonly string[];
  readonly challengeKinds: readonly string[];
  readonly realms: readonly string[];
  readonly passwordPolicy: PasswordPolicy;
  readonly challenge: ChallengeConfig;
  /** 挑战/恢复码 HMAC pepper(服务端密钥,16-512 字符) */
  readonly codePepper: string;
  readonly totp: TotpConfig;
  /** 每 realm 会话配置(键必须与 realms 词表一致) */
  readonly sessions: Readonly<Record<string, SessionRealmConfig>>;
  /**
   * 每 provider 上游凭据快照 getter(动态配置源——DB 集成设置/静态表均可;
   * 每次 OAuth 动词解析时调用,键 ⊆ providers 词表与凭据非空在解析期校验)。
   */
  readonly oauth: () => Readonly<Record<string, OAuthProviderCredentials>>;
  /** OAuth state 存活秒(v1=600) */
  readonly oauthStateTtlSec: number;
  /**
   * OAuth redirect_uri 精确匹配白名单(部署方登记的本站回调地址全集;fail-closed:
   * authorize 与 callback 两半程都校验,不在词表内直接拒绝——防开放重定向/授权码截断)
   */
  readonly oauthRedirectAllowlist: readonly string[];
}

export interface ResolvedIdentityConfig {
  readonly passwordPolicy: PasswordPolicy;
  readonly challenge: ChallengeConfig;
  readonly codePepper: string;
  readonly totp: TotpConfig;
  readonly sessions: Readonly<Record<string, SessionRealmConfig>>;
  readonly oauth: () => Readonly<Record<string, OAuthProviderCredentials>>;
  readonly oauthStateTtlSec: number;
  readonly oauthRedirectAllowlist: readonly string[];
}

export interface ResolvedConfig {
  readonly config: ResolvedIdentityConfig;
  readonly guards: ValidationGuards;
}

/** redirect_uri 运行期守卫:精确匹配白名单(fail-closed;authorize/callback 两半程共用) */
export function assertRedirectAllowed(config: ResolvedIdentityConfig, redirectUri: string): string {
  if (typeof redirectUri !== 'string' || !config.oauthRedirectAllowlist.includes(redirectUri)) {
    throw identityErrors.business('invalid_input', {
      field: 'redirectUri',
      reason: 'not in oauthRedirectAllowlist (exact match required)',
    });
  }
  return redirectUri;
}

function badConfig(field: string, reason: string): never {
  throw identityErrors.business('invalid_input', { field, reason });
}

function vocabList(values: readonly string[], field: string): readonly string[] {
  if (!Array.isArray(values) || values.length === 0) {
    badConfig(field, 'must be a non-empty array');
  }
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || !VOCAB_RE.test(value)) {
      badConfig(field, `entry '${String(value)}' must match ${VOCAB_RE.source}`);
    }
    if (seen.has(value)) badConfig(field, `duplicate entry '${value}'`);
    seen.add(value);
  }
  return values;
}

function intIn(value: number, field: string, bounds: readonly [number, number]): number {
  if (!Number.isInteger(value) || value < bounds[0] || value > bounds[1]) {
    badConfig(field, `must be an integer in [${bounds[0]}, ${bounds[1]}]`);
  }
  return value;
}

/** 挑战参数块校验(digits/ttl/cooldown/maxAttempts 均界内) */
function resolveChallengeConfig(challenge: ChallengeConfig): ChallengeConfig {
  intIn(challenge.digits, 'challenge.digits', [6, 8]);
  return {
    digits: challenge.digits,
    ttlMs: intIn(challenge.ttlMs, 'challenge.ttlMs', CHALLENGE_BOUNDS.ttlMs),
    cooldownMs: intIn(challenge.cooldownMs, 'challenge.cooldownMs', CHALLENGE_BOUNDS.cooldownMs),
    maxAttempts: intIn(
      challenge.maxAttempts,
      'challenge.maxAttempts',
      CHALLENGE_BOUNDS.maxAttempts,
    ),
  };
}

/** TOTP 块校验(步长/窗口/恢复码数界内 + issuer 非空限长) */
function validateTotpConfig(totp: TotpConfig): void {
  intIn(totp.stepSec, 'totp.stepSec', [5, 120]);
  intIn(totp.windowSteps, 'totp.windowSteps', [0, 5]);
  intIn(totp.recoveryCount, 'totp.recoveryCount', [1, 20]);
  if (typeof totp.issuer !== 'string' || totp.issuer.length === 0 || totp.issuer.length > 255) {
    badConfig('totp.issuer', 'must be a string of 1-255 characters');
  }
}

/** 会话块校验:声明的 realm 必有配置且 issuer/secret/ttl 合法(签发面完备,fail fast) */
function validateSessions(
  sessions: Readonly<Record<string, SessionRealmConfig>>,
  realms: readonly string[],
): void {
  const realmSet = new Set(realms);
  for (const [realm, session] of Object.entries(sessions)) {
    if (!realmSet.has(realm)) badConfig('sessions', `realm '${realm}' is not declared in realms`);
    if (
      typeof session.issuer !== 'string' ||
      session.issuer.length === 0 ||
      session.issuer.length > 255
    ) {
      badConfig(`sessions.${realm}.issuer`, 'must be a string of 1-255 characters');
    }
    if (typeof session.secret !== 'string' || session.secret.length < 16) {
      badConfig(`sessions.${realm}.secret`, 'must be a string of >= 16 characters');
    }
    assertSessionTtlSec(session.ttlSec);
  }
  // 每 realm 必须有会话配置(签发面完备;fail fast)
  for (const realm of realms) {
    if (sessions[realm] == null) {
      badConfig('sessions', `realm '${realm}' has no session config`);
    }
  }
}

/** redirect_uri 白名单校验:非空、绝对 http(s) URL、无 query/fragment、不重复(精确匹配词表) */
function validateRedirectAllowlist(uris: readonly string[]): void {
  if (!Array.isArray(uris) || uris.length === 0) {
    badConfig('oauthRedirectAllowlist', 'must be a non-empty array of redirect URIs');
  }
  const seen = new Set<string>();
  for (const uri of uris) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      badConfig('oauthRedirectAllowlist', `entry '${uri}' is not an absolute URL`);
      continue;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      badConfig('oauthRedirectAllowlist', `entry '${uri}' must use http(s)`);
    }
    if (parsed.search !== '' || parsed.hash !== '') {
      badConfig('oauthRedirectAllowlist', `entry '${uri}' must not carry query or fragment`);
    }
    if (seen.has(uri)) badConfig('oauthRedirectAllowlist', `duplicate entry '${uri}'`);
    seen.add(uri);
  }
}

/**
 * OAuth 凭据形状校验（解析期按被请求的键调用）。词表拦截在上游 guardProvider
 * （词表外 provider 抛 unknown_provider）——本函数只回答「凭据本身可用吗」，
 * 不再持有词表分支（review 修复 C：消除结构性不可达的死代码）。
 */
export function validateOauthCreds(creds: OAuthProviderCredentials, provider: string): void {
  if (typeof creds?.clientId !== 'string' || creds.clientId.length === 0) {
    badConfig(`oauth.${provider}.clientId`, 'must be a non-empty string');
  }
  if (typeof creds.clientSecret !== 'string' || creds.clientSecret.length === 0) {
    badConfig(`oauth.${provider}.clientSecret`, 'must be a non-empty string');
  }
}

export function resolveConfig(input: IdentityConfigInput): ResolvedConfig {
  const identifiers = vocabList(input.identifiers, 'identifiers');
  for (const kind of identifiers) {
    if (!BUILTIN_IDENTIFIER_KINDS.includes(kind as never)) {
      badConfig('identifiers', `'${kind}' is not a built-in kind (email/phone/username)`);
    }
  }
  const providers = vocabList(input.providers, 'providers');
  const challengeKinds = vocabList(input.challengeKinds, 'challengeKinds');
  const realms = vocabList(input.realms, 'realms');

  const passwordPolicy = resolvePasswordPolicy(input.passwordPolicy);
  const challenge = resolveChallengeConfig(input.challenge);

  if (
    typeof input.codePepper !== 'string' ||
    input.codePepper.length < 16 ||
    input.codePepper.length > 512
  ) {
    badConfig('codePepper', 'must be a string of 16-512 characters');
  }

  validateTotpConfig(input.totp);
  validateSessions(input.sessions, realms);
  intIn(input.oauthStateTtlSec, 'oauthStateTtlSec', [60, 3600]);
  validateRedirectAllowlist(input.oauthRedirectAllowlist);
  if (typeof input.oauth !== 'function') {
    badConfig('oauth', 'must be a snapshot getter () => Record<string, OAuthProviderCredentials>');
  }

  return {
    config: {
      passwordPolicy,
      challenge,
      codePepper: input.codePepper,
      totp: input.totp,
      sessions: input.sessions,
      oauth: input.oauth,
      oauthStateTtlSec: input.oauthStateTtlSec,
      oauthRedirectAllowlist: input.oauthRedirectAllowlist,
    },
    guards: {
      identifierKinds: new Set(identifiers),
      providers: new Set(providers),
      challengeKinds: new Set(challengeKinds),
      realms: new Set(realms),
    },
  };
}
