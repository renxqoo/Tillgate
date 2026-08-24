/**
 * 三性根类——错误体系单一真相（ADR-0001、DESIGN §3.1）：
 * 错误本质只有三种，是唯一有资格成为根类的区分：
 *   business        业务拒绝——预期内的"不允许"，唯一携带 category 的性质
 *   infrastructure  环境故障——依赖不可用/外部投递失败，可重试、要告警
 *   defect          缺陷——不变量破坏/不可达路径，不重试、细节不外泄（出站渲染通用文案归 face）
 */
// eslint-disable-next-line max-classes-per-file -- 三性根类继承族(基类+三子类)是错误体系单一真相(ADR-0001),同文件即设计单元;拆分制造人工接缝
import type { ErrorCategory } from './category';

export type ErrorNature = 'business' | 'infrastructure' | 'defect';

/** 上下文值域：递归只读 JSON（标量/数组/嵌套对象）——结构化校验事实可入（ADR-0001 D9a）；JSON 可序列化是硬边界（日志/出站安全） */
export type ErrorContextValue =
  | string
  | number
  | boolean
  | null
  | readonly ErrorContextValue[]
  | { readonly [key: string]: ErrorContextValue };

/** 结构化诊断上下文：键到只读 JSON 值；复杂数据仍应走日志侧字段（上下文进错误记录与出站渲染） */
export interface ErrorContext {
  readonly [key: string]: ErrorContextValue;
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
export abstract class TillgateError extends Error {
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
export class BusinessError extends TillgateError {
  override readonly nature = 'business' as const;
  readonly category: ErrorCategory;

  constructor(init: BusinessErrorInit, context?: ErrorContext, opts?: ErrorOptions) {
    super(init.message, { code: init.code, context }, opts);
    this.category = init.category;
  }
}

/** 环境故障：DB/Redis/上游/投递不可用；处理语义由 handlingOf 单点给出（可重试、告警） */
export class InfrastructureError extends TillgateError {
  override readonly nature = 'infrastructure' as const;

  // eslint-disable-next-line max-params -- 导出根类构造器四元组(message/code/context/opts)为全仓稳定契约,改 options 对象波及所有调用点
  constructor(message: string, code: string, context?: ErrorContext, opts?: ErrorOptions) {
    super(message, { code, context }, opts);
  }
}

/** 缺陷：不变量破坏/不可达路径/装配 bug；不重试、最高告警；细节只进日志（内外分际） */
export class DefectError extends TillgateError {
  override readonly nature = 'defect' as const;

  // eslint-disable-next-line max-params -- 同 InfrastructureError:导出根类构造器契约
  constructor(message: string, code: string, context?: ErrorContext, opts?: ErrorOptions) {
    super(message, { code, context }, opts);
  }
}

/** 注记存储键（符号、非枚举：不污染序列化,不可在外部伪造遍历） */
const annotationsKey = Symbol('tillgate.annotations');

/** 注记槽位的类型桥（符号索引无类型重叠,经 unknown 直取） */
function annotationsSlot(error: TillgateError): Readonly<Record<symbol, readonly ErrorContext[]>> {
  return error as unknown as Readonly<Record<symbol, readonly ErrorContext[]>>;
}

/**
 * 传播注记（ADR-0001 D9b）：错误上浮途中由外层补充观察性事实（requestId、channelId…）。
 * 实例稳定——不包装、不改判,instanceof 与三性分类全程不动;返回同一错误以便
 * `throw annotate(e, {...})` 直书。构造上下文为底,注记按时间序合并、后写胜出
 * （recordOf 消费,见 error-record.ts）。
 */
export function annotate<T extends TillgateError>(error: T, context: ErrorContext): T {
  const existing = annotationsSlot(error)[annotationsKey];
  Object.defineProperty(error, annotationsKey, {
    value: existing === undefined ? [context] : [...existing, context],
    enumerable: false,
    configurable: true, // 允许后续 annotate 重定义（追加语义）
  });
  return error;
}

/** 读取注记（recordOf 合并用；无注记返回空数组） */
export function annotationsOf(error: TillgateError): readonly ErrorContext[] {
  return annotationsSlot(error)[annotationsKey] ?? [];
}
