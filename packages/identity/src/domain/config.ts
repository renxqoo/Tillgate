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
  /** 每 provider 上游凭据(键 ⊆ providers 词表;未配置的 provider 运行期 not_found) */
  readonly oauth: Readonly<Record<string, OAuthProviderCredentials>>;
  /** OAuth state 存活秒(v1=600) */
  readonly oauthStateTtlSec: number;
}

export interface ResolvedIdentityConfig {
  readonly passwordPolicy: PasswordPolicy;
  readonly challenge: ChallengeConfig;
  readonly codePepper: string;
  readonly totp: TotpConfig;
  readonly sessions: Readonly<Record<string, SessionRealmConfig>>;
  readonly oauth: Readonly<Record<string, OAuthProviderCredentials>>;
  readonly oauthStateTtlSec: number;
}

export interface ResolvedConfig {
  readonly config: ResolvedIdentityConfig;
  readonly guards: ValidationGuards;
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

function intIn(value: number, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    badConfig(field, `must be an integer in [${min}, ${max}]`);
  }
  return value;
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
  const { digits } = input.challenge;
  intIn(digits, 'challenge.digits', 6, 8);
  const challenge: ChallengeConfig = {
    digits,
    ttlMs: intIn(
      input.challenge.ttlMs,
      'challenge.ttlMs',
      CHALLENGE_BOUNDS.ttlMs[0],
      CHALLENGE_BOUNDS.ttlMs[1],
    ),
    cooldownMs: intIn(
      input.challenge.cooldownMs,
      'challenge.cooldownMs',
      CHALLENGE_BOUNDS.cooldownMs[0],
      CHALLENGE_BOUNDS.cooldownMs[1],
    ),
    maxAttempts: intIn(
      input.challenge.maxAttempts,
      'challenge.maxAttempts',
      CHALLENGE_BOUNDS.maxAttempts[0],
      CHALLENGE_BOUNDS.maxAttempts[1],
    ),
  };

  if (
    typeof input.codePepper !== 'string' ||
    input.codePepper.length < 16 ||
    input.codePepper.length > 512
  ) {
    badConfig('codePepper', 'must be a string of 16-512 characters');
  }

  intIn(input.totp.stepSec, 'totp.stepSec', 5, 120);
  intIn(input.totp.windowSteps, 'totp.windowSteps', 0, 5);
  intIn(input.totp.recoveryCount, 'totp.recoveryCount', 1, 20);
  if (
    typeof input.totp.issuer !== 'string' ||
    input.totp.issuer.length < 1 ||
    input.totp.issuer.length > 255
  ) {
    badConfig('totp.issuer', 'must be a string of 1-255 characters');
  }

  const realmSet = new Set(realms);
  for (const [realm, session] of Object.entries(input.sessions)) {
    if (!realmSet.has(realm)) badConfig('sessions', `realm '${realm}' is not declared in realms`);
    if (
      typeof session.issuer !== 'string' ||
      session.issuer.length < 1 ||
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
    if (input.sessions[realm] == null) {
      badConfig('sessions', `realm '${realm}' has no session config`);
    }
  }
  intIn(input.oauthStateTtlSec, 'oauthStateTtlSec', 60, 3600);

  const providerSet = new Set(providers);
  for (const [provider, creds] of Object.entries(input.oauth)) {
    if (!providerSet.has(provider))
      badConfig('oauth', `provider '${provider}' is not declared in providers`);
    if (typeof creds?.clientId !== 'string' || creds.clientId.length === 0) {
      badConfig(`oauth.${provider}.clientId`, 'must be a non-empty string');
    }
    if (typeof creds.clientSecret !== 'string' || creds.clientSecret.length === 0) {
      badConfig(`oauth.${provider}.clientSecret`, 'must be a non-empty string');
    }
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
    },
    guards: {
      identifierKinds: new Set(identifiers),
      providers: providerSet,
      challengeKinds: new Set(challengeKinds),
      realms: realmSet,
    },
  };
}
