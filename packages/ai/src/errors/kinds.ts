/**
 * 错误归一单一真相（IMPLEMENTATION.md §3.2）：
 *   - ErrorKind 封闭词表——adapter 只翻译不发明，新增 kind 走 ADR；
 *   - 机制位（retryable/circuitTrip/deadCredential）由派生表单点派生，
 *     构造入口不收机制位参数——结构上杜绝「kind 与机制位自相矛盾」。
 */

/** 上游传输域错误语义分类（封闭词表；与仓库级 errors 根契约的映射见 ADR） */
export type ErrorKind =
  // ---- 传输类（http-client 生成，无厂商参与）----
  | 'network' // 连接/DNS/断流
  | 'timeout' // connect/首字节/中段静默
  // ---- 上游服务类（adapter 结构查表或 status 兜底）----
  | 'upstream_error' // 5xx / 内部错误
  | 'overloaded' // 上游过载（anthropic 529 等）
  | 'rate_limited' // 窗口限流（可自动恢复）
  | 'quota_exhausted' // 配额/余额永久耗尽（需充值）
  | 'invalid_api_key' // 凭据无效
  | 'insufficient_permissions' // 凭据有效但无权限
  | 'invalid_request' // 请求参数错误（调用方修请求）
  | 'invalid_response' // 200 但格式非法/超限
  | 'context_overflow' // 上下文超窗（可换大窗模型）
  | 'content_filtered' // 内容安全拦截
  | 'model_not_found' // 模型不存在/已下线
  // ---- 库策略类（生成时直接带 kind）----
  | 'empty_completion' // 200 无内容（独立重试预算）
  | 'canceled' // 调用方取消 / deadline
  | 'server_draining' // 本进程停机（非上游问题）
  | 'invalid_config' // ChannelDesc/CallOptions 必需字段缺失（调用方 bug）
  | 'unsupported_protocol' // 协议未注册（配置错误）
  | 'task_ops_unavailable'; // 任务型操作面向未注册协议调用

/** 机制位：由 kind 派生，禁止逐例声明 */
export interface ErrorMechanics {
  /** 是否值得同渠道重试（empty_completion 走独立预算，此处 false） */
  retryable: boolean;
  /** 是否计入渠道熔断（inference/health 订阅者的计数依据） */
  circuitTrip: boolean;
  /** 是否标记死凭据（连续达阈值停止路由） */
  deadCredential: boolean;
}

/** kind → 机制位派生表（单一真相；测试锁死与词表逐项一致） */
export const KIND_MECHANICS: Readonly<Record<ErrorKind, ErrorMechanics>> = {
  network: { retryable: true, circuitTrip: true, deadCredential: false },
  timeout: { retryable: true, circuitTrip: true, deadCredential: false },
  upstream_error: { retryable: true, circuitTrip: true, deadCredential: false },
  overloaded: { retryable: true, circuitTrip: true, deadCredential: false },
  rate_limited: { retryable: true, circuitTrip: false, deadCredential: false },
  quota_exhausted: { retryable: false, circuitTrip: false, deadCredential: false },
  invalid_api_key: { retryable: false, circuitTrip: false, deadCredential: true },
  insufficient_permissions: { retryable: false, circuitTrip: false, deadCredential: true },
  invalid_request: { retryable: false, circuitTrip: false, deadCredential: false },
  invalid_response: { retryable: false, circuitTrip: false, deadCredential: false },
  context_overflow: { retryable: false, circuitTrip: false, deadCredential: false },
  content_filtered: { retryable: false, circuitTrip: false, deadCredential: false },
  model_not_found: { retryable: false, circuitTrip: false, deadCredential: false },
  empty_completion: { retryable: false, circuitTrip: false, deadCredential: false },
  canceled: { retryable: false, circuitTrip: false, deadCredential: false },
  server_draining: { retryable: false, circuitTrip: false, deadCredential: false },
  invalid_config: { retryable: false, circuitTrip: false, deadCredential: false },
  unsupported_protocol: { retryable: false, circuitTrip: false, deadCredential: false },
  task_ops_unavailable: { retryable: false, circuitTrip: false, deadCredential: false },
};

/**
 * 统一错误构造（唯一入口）：机制位查表填入，调用方不可覆盖。
 * 厂商原始信息保真：vendorCode（排障对照）、status、detail（原文）、rawBody（审计源）。
 */
export class UpstreamError extends Error {
  readonly kind: ErrorKind;
  /** 厂商原始错误码（OpenAI code / anthropic type / gemini status / minimax base_resp…） */
  readonly vendorCode?: string;
  /** HTTP 状态码（网络/超时类为 undefined） */
  readonly status?: number;
  /** 重试提示（Retry-After 头或厂商字段解析，adapter 职责） */
  readonly retryAfterMs?: number;
  /** 可操作建议（进 C 端错误信封） */
  readonly suggestion?: string;
  /** 上游响应体原文（脱敏前；仅日志/审计） */
  readonly rawBody?: string;
  readonly retryable: boolean;
  readonly circuitTrip: boolean;
  readonly deadCredential: boolean;

  constructor(input: {
    kind: ErrorKind;
    message?: string;
    vendorCode?: string;
    status?: number;
    retryAfterMs?: number;
    suggestion?: string;
    rawBody?: string;
  }) {
    super(input.message ?? input.kind);
    this.name = 'UpstreamError';
    this.kind = input.kind;
    this.vendorCode = input.vendorCode;
    this.status = input.status;
    this.retryAfterMs = input.retryAfterMs;
    this.suggestion = input.suggestion;
    this.rawBody = input.rawBody;
    const m = KIND_MECHANICS[input.kind];
    this.retryable = m.retryable;
    this.circuitTrip = m.circuitTrip;
    this.deadCredential = m.deadCredential;
  }
}

export function isUpstreamError(e: unknown): e is UpstreamError {
  return e instanceof UpstreamError;
}

/** 机制位谓词（消费方读标志位的替代——语义化） */
export const isRetryable = (e: UpstreamError): boolean => e.retryable;
export const isDeadCredential = (e: UpstreamError): boolean => e.deadCredential;
