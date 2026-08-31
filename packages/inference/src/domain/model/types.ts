/**
 * 目录契约类型（CatalogPort 的数据形态——control-plane 只读快照）。
 * 价格一律字符串（numeric 38,18 语义，运算归 billing；inference 只快照透传）。
 */

/** 计价单位词表（measurement 注册表的键，单一真相对齐 control-plane 目录） */
export type PricingUnit = 'token' | 'request' | 'image' | 'second' | 'char';

/** 模型映射快照（externalName → 真实模型 + 价格 + fallback 链） */
export interface ModelMappingSnapshot {
  mappingId: number;
  externalModel: string;
  realModel: string;
  /** 兜底模型（对外名，一级展开；每个兜底自身的 fallback 不再递归） */
  fallbackModels: readonly string[];
  inputPrice: string;
  cacheInputPrice: string;
  cacheWritePrice: string | null;
  outputPrice: string;
  unitPrice: string | null;
  pricingUnit: PricingUnit;
  /** 敞口估算用的单位上界（按次/张/秒计费模型；token 模型为 0） */
  unitUpperBound: number;
  coefficient: string;
  /** 计费策略指纹（收据快照字段，billing 结算幂等校验用） */
  billingPolicyFingerprint: string | null;
  /**
   * 命中时段标签（schedule 策略窗口的 label，缺省 "start-end"）——收据审计列：
   * 这笔账为什么是这个价一查便知；缺省 = 无时段策略/未命中窗口。
   */
  pricingWindow?: string;
  /** 模型维限流（目录实现方携带；admitModel 钩子消费，缺省不限） */
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  /**
   * 模型上下文窗口（token 总量；目录实现方携带，缺省不限）。用于把输出
   * 预留上界钳到「窗口 − 输入上界」——全额预扣模式下避免按缺省输出上限
   * 过度预留挤占用户可用敞口（小窗口模型尤其显著）。
   */
  contextLength?: number | null;
}

/** 报价候选（主模型 + 兜底展开后的有序链；价格快照来自各自映射） */
export interface QuoteCandidate {
  mappingId: number;
  externalModel: string;
  realModel: string;
  inputPrice: string;
  cacheInputPrice: string;
  cacheWritePrice: string | null;
  outputPrice: string;
  unitPrice: string | null;
  pricingUnit: PricingUnit;
  unitUpperBound: number;
  coefficient: string;
  billingPolicyFingerprint: string | null;
  /** 模型维限流（候选级准入维度；见 ModelMappingSnapshot.rpmLimit） */
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  /** 模型上下文窗口透传（见 ModelMappingSnapshot.contextLength） */
  contextLength?: number | null;
  /** 命中时段标签透传（收据审计列；见 ModelMappingSnapshot.pricingWindow） */
  pricingWindow?: string;
}

/** 渠道候选（目录返回的启用渠道；顺序由 inference 加权调度决定） */
export interface ChannelCandidate {
  channelId: number;
  channelName: string;
  providerName: string | null;
  /** ai 适配器注册表键（SUPPORTED_PROTOCOLS 词表） */
  protocol: string;
  /** 厂商档案键（可选，参数怪癖预设） */
  vendor: string | null;
  /** baseUrlOverride 已解析后的最终上游基址 */
  baseUrl: string;
  /** 加密凭据（适配器内经注入的 decrypt 解密，不落盘不明文外泄） */
  apiKeyEnc: string;
  /** 该渠道的出站模型名（model_channels.upstream_model——出站请求体用它） */
  upstreamModel: string;
  priority: number;
  weight: number;
  /**
   * 渠道维限流/预算列（可选——目录实现方携带；网关
   * admitChannel 钩子消费，缺省不限）。upstreamBudget 为渠道进货额度快照（元）。
   */
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  upstreamBudget?: string;
  /** 可用余额快照（budget - reserved；软水位降权信号——非准入硬闸，硬闸在 reserveChannel） */
  upstreamRemaining?: string | null;
  /** 累计正向充值（软水位基数——adjust 纠偏不入；缺省 = 无充值记录回退 budget 口径） */
  upstreamFunded?: string;
  /**
   * 渠道成本五轴（双轨定价）：free 标记物化全 0；绑定轴任一配置即物化（缺轴 0）；
   * **undefined = 成本面缺失（全 NULL 未标 free）→ 预留/结算/评分按零成本**
   * （docs/channel-cost-pricing.md）。静默回落用户卖价会按卖价虚扣虚拒免费/低价渠道。
   */
  costPrices?: {
    inputPrice: string;
    cacheInputPrice: string;
    cacheWritePrice: string;
    outputPrice: string;
    unitPrice: string;
  };
}

/** 请求凭证事实（鉴权结论由 app 中间件产出，inference 只消费） */
export interface RequestAuth {
  userId: number;
  apiKeyId: number | null;
  /** App-JWT 凭证（null = 静态 Key）——收据归属与订阅结算维度 */
  appId: number | null;
  /** 凭证模型白名单（App-JWT scope.models；null = 不限） */
  allowedModels: readonly string[] | null;
}
