/** 运行期上下文：三张白名单守卫 + 解析后的配置（createIdentity 时一次性校验，fail fast） */
import { InvalidInputError } from './errors.js';
import { resolvePasswordPolicy } from './password.js';
import { buildGuards, VOCAB_RE, type ValidationGuards } from './validation.js';
import type {
  ChallengeConfig,
  CreateIdentityOptions,
  IdentityEffects,
  PasswordPolicy,
  TotpConfig,
} from './types.js';

export const DEFAULT_CHALLENGE_CONFIG: Readonly<Required<ChallengeConfig>> = {
  digits: 6,
  ttlMs: 300_000,
  cooldownMs: 60_000,
  maxAttempts: 5,
};

export const DEFAULT_TOTP_CONFIG: Readonly<Required<Omit<TotpConfig, 'secretCipher'>>> = {
  issuer: 'identity',
  stepSec: 30,
  windowStep: 1,
  recoveryCodeCount: 10,
};

export interface ResolvedConfig {
  password: PasswordPolicy;
  challenge: Required<ChallengeConfig>;
  totp: Required<Omit<TotpConfig, 'secretCipher'>> & Pick<TotpConfig, 'secretCipher'>;
}

export interface IdentityContext {
  guards: ValidationGuards;
  config: ResolvedConfig;
  effects?: IdentityEffects;
  clock: () => Date;
}

function resolveVocabList(name: string, values: readonly string[] | undefined): string[] {
  const list = values ?? [];
  for (const value of list) {
    if (typeof value !== 'string' || !VOCAB_RE.test(value)) {
      throw new InvalidInputError(name, `entry '${String(value)}' must match ${VOCAB_RE.source}`);
    }
  }
  if (new Set(list).size !== list.length) {
    throw new InvalidInputError(name, 'duplicate entries');
  }
  return [...list];
}

function boundedInt(
  field: string,
  value: number,
  min: number,
  max: number,
): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new InvalidInputError(field, `must be an integer in [${min}, ${max}], got ${String(value)}`);
  }
  return value;
}

/** 全量配置解析：任何配置错误在 createIdentity 即抛（不把坏配置带进运行期） */
export function resolveContext(options: CreateIdentityOptions): IdentityContext {
  if (options == null || !Array.isArray(options.identifiers) || options.identifiers.length === 0) {
    throw new InvalidInputError('identifiers', 'must be a non-empty array (fail-closed whitelist)');
  }
  for (const kind of options.identifiers) {
    if (kind !== 'email' && kind !== 'phone' && kind !== 'username') {
      throw new InvalidInputError('identifiers', `kind '${String(kind)}' is not in the built-in vocabulary`);
    }
  }
  const providers = resolveVocabList('providers', options.providers);
  const challenges = resolveVocabList('challenges', options.challenges);

  const challenge = { ...DEFAULT_CHALLENGE_CONFIG, ...options.challenge };
  boundedInt('challenge.digits', challenge.digits, 4, 10);
  boundedInt('challenge.ttlMs', challenge.ttlMs, 1_000, 86_400_000);
  boundedInt('challenge.cooldownMs', challenge.cooldownMs, 0, 3_600_000);
  boundedInt('challenge.maxAttempts', challenge.maxAttempts, 1, 100);

  const totp = { ...DEFAULT_TOTP_CONFIG, ...options.totp };
  if (typeof totp.issuer !== 'string' || totp.issuer.length === 0 || totp.issuer.length > 64) {
    throw new InvalidInputError('totp.issuer', 'must be a non-empty string of at most 64 chars');
  }
  boundedInt('totp.stepSec', totp.stepSec, 15, 120);
  boundedInt('totp.windowStep', totp.windowStep, 0, 5);
  boundedInt('totp.recoveryCodeCount', totp.recoveryCodeCount, 1, 50);

  const guards = buildGuards({ identifiers: options.identifiers, providers, challenges });
  return {
    guards,
    config: {
      password: resolvePasswordPolicy({ ...options.password, validate: options.passwordValidate }),
      challenge,
      totp: { ...totp, secretCipher: options.totpSecretCipher },
    },
    effects: options.effects,
    clock: options.clock ?? (() => new Date()),
  };
}
