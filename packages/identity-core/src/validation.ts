/** 白名单守卫与标识归一化（fail-closed：词表外的值在进 DB 前一律拒绝） */
import {
  InvalidIdentifierError,
  InvalidInputError,
  InvalidUserIdError,
  UnknownChallengeKindError,
  UnknownIdentifierKindError,
  UnknownProviderError,
} from './errors.js';
import type { Identifier, IdentifierKind, NormalizedIdentifier } from './types.js';

/** 三张白名单 + realm 白名单（createIdentity 时从必填选项构建，运行期只读） */
export interface ValidationGuards {
  identifierKinds: ReadonlySet<string>;
  providers: ReadonlySet<string>;
  challengeKinds: ReadonlySet<string>;
  realms: ReadonlySet<string>;
}

const IDENTIFIER_KINDS: readonly IdentifierKind[] = ['email', 'phone', 'username'];

export function buildGuards(input: {
  identifiers: readonly string[];
  providers: readonly string[];
  challenges: readonly string[];
  realms: readonly string[];
}): ValidationGuards {
  return {
    identifierKinds: new Set(input.identifiers),
    providers: new Set(input.providers),
    challengeKinds: new Set(input.challenges),
    realms: new Set(input.realms),
  };
}

/** 缺省身份域（单一用户面的系统无需声明 realms） */
export const DEFAULT_REALM = 'user';

/** realm 格式校验（词表符号同款）；白名单命中在动词层判定 */
export function assertRealm(realm: string): string {
  if (!VOCAB_RE.test(realm)) {
    throw new InvalidInputError('realm', `must match ${VOCAB_RE.source}`);
  }
  return realm;
}

function allowedList(values: ReadonlySet<string>): string[] {
  return [...values];
}

/** 词表符号（provider / challenge kind 共用）：小写 snake/kebab，2-32 位 */
export const VOCAB_RE = /^[a-z][a-z0-9_-]{1,31}$/;

export function guardIdentifierKind(kind: string, guards: ValidationGuards): IdentifierKind {
  if (!IDENTIFIER_KINDS.includes(kind as IdentifierKind)) {
    // 内置词表之外：即算白名单声明了也无效（扩展=改包发版）
    throw new UnknownIdentifierKindError(kind, IDENTIFIER_KINDS);
  }
  if (!guards.identifierKinds.has(kind)) {
    throw new UnknownIdentifierKindError(kind, allowedList(guards.identifierKinds));
  }
  return kind as IdentifierKind;
}

export function guardProvider(provider: string, guards: ValidationGuards): string {
  if (!VOCAB_RE.test(provider)) {
    throw new InvalidInputError('provider', `must match ${VOCAB_RE.source}`);
  }
  if (!guards.providers.has(provider)) {
    throw new UnknownProviderError(provider, allowedList(guards.providers));
  }
  return provider;
}

export function guardChallengeKind(kind: string, guards: ValidationGuards): string {
  if (!VOCAB_RE.test(kind)) {
    throw new InvalidInputError('challenge kind', `must match ${VOCAB_RE.source}`);
  }
  if (!guards.challengeKinds.has(kind)) {
    throw new UnknownChallengeKindError(kind, allowedList(guards.challengeKinds));
  }
  return kind;
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{1,62}$/;
const PHONE_RE = /^\+?[0-9]{5,20}$/;
const USERNAME_RE = /^[A-Za-z0-9_-]{3,64}$/;

/**
 * 标识归一化（存储与比较永远用归一形态——大写邮箱/带空格手机号不得产生第二账号）：
 *   email    trim + 小写 + 形状校验
 *   phone    去分隔符（空格/连字符/括号/点）+ E.164 风格数字形状校验
 *   username trim + 字符集校验（大小写敏感）
 */
export function normalizeIdentifier(
  input: Identifier,
  guards: ValidationGuards,
): NormalizedIdentifier {
  const kind = guardIdentifierKind(input?.kind, guards);
  if (typeof input?.value !== 'string') {
    throw new InvalidIdentifierError(kind, 'value must be a string');
  }
  const raw = input.value;
  if (kind === 'email') {
    const value = raw.trim().toLowerCase();
    if (value.length === 0 || value.length > 255 || !EMAIL_RE.test(value)) {
      throw new InvalidIdentifierError('email', `malformed address '${truncate(raw)}'`);
    }
    return { kind, value };
  }
  if (kind === 'phone') {
    const value = raw.replace(/[\s\-().]/g, '');
    if (!PHONE_RE.test(value)) {
      throw new InvalidIdentifierError('phone', `malformed number '${truncate(raw)}'`);
    }
    return { kind, value };
  }
  const value = raw.trim();
  if (!USERNAME_RE.test(value)) {
    throw new InvalidIdentifierError('username', `must match ${USERNAME_RE.source}`);
  }
  return { kind, value };
}

function truncate(value: string, max = 40): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** 正整数 userId（bigserial 语义域；消费方自增主键或雪花 id 均可） */
export function assertUserId(userId: unknown): number {
  if (typeof userId !== 'number' || !Number.isInteger(userId) || userId <= 0 || userId > Number.MAX_SAFE_INTEGER) {
    throw new InvalidUserIdError(userId);
  }
  return userId;
}

/** OAuth subject：三方平台用户 id（opaque，trim 后 1-255 位可见字符） */
export function assertOAuthSubject(subject: unknown): string {
  if (typeof subject !== 'string') {
    throw new InvalidInputError('subject', 'must be a string');
  }
  const value = subject.trim();
  if (value.length < 1 || value.length > 255) {
    throw new InvalidInputError('subject', `length must be 1-255, got ${value.length}`);
  }
  return value;
}

/** 展示用邮箱（provider 报告值，不参与合并判断）：轻校验（长度），不强制形状 */
export function normalizeDisplayEmail(email: string | null | undefined): string | null {
  if (email == null) return null;
  const value = String(email).trim().toLowerCase();
  if (value.length === 0) return null;
  if (value.length > 255) {
    throw new InvalidInputError('email', `length must be <=255, got ${value.length}`);
  }
  return value;
}

/** challengeId 形状（uuid v4 小写/大写均可）——非法即按挑战无效处理（统一口径） */
export function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
