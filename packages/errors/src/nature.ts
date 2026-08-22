/**
 * 三性根类——错误体系单一真相（ADR-0001、DESIGN §3.1）：
 * 错误本质只有三种，是唯一有资格成为根类的区分：
 *   business        业务拒绝——预期内的"不允许"，唯一携带 category 的性质
 *   infrastructure  环境故障——依赖不可用/外部投递失败，可重试、要告警
 *   defect          缺陷——不变量破坏/不可达路径，不重试、细节不外泄（出站渲染通用文案归 face）
 */
import type { ErrorCategory } from './category';

export type ErrorNature = 'business' | 'infrastructure' | 'defect';

/** 结构化诊断上下文：仅 JSON 标量（日志/出站安全）；复杂数据走日志侧字段，不进上下文 */
export interface ErrorContext {
  readonly [key: string]: string | number | boolean | null;
}

/** 根类构造可选项 */
export interface ErrorOptions {
  /** 原始错误：链式传播用 cause，禁止重新包装改判（谁检测谁分类，DESIGN §3.1） */
  cause?: unknown;
  /** 重试提示毫秒数（Retry-After/冷却换算；响应头渲染归 face） */
  retryAfterMs?: number;
}

/**
 * 全部根契约错误的公共基类：nature 判别 + 身份码 + 上下文。
 * name 取 new.target.name——子类名即错误名，不随重构搬层漂移（v1 E12 的结构修复）。
 */
export abstract class TokenlensError extends Error {
  abstract readonly nature: ErrorNature;

  /** 命名空间身份码（`namespace.key`，如 billing.insufficient_cash；规范见 DESIGN §3.3） */
  readonly code: string;
  readonly context?: ErrorContext;
  readonly retryAfterMs?: number;

  protected constructor(
    message: string,
    identity: { code: string; context?: ErrorContext },
    opts?: ErrorOptions,
  ) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = new.target.name;
    this.code = identity.code;
    this.context = identity.context;
    this.retryAfterMs = opts?.retryAfterMs;
  }
}

/** 业务拒绝：预期内的"不允许"；处理契约在 category（闭集唯一分派轴） */
export class BusinessError extends TokenlensError {
  override readonly nature = 'business' as const;
  readonly category: ErrorCategory;

  constructor(
    message: string,
    code: string,
    category: ErrorCategory,
    context?: ErrorContext,
    opts?: ErrorOptions,
  ) {
    super(message, { code, context }, opts);
    this.category = category;
  }
}

/** 环境故障：DB/Redis/上游/投递不可用；处理语义由 handlingOf 单点给出（可重试、告警） */
export class InfrastructureError extends TokenlensError {
  override readonly nature = 'infrastructure' as const;

  constructor(message: string, code: string, context?: ErrorContext, opts?: ErrorOptions) {
    super(message, { code, context }, opts);
  }
}

/** 缺陷：不变量破坏/不可达路径/装配 bug；不重试、最高告警；细节只进日志（内外分际） */
export class DefectError extends TokenlensError {
  override readonly nature = 'defect' as const;

  constructor(message: string, code: string, context?: ErrorContext, opts?: ErrorOptions) {
    super(message, { code, context }, opts);
  }
}
