/**
 * 密码哈希与策略(node:crypto scrypt,零三方依赖)。
 *
 * 存储格式 scrypt:N:r:p:<saltHex>:<hashHex>,N/r/p 自描述,未来换参数/argon2 按前缀分发。
 * 哑哈希恒定时间:标识不存在/哈希非法也跑等量 scrypt,「用户不存在」与「密码错」
 * 响应耗时一致(防时序枚举)。
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { identityErrors } from './errors.js';

// eslint-disable-next-line max-params -- node:crypto scrypt 回调签名(经 promisify 转造),参数位由内建 API 固定
const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** 默认 scrypt 参数(2^15 ≈ 50ms,登录场景安全且可接受;与 v1 一致) */
export const SCRYPT_N = 1 << 15;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
const HASH_LEN = 32;
const SCRYPT_MAXMEM = 512 * 1024 * 1024;

/** 存储格式校验(registerCredential 入参防呆:非本格式哈希入库 = 认证永远失败) */
export const PASSWORD_HASH_RE =
  /^scrypt:[1-9][0-9]{0,9}:[1-9][0-9]{0,9}:[1-9][0-9]{0,9}:[0-9a-f]{32}:[0-9a-f]{64}$/;

export interface PasswordPolicy {
  minLength: number;
  maxLength: number;
  /** 自定义规则:返回拒绝原因(英文)则视为不满足;返回 null/undefined 通过 */
  validate?(password: string): string | null | undefined;
}

export function resolvePasswordPolicy(policy: PasswordPolicy): PasswordPolicy {
  if (
    !Number.isInteger(policy.minLength) ||
    policy.minLength < 6 ||
    policy.minLength > 128 ||
    !Number.isInteger(policy.maxLength) ||
    policy.maxLength < policy.minLength ||
    policy.maxLength > 1024
  ) {
    throw identityErrors.business('invalid_input', {
      field: 'passwordPolicy',
      reason: 'minLength must be 6-128 and maxLength >= minLength, <= 1024',
    });
  }
  return policy;
}

/** 明文策略校验(改密/重置入口;密码变更动词必过) */
export function assertPasswordPolicy(password: string, policy: PasswordPolicy): void {
  if (typeof password !== 'string') {
    throw identityErrors.business('weak_password', { reason: 'password must be a string' });
  }
  if (password.length < policy.minLength) {
    throw identityErrors.business('weak_password', {
      reason: `must be at least ${policy.minLength} characters`,
    });
  }
  if (password.length > policy.maxLength) {
    throw identityErrors.business('weak_password', {
      reason: `must be at most ${policy.maxLength} characters`,
    });
  }
  const reason = policy.validate?.(password);
  if (reason != null) {
    throw identityErrors.business('weak_password', { reason });
  }
}

export async function hashPassword(plaintext: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(plaintext, salt, HASH_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  expected: Buffer;
}

function parseStored(stored: string | null | undefined): ParsedHash | null {
  if (!stored) return null;
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (
    !Number.isFinite(N) ||
    !Number.isFinite(r) ||
    !Number.isFinite(p) ||
    N < 1 ||
    r < 1 ||
    p < 1
  ) {
    return null;
  }
  // 逐位解构:上文已校验 length === 6,索引 4/5 为 saltHex/hashHex;null 判仅为类型收窄
  const [, , , , saltHex, hashHex] = parts;
  if (saltHex == null || hashHex == null) return null;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  if (salt.length === 0 || expected.length === 0 || expected.length > 1024) return null;
  return { N, r, p, salt, expected };
}

async function verifyAgainst(plaintext: string, parsed: ParsedHash): Promise<boolean> {
  try {
    const actual = await scrypt(plaintext, parsed.salt, parsed.expected.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: SCRYPT_MAXMEM,
    });
    return actual.length === parsed.expected.length && timingSafeEqual(actual, parsed.expected);
  } catch {
    return false;
  }
}

let dummyHashPromise: Promise<string> | null = null;
async function ensureDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('identity-constant-time-dummy');
  return dummyHashPromise;
}

/**
 * 校验明文 vs 存储哈希:
 *   - 格式非法/不存在 → 对哑哈希跑等量 scrypt 后返回 false(恒定时间)
 *   - keylen 跟随存储哈希长度(容忍不同 HASH_LEN 的历史哈希)
 */
export async function verifyPassword(
  plaintext: string,
  stored: string | null | undefined,
): Promise<boolean> {
  const parsed = parseStored(stored);
  if (parsed) {
    return verifyAgainst(plaintext, parsed);
  }
  const dummy = parseStored(await ensureDummyHash());
  if (dummy == null) {
    // 不可达:哑哈希由本模块 hashPassword 生成,格式必然可解析;fail-loud 防御
    throw new Error('constant-time dummy hash failed to parse');
  }
  await verifyAgainst(plaintext, dummy);
  return false;
}
