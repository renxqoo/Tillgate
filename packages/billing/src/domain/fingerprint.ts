/**
 * Canonical JSON 指纹（幂等安全的地基，DESIGN §2.3；ADR-0003 决策 3——三套实现收敛为
 * 旧仓 ledger-core 严格版语义）。普通 JSON.stringify 做指纹的坑（B4）：
 *   1. 键序不稳定：{a:1,b:2} 与 {b:2,a:1} 序列化不同 → 重放被误判冲突
 *   2. 静默吞值：undefined/NaN 变 null → 不同输入同指纹 → 顶替重放
 *   3. 深层嵌套爆栈：攻击面输入可构造万层嵌套炸调用栈
 * 本模块：键序按码点递归排序（.toSorted() 默认比较，与 locale/ICU 无关）、
 * 非 JSON 安全值一律显式拒绝（DefectError——载荷构造缺陷，细节只进日志）、
 * 深度与总长双上限。外部可控长度（memo 等）必须在进入指纹前由校验层先行截断。
 */
import { createHash } from 'node:crypto';
import { DefectError } from '@tillgate/errors';
import { BillingErrors } from './errors.js';

/** canonical 序列化最大长度（1MB）——超限拒绝（防指纹输入洪水） */
const MAX_CANONICAL_LENGTH = 1_048_576;
/** 最大嵌套深度（爆栈防护） */
const MAX_DEPTH = 64;

function defect(detail: string, context?: Record<string, string | number>): DefectError {
  return new DefectError(detail, 'billing.fingerprint_input', context);
}

// eslint-disable-next-line max-lines-per-function -- 指纹序列化器:递归单真相实现,状态经 seen/emit 闭包线程化
export function canonicalJson(value: unknown): string {
  const chunks: string[] = [];
  let length = 0;
  write(value, 0, new WeakSet<object>());
  return chunks.join('');

  // eslint-disable-next-line complexity, max-lines-per-function, max-statements -- 指纹序列化器:递归单真相实现,状态经 seen/emit 闭包线程化
  function write(input: unknown, depth: number, seen: WeakSet<object>): void {
    if (depth > MAX_DEPTH) {
      throw defect(`nesting depth exceeds ${MAX_DEPTH}`);
    }
    if (input === null) {
      return emit('null');
    }
    switch (typeof input) {
      case 'string': {
        return emit(JSON.stringify(input));
      }
      case 'boolean': {
        return emit(input ? 'true' : 'false');
      }
      case 'number': {
        if (!Number.isFinite(input)) {
          throw defect('NaN/Infinity are not fingerprintable (normalize to strings)');
        }
        return emit(Object.is(input, -0) ? '0' : String(input));
      }
      case 'undefined': {
        throw defect(
          'undefined is not fingerprintable (JSON.stringify would silently null it — a replay-collision hazard)',
        );
      }
      case 'bigint': {
        throw defect('bigint is not fingerprintable (convert to string first)');
      }
      case 'symbol':
      case 'function': {
        throw defect(`${typeof input} is not fingerprintable`);
      }
      case 'object': {
        if (seen.has(input as object)) {
          throw defect('circular reference');
        }
        if (input instanceof Date) {
          throw defect('Date is not fingerprintable (use date.toISOString())');
        }
        seen.add(input as object);
        try {
          if (Array.isArray(input)) {
            emit('[');
            for (let i = 0; i < input.length; i += 1) {
              // eslint-disable-next-line max-depth -- 递归序列化的分型分发:try/数组/对象天然多级,提取会线程化闭包状态
              if (i > 0) emit(',');
              write(input[i], depth + 1, seen);
            }
            emit(']');
            return;
          }
          const proto = Object.getPrototypeOf(input);
          if (proto !== Object.prototype && proto !== null) {
            throw defect(
              `class instances (${input.constructor?.name ?? 'Object'}) are not fingerprintable (use plain JSON data)`,
            );
          }
          const keys = Object.keys(input as Record<string, unknown>).toSorted();
          emit('{');
          for (let i = 0; i < keys.length; i += 1) {
            const key = keys[i];
            // Object.keys 产出必非空;指纹序列化遇缺失即缺陷,fail-loud 不静默跳过
            if (key === undefined) throw new Error('fingerprint: object key missing');
            if (i > 0) emit(',');
            emit(JSON.stringify(key));
            emit(':');
            write((input as Record<string, unknown>)[key], depth + 1, seen);
          }
          emit('}');
        } finally {
          seen.delete(input as object);
        }
        return;
      }
      default: {
        throw defect(`unsupported value type '${typeof input}'`);
      }
    }
  }

  function emit(chunk: string): void {
    length += chunk.length;
    if (length > MAX_CANONICAL_LENGTH) {
      throw defect(`canonical serialization exceeds ${MAX_CANONICAL_LENGTH} bytes`);
    }
    chunks.push(chunk);
  }
}

/** canonical SHA-256 指纹（hex）——同业务参数恒同值，键序无关 */
export function fingerprintOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** 指纹载荷：递归只读 JSON 数据（金额以规范化字符串携带——'1.00'≠'1.0'，调用方先 normalizeAmount） */
export type FingerprintValue =
  | null
  | boolean
  | number
  | string
  | readonly FingerprintValue[]
  | { readonly [key: string]: FingerprintValue };

/**
 * 命令指纹（幂等身份）：等价的规范化命令产生相同摘要；kind 是幂等域隔离轴。
 * 严格语义（B4 修复）：payload 含 undefined/NaN 等非 JSON 安全值时显式拒绝，
 * 不再像旧宽松版那样静默丢弃——静默吞值是重放顶替温床。
 */
export function commandFingerprint(
  kind: string,
  payload: Readonly<Record<string, FingerprintValue>>,
): string {
  if ('kind' in payload) {
    // 展开序会使 payload.kind 覆盖域隔离轴——同参数不同 kind 将产生同指纹
    throw defect("payload key 'kind' is reserved for the idempotency domain axis");
  }
  return fingerprintOf({ kind, ...payload });
}

/**
 * 重放指纹比对：存储指纹与当前命令指纹不一致 = 同幂等键不同命令 → 409 拒绝，
 * 绝不静默复用首笔结果。stored 为 null 仅兼容引入指纹前的历史行（直接放行）。
 */
export function assertCommandFingerprint(
  stored: string | null,
  expected: string,
  ref: { refType: string; refId: string; kind: string },
): void {
  if (stored !== null && stored !== expected) {
    throw BillingErrors.business('idempotency_conflict', { ...ref });
  }
}
