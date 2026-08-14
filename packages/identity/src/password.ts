import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * 本地账号密码哈希（requirements 4.1：本地账号兜底，管理员开通）。
 *
 * 选型：Node 内置 scrypt（无需 bcrypt 依赖，跨平台一致）。
 *   - N（CPU/内存代价）、r（内存参数）、p（并行）取 2^15 / 8 / 1，约 50ms/次（登录场景可接受）
 *   - salt 16 字节随机；输出格式：scrypt:N:r:p:<saltHex>:<hashHex>
 *
 * 时序安全：verify 用 timingSafeEqual 常量时间比较，防时序攻击。
 *
 * 纯函数 + 可注入：算法本身无 I/O 依赖（除 scrypt 异步回调），易于单测。
 *
 * 注意：users.password_hash 与 admins.password_hash 共用同一格式，
 *       迁移管理员时 password_hash 原样搬迁即可继续校验。
 */

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** 默认 scrypt 参数（2^15 ≈ 50ms，登录场景安全且可接受） */
export const SCRYPT_N = 1 << 15;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
/** 输出哈希长度（字节） */
export const HASH_LEN = 32;
/** scrypt maxmem：N=2^15 下 512MB 足够 */
const SCRYPT_MAXMEM = 512 * 1024 * 1024;

/**
 * 哈希明文密码，返回自描述格式 scrypt:N:r:p:<saltHex>:<hashHex>。
 * 该格式与 verify 解耦：未来引入 argon2/bcrypt 时按前缀分发即可。
 */
export async function hashPassword(plaintext: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(plaintext, salt, HASH_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  expected: Buffer;
}

/** 解析自描述哈希格式 scrypt:N:r:p:<saltHex>:<hashHex>；非法/不支持 → null */
function parseStored(stored: string | null | undefined): ParsedHash | null {
  if (!stored) return null;
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || N < 1 || r < 1 || p < 1) {
    return null;
  }
  const salt = Buffer.from(parts[4]!, 'hex');
  const expected = Buffer.from(parts[5]!, 'hex');
  if (expected.length !== HASH_LEN) return null;
  return { N, r, p, salt, expected };
}

/** 对给定哈希参数跑一次 scrypt + 常量时间比较（不抛错，异常按 false 处理） */
async function verifyAgainst(plaintext: string, parsed: ParsedHash): Promise<boolean> {
  try {
    const actual = await scrypt(plaintext, parsed.salt, HASH_LEN, {
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

/**
 * 固定的「哑哈希」：用户不存在 / 哈希非法时也跑一次等参数 scrypt，
 * 使「用户不存在」与「密码错误」的响应耗时一致，杜绝时序侧信道枚举（01 修复）。
 * 懒生成一次并缓存（scrypt 参数与真实哈希一致）。
 */
let dummyHashPromise: Promise<string> | null = null;
async function ensureDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('ai-gateway-constant-time-dummy');
  return dummyHashPromise;
}

/**
 * 校验明文 vs 已存储哈希。
 *   - 格式非法/不存在 → 仍执行一次等量 scrypt（对哑哈希），恒定时间返回 false
 *   - 常量时间比较防时序攻击
 */
export async function verifyPassword(
  plaintext: string,
  stored: string | null | undefined,
): Promise<boolean> {
  const parsed = parseStored(stored);
  if (parsed) {
    return verifyAgainst(plaintext, parsed);
  }
  // 用户不存在或哈希非法：对哑哈希执行一次 scrypt，保证与「密码错」同耗时后返回 false。
  const dummy = parseStored(await ensureDummyHash())!;
  await verifyAgainst(plaintext, dummy);
  return false;
}
