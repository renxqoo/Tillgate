/**
 * 标识归一化与白名单守卫(fail-closed:词表外的值在进存储前一律拒绝)。
 * 归一形态是存储与比较的唯一形态——大写邮箱/带分隔符手机号不得产生第二账号。
 */
import { identityErrors } from './errors.js';

export type IdentifierKind = 'email' | 'phone' | 'username';

/** 内置标识词表(闭集;扩展 = 契约变更,须同步 DESIGN §2.2) */
export const BUILTIN_IDENTIFIER_KINDS: readonly IdentifierKind[] = ['email', 'phone', 'username'];

/** 词表符号(provider / challenge kind / realm 共用):小写 snake/kebab,2-32 位 */
export const VOCAB_RE = /^[a-z][a-z0-9_-]{1,31}$/;

export interface Identifier {
  readonly kind: IdentifierKind | string;
  readonly value: string;
}

export interface NormalizedIdentifier {
  readonly kind: IdentifierKind;
  readonly value: string;
}

/** 运行期白名单(装配期由 domain/config.ts 从词表构建,只读) */
export interface ValidationGuards {
  readonly identifierKinds: ReadonlySet<string>;
  readonly providers: ReadonlySet<string>;
  readonly challengeKinds: ReadonlySet<string>;
  readonly realms: ReadonlySet<string>;
}

export function guardIdentifierKind(kind: string, guards: ValidationGuards): IdentifierKind {
  if (!BUILTIN_IDENTIFIER_KINDS.includes(kind as IdentifierKind)) {
    // 内置词表之外:即算白名单声明了也无效(扩展 = 改包发版)
    throw identityErrors.business('unknown_identifier_kind', {
      kind,
      allowed: BUILTIN_IDENTIFIER_KINDS,
    });
  }
  if (!guards.identifierKinds.has(kind)) {
    throw identityErrors.business('unknown_identifier_kind', {
      kind,
      allowed: [...guards.identifierKinds],
    });
  }
  return kind as IdentifierKind;
}

export function guardProvider(provider: string, guards: ValidationGuards): string {
  if (!VOCAB_RE.test(provider)) {
    throw identityErrors.business('invalid_input', { field: 'provider', pattern: VOCAB_RE.source });
  }
  if (!guards.providers.has(provider)) {
    throw identityErrors.business('unknown_provider', { provider, allowed: [...guards.providers] });
  }
  return provider;
}

export function guardChallengeKind(kind: string, guards: ValidationGuards): string {
  if (!VOCAB_RE.test(kind)) {
    throw identityErrors.business('invalid_input', {
      field: 'challenge kind',
      pattern: VOCAB_RE.source,
    });
  }
  if (!guards.challengeKinds.has(kind)) {
    throw identityErrors.business('unknown_challenge_kind', {
      kind,
      allowed: [...guards.challengeKinds],
    });
  }
  return kind;
}

/** realm 双用途守卫:格式 + 白名单(写读双路径同口径,B08 修复) */
export function guardRealm(realm: string, guards: ValidationGuards): string {
  if (!VOCAB_RE.test(realm)) {
    throw identityErrors.business('invalid_input', { field: 'realm', pattern: VOCAB_RE.source });
  }
  if (!guards.realms.has(realm)) {
    throw identityErrors.business('unknown_realm', { realm, allowed: [...guards.realms] });
  }
  return realm;
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{1,62}$/;
const PHONE_RE = /^\+?[0-9]{5,20}$/;
const USERNAME_RE = /^[A-Za-z0-9_-]{3,64}$/;

/**
 * 标识归一化:
 *   email    trim + 小写 + 形状校验
 *   phone    去分隔符(空格/连字符/括号/点) + E.164 风格数字形状校验
 *   username trim + 字符集校验(大小写敏感)
 */
export function normalizeIdentifier(
  input: Identifier,
  guards: ValidationGuards,
): NormalizedIdentifier {
  const kind = guardIdentifierKind(input?.kind, guards);
  if (typeof input?.value !== 'string') {
    throw identityErrors.business('invalid_identifier', { kind, reason: 'value must be a string' });
  }
  const raw = input.value;
  if (kind === 'email') {
    const value = raw.trim().toLowerCase();
    const hasControlChar = [...value].some((ch) => {
      // [...value] 逐码点展开,ch 至少含一个码点;null 分支仅为类型收窄防御
      const codePoint = ch.codePointAt(0);
      return codePoint != null && (codePoint <= 0x1f || codePoint === 0x7f);
    });
    if (hasControlChar || value.length === 0 || value.length > 255 || !EMAIL_RE.test(value)) {
      throw identityErrors.business('invalid_identifier', { kind, reason: 'malformed address' });
    }
    return { kind, value };
  }
  if (kind === 'phone') {
    const value = raw.replace(/[\s\-().]/g, '');
    if (!PHONE_RE.test(value)) {
      throw identityErrors.business('invalid_identifier', { kind, reason: 'malformed number' });
    }
    return { kind, value };
  }
  const value = raw.trim();
  if (!USERNAME_RE.test(value)) {
    throw identityErrors.business('invalid_identifier', {
      kind,
      reason: 'invalid username charset',
    });
  }
  return { kind, value };
}

/** 正整数 userId(bigserial 语义域;消费方自增主键或雪花 id 均可) */
export function assertUserId(userId: unknown): number {
  if (
    typeof userId !== 'number' ||
    !Number.isInteger(userId) ||
    userId <= 0 ||
    userId > Number.MAX_SAFE_INTEGER
  ) {
    throw identityErrors.business('invalid_user_id', { userId: String(userId) });
  }
  return userId;
}

/** OAuth subject:三方平台用户 id(opaque,trim 后 1-255 位) */
export function assertOAuthSubject(subject: unknown): string {
  if (typeof subject !== 'string') {
    throw identityErrors.business('invalid_input', {
      field: 'subject',
      reason: 'must be a string',
    });
  }
  const value = subject.trim();
  if (value.length === 0 || value.length > 255) {
    throw identityErrors.business('invalid_subject', { length: value.length });
  }
  return value;
}

/** 展示用邮箱(provider 报告值,不参与合并判断):轻校验(长度),不强制形状 */
export function normalizeDisplayEmail(email: string | null | undefined): string | null {
  if (email == null) return null;
  const value = String(email).trim().toLowerCase();
  if (value.length === 0) return null;
  if (value.length > 255) {
    throw identityErrors.business('invalid_input', {
      field: 'email',
      reason: 'length must be <=255',
    });
  }
  return value;
}

/** challengeId 形状(uuid 大小写不限)——非法即按挑战无效处理(统一口径) */
export function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
