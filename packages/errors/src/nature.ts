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

/** 业务身份码品牌（模块私有符号，不可在包外构造） */
declare const businessCodeBrand: unique symbol;

/**
 * 业务身份码：唯一签发源是错误目录（defineErrorCatalog 的 code()/entry()/business()）。
 * 品牌类型在编译期封死自由字符串与手误码（v1 E2 类缺陷的结构修复，ADR-0001 D8）；
 * `as BusinessCode` 强转属刻意违规，由全仓守卫扫描兜底。
 */
export type BusinessCode = string & { readonly [businessCodeBrand]: true };

/**
 * 业务错误构造所需的绑定定义（结构形状；实例由目录 entry()/business() 签发）。
 * code + category + message 只能作为三元组整体流动——message 与 category 在构造点
 * 无法偏离定义（E8「定制文案杀死本地化」/E9「message 即 code」的编译期封死）。
 */
export interface BusinessErrorInit {
  readonly code: BusinessCode;
  readonly category: ErrorCategory;
  readonly message: string;
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

  constructor(init: BusinessErrorInit, context?: ErrorContext, opts?: ErrorOptions) {
    super(init.message, { code: init.code, context }, opts);
    this.category = init.category;
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
