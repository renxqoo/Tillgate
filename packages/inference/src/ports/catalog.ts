import type { ChannelCandidate, ModelMappingSnapshot } from '../domain/model/types';

/**
 * 目录 port（control-plane 只读快照的消费方定义；装配注入实现——生产实现由
 * apps/gateway 的 catalog-port 桥提供：control-plane 目录读 + billing 纯函数组装
 * 用户价快照）。
 * 目录侧负责启用状态过滤（status=0）与渠道连接信息装配；排序调度归 inference。
 */

/**
 * 报价解析上下文：快照中的 coefficient / unitPrice / unitUpperBound 是
 * 「请求时点已解析」值——
 *   coefficient = 用户费率卡系数（用户价 = 官方价 × 系数；无卡 = 缺省系数）；
 *   unitPrice / unitUpperBound = 按请求体推导的变体单价与单位上界（n/秒/字符）
 *   叠加映射级预扣保底。因此目录查询必须携带用户、请求体与准入时刻三个维度。
 *   now = 请求准入时刻（schedule 分时段选价锚点——fallback 重查复用同一值，
 *   不随查询时刻抖动；时区属装配面环境，不进请求上下文）。
 */
export interface CatalogPricingContext {
  userId: number;
  /** 原始请求体（计量描述符与变体定价选择器的取值源；只读） */
  body: Readonly<Record<string, unknown>>;
  /** 请求准入时刻（报价前捕获一次） */
  now: Date;
}

export interface CatalogPort {
  /** 按对外模型名查映射快照（含用户价/请求时点报价解析）；无/下线返回 null */
  findMapping(
    externalModel: string,
    pricing: CatalogPricingContext,
  ): Promise<ModelMappingSnapshot | null>;
  /** 给真实模型名解析候选渠道（顺序任意——加权调度在 inference；空 = 无渠道） */
  resolveChannels(realModel: string): Promise<ChannelCandidate[]>;
}
