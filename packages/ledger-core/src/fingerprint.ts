/**
 * Canonical JSON 指纹（幂等安全的地基）：
 *
 * 普通 JSON.stringify 做指纹有三个 P0 级坑——
 *   1. 键序不稳定：{a:1,b:2} 与 {b:2,a:1} 序列化不同 → 同一业务参数两副指纹 → 重放被误判冲突
 *   2. 静默吞值：undefined 变 null、[undefined] 变 [null]、Symbol 键消失 → 不同输入同指纹 → 顶替重放
 *   3. 深层嵌套爆栈：攻击面输入可构造万层嵌套炸调用栈
 * 本模块：键序递归排序、非 JSON 安全值一律显式拒绝、深度与总长双上限。
 */
import { createHash } from 'node:crypto';
import { InvalidInputError } from './errors.js';

/** canonical 序列化最大长度（1MB）——超限拒绝（防指纹输入洪水） */
const MAX_CANONICAL_LENGTH = 1_048_576;
/** 最大嵌套深度（爆栈防护） */
const MAX_DEPTH = 64;

export function canonicalJson(value: unknown): string {
  const chunks: string[] = [];
  let length = 0;
  write(value, 0, new WeakSet<object>());
  return chunks.join('');

  function write(input: unknown, depth: number, seen: WeakSet<object>): void {
    if (chunks.length > 0 && length > MAX_CANONICAL_LENGTH) {
      throw new InvalidInputError('fingerprint', `canonical serialization exceeds ${MAX_CANONICAL_LENGTH} bytes`);
    }
    if (depth > MAX_DEPTH) {
      throw new InvalidInputError('fingerprint', `nesting depth exceeds ${MAX_DEPTH}`);
    }
    if (input === null) {
      return emit('null');
    }
    switch (typeof input) {
      case 'string':
        return emit(JSON.stringify(input));
      case 'boolean':
        return emit(input ? 'true' : 'false');
      case 'number': {
        if (!Number.isFinite(input)) {
          throw new InvalidInputError('fingerprint', 'NaN/Infinity are not fingerprintable (normalize to strings)');
        }
        return emit(Object.is(input, -0) ? '0' : String(input));
      }
      case 'undefined':
        throw new InvalidInputError(
          'fingerprint',
          'undefined is not fingerprintable (JSON.stringify would silently null it — a replay-collision hazard)',
        );
      case 'bigint':
        throw new InvalidInputError('fingerprint', 'bigint is not fingerprintable (convert to string first)');
      case 'symbol':
      case 'function':
        throw new InvalidInputError('fingerprint', `${typeof input} is not fingerprintable`);
      case 'object': {
        if (seen.has(input as object)) {
          throw new InvalidInputError('fingerprint', 'circular reference');
        }
        if (input instanceof Date) {
          throw new InvalidInputError('fingerprint', 'Date is not fingerprintable (use date.toISOString())');
        }
        seen.add(input as object);
        try {
          if (Array.isArray(input)) {
            emit('[');
            for (let i = 0; i < input.length; i += 1) {
              if (i > 0) emit(',');
              write(input[i], depth + 1, seen);
            }
            emit(']');
            return;
          }
          const proto = Object.getPrototypeOf(input);
          if (proto !== Object.prototype && proto !== null) {
            throw new InvalidInputError(
              'fingerprint',
              `class instances (${input.constructor?.name ?? 'Object'}) are not fingerprintable (use plain JSON data)`,
            );
          }
          const keys = Object.keys(input as Record<string, unknown>).toSorted();
          emit('{');
          for (let i = 0; i < keys.length; i += 1) {
            if (i > 0) emit(',');
            emit(JSON.stringify(keys[i]!));
            emit(':');
            write((input as Record<string, unknown>)[keys[i]!], depth + 1, seen);
          }
          emit('}');
        } finally {
          seen.delete(input as object);
        }
        return;
      }
      default:
        throw new InvalidInputError('fingerprint', `unsupported value type '${typeof input}'`);
    }
  }

  function emit(chunk: string): void {
    length += chunk.length;
    if (length > MAX_CANONICAL_LENGTH) {
      throw new InvalidInputError('fingerprint', `canonical serialization exceeds ${MAX_CANONICAL_LENGTH} bytes`);
    }
    chunks.push(chunk);
  }
}

/** canonical SHA-256 指纹（hex）——同业务参数恒同值，键序无关 */
export function fingerprintOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
