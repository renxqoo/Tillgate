/**
 * rating 域契约类型：计量收据（UsageReceipt）与授权报价（BillingQuote）——
 * 计费链路的「价格/用量」单一真相，自 billing/types.ts 上移（S2）。
 * gateway 生产、worker 消费、rating 校验与计价共用。
 * 价格/系数用元 + 小数（无整数编码），金额全程 Decimal 账本永不 round。
 */
export interface UsageReceipt {
  /** 幂等键（= billing_requests.request_id = usage_logs.request_id 唯一约束） */
  requestId: string;
  userId: number;
  apiKeyId: number | null;
  appId: number | null;
  /** key / jwt */
  credentialType: string;
  /** 对外模型名（用户请求的） */
  externalModel: string;
  /** 实际模型名（上游真实模型，可能经 fallback 切换） */
  realModel: string;
  /** 最终成功的渠道 ID（候选循环选中的） */
  channelId: number | null;
  /** 最终成功的渠道名（链路 channel.final 与渠道拓扑同源命名） */
  channelKey: string;
  /** usage（ai 包归一化后的 token 数 + 单位计量） */
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    estimated: boolean;
    /** 单位计量（按次/张/秒/字符；token 模型为 0）——与 unitPrice 快照配对结算 */
    units?: number;
  };
  /** 价格快照（元/百万 token，来自实际成功模型 model_mappings numeric 列） */
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  /** 单位单价快照（元/单位；token 模型为 '0'） */
  unitPrice?: string;
  /** 费率卡系数（小数，如 1.0） */
  coefficient: string;
  /** 请求耗时 ms */
  durationMs: number;
  /** 是否流式 */
  stream: boolean;
  /** 流式是否中断（terminated） */
  streamAborted: boolean;
  /** 模型映射 ID（模型级 TPM 回填维度用，= 实际成功模型） */
  mappingId: number;
  /** 必须与授权候选的多模态策略快照一致；纯文本为 null。 */
  billingPolicyFingerprint: string | null;
  /**
   * 估算结算归属（2026-08-17 政策拍板）：用户侧取消 ∪ 完成缺 usage。
   * usage.estimated=true 时必填且必须属于 ESTIMATE_ATTRIBUTIONS（validateReceipt
   * 结构化把关：无归属的估算 receipt 一律拒绝）。政策动机：厂商均无 usage
   * 补录接口，人工复核期望价值≈0 → 完成态缺 usage 从「冻结 uncertain」改为
   * 「按已交付估算结算」；上游服务端异常（超时/5xx/截断）维持释放不扣。
   */
  estimatedFor?: EstimateAttribution;
  /** 触发估算的透传字节数（校准作业与审计的数据源；TTFB 期取消为 0） */
  bytesRelayed?: number;
}

/** 用户侧取消原因（gateway 路由判定与 ledger 校验共用子集） */
export const USER_SIDE_CANCELS = ['client_disconnect', 'request_cancelled', 'aborted'] as const;
export type UserSideCancel = (typeof USER_SIDE_CANCELS)[number];

/**
 * 允许估算结算的全部归属（2026-08-17 政策，单一真相）：
 *   用户取消三态 + 完成态缺 usage 两态（流式按 bytesRelayed×tokensPerByte、
 *   非流式按响应体内容估算）。上游故障中断不在此列——那类走释放不扣。
 */
export const ESTIMATE_ATTRIBUTIONS = [
  ...USER_SIDE_CANCELS,
  'usage_missing_completed',
  'usage_missing_nonstream',
] as const;
export type EstimateAttribution = (typeof ESTIMATE_ATTRIBUTIONS)[number];

/**
 * G1 不变量（2026-08-17 修订）：估算 usage 只允许归属「用户取消 ∪ 完成缺 usage」。
 * validateReceipt 与 settle 共用本判定——无归属/归属不明的估算 receipt 一律拒绝，
 * 不允许借估算口径给其他场景开后门。
 */
export function isAttributedEstimate(receipt: UsageReceipt): boolean {
  return (
    receipt.usage.estimated &&
    receipt.estimatedFor !== undefined &&
    (ESTIMATE_ATTRIBUTIONS as readonly string[]).includes(receipt.estimatedFor)
  );
}

export interface BillingQuoteCandidate {
  mappingId: number;
  externalModel: string;
  realModel: string;
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  /** 单位单价（元/单位；token 模型为 '0'）——预扣与结算共用 */
  unitPrice?: string;
  coefficient: string;
  /** 本候选请求输入 token 的可证明上界（文本字节或模型多模态硬上限）。 */
  inputTokenUpperBound: number;
  /** 单位计量上界（如 images 的 n；token 模型为 0）。 */
  unitUpperBound?: number;
  /** 多模态策略快照指纹；纯文本为 null。 */
  billingPolicyFingerprint: string | null;
}

/** 已按供应商参数规则归一化后的可信报价输入。 */
export interface BillingQuote {
  /** 已包含 n 等倍数后的最大输出 token 总量。 */
  maxOutputTokens: number;
  candidates: BillingQuoteCandidate[];
  /** 只有显式免费策略才能产生 0 元授权。 */
  explicitlyFree?: boolean;
}
