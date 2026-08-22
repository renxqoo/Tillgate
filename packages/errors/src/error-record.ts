/**
 * 错误即数据（DESIGN §2）：跨层传播、face 渲染与日志摄取共用的规范化记录形状。
 * 记录不判责、不含协议信息（零 status）——出站如何表达归 face（v1 E5「未映射错误甩锅
 * 调用方」的结构修复：记录只陈述事实）。
 */
import { CATEGORY_DEFAULTS, type ErrorCategory } from './category';
import {
  annotationsOf,
  BusinessError,
  InfrastructureError,
  TokenlensError,
  type ErrorContext,
} from './nature';

/**
 * 根命名空间保留码（ADR-0001 D6；单一真相——消费者与测试引用此处，不得另写裸字符串）。
 * 命名空间 `errors` 为本包保留，能力包目录不得使用。
 */
export const ROOT_ERROR_CODES = Object.freeze({
  /** 边界处未知 Error：按缺陷处理，原始 name 进 context、message 进日志 */
  unhandled: 'errors.unhandled',
  /** 抛出的非 Error 值（字符串/对象等）：按缺陷处理 */
  nonError: 'errors.non_error',
  /** 目录查找未命中（调用方 bug，编译期类型之外的运行时防呆） */
  catalogKeyMissing: 'errors.catalog_key_missing',
  /** 目录命名空间/key 形状非法或定义缺文案（装配期防呆） */
  catalogKeyInvalid: 'errors.catalog_key_invalid',
  /** face 装配时命名空间重复 */
  duplicateNamespace: 'errors.duplicate_namespace',
});

/** cause 链规范化深度上限（防御病态长链；v1 实证 drizzle 包装后链深 ≤ 3） */
export const MAX_CAUSE_DEPTH = 10;

interface RecordBase {
  readonly code: string;
  readonly message: string;
  readonly context?: ErrorContext;
  readonly retryAfterMs?: number;
  readonly cause?: ErrorRecord;
}

export interface BusinessRecord extends RecordBase {
  readonly nature: 'business';
  /** business 记录必带 category（判别联合，处理侧无隐式回退） */
  readonly category: ErrorCategory;
}

export interface InfrastructureRecord extends RecordBase {
  readonly nature: 'infrastructure';
}

export interface DefectRecord extends RecordBase {
  readonly nature: 'defect';
}

/** 规范化错误记录（判别联合：nature 收窄后 business 分支的 category 必在） */
export type ErrorRecord = BusinessRecord | InfrastructureRecord | DefectRecord;

/** 处理语义（单点派生的输出） */
export interface ErrorHandling {
  readonly retryable: boolean;
  readonly alert: boolean;
}

/**
 * 处理语义单点派生（DESIGN §3.4）：
 * business 查 category 默认；环境故障可重试且告警；缺陷不重试且响铃。
 * 不提供逐例覆盖（ADR-0001 D5）。
 */
export function handlingOf(record: ErrorRecord): ErrorHandling {
  switch (record.nature) {
    case 'business':
      return CATEGORY_DEFAULTS[record.category];
    case 'infrastructure':
      return { retryable: true, alert: true };
    case 'defect':
      return { retryable: false, alert: true };
  }
}

/** 根契约错误 → 记录（含 cause 链规范化） */
export function recordOf(error: TokenlensError): ErrorRecord {
  return fromTokenlens(error, 0);
}

/** 任意未知值 → 记录（normalizeError 的实现基础；外来值一律按缺陷） */
export function recordOfUnknown(value: unknown): ErrorRecord {
  return fromUnknown(value, 0);
}

function fromTokenlens(error: TokenlensError, depth: number): ErrorRecord {
  const base = {
    code: error.code,
    message: error.message,
    context: mergedContextOf(error),
    retryAfterMs: error.retryAfterMs,
    cause: causeOf(error.cause, depth),
  };
  if (error instanceof BusinessError) {
    return { nature: 'business', category: error.category, ...base };
  }
  if (error instanceof InfrastructureError) {
    return { nature: 'infrastructure', ...base };
  }
  return { nature: 'defect', ...base };
}

/**
 * 记录上下文 = 构造上下文为底 + 注记按时间序合并（后写胜出，ADR-0001 D9b）。
 * 无构造上下文且无注记时保持 undefined（记录干净）。
 */
function mergedContextOf(error: TokenlensError): ErrorContext | undefined {
  const annotations = annotationsOf(error);
  if (error.context === undefined && annotations.length === 0) return undefined;
  return Object.assign({}, error.context, ...annotations) as ErrorContext;
}

function fromUnknown(value: unknown, depth: number): ErrorRecord {
  if (value instanceof TokenlensError) return fromTokenlens(value, depth);
  if (value instanceof Error) {
    return {
      nature: 'defect',
      code: ROOT_ERROR_CODES.unhandled,
      message:
        value.message === '' ? (value.name === '' ? 'unknown error' : value.name) : value.message,
      context: { name: value.name },
      cause: causeOf(value.cause, depth),
    };
  }
  return { nature: 'defect', code: ROOT_ERROR_CODES.nonError, message: safeText(value) };
}

function causeOf(cause: unknown, depth: number): ErrorRecord | undefined {
  if (cause === undefined || depth >= MAX_CAUSE_DEPTH) return undefined;
  return fromUnknown(cause, depth + 1);
}

/** 非错误值的字符串化兜底（toString 抛错的病态对象也不得让归一自身失败） */
function safeText(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '[unstringifiable]';
  }
}
