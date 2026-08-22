import type { ChannelCandidate, ModelMappingSnapshot } from '../domain/model/types';

/**
 * 目录 port（control-plane 只读快照的消费方定义；目标态经能力 facade 直连，
 * billing/control-plane 建包前由装配注入实现——重构方案 §5.2）。
 * 目录侧负责启用状态过滤（status=0）与渠道连接信息装配；排序调度归 inference。
 */
export interface CatalogPort {
  /** 按对外模型名查映射快照；无/下线返回 null */
  findMapping(externalModel: string): Promise<ModelMappingSnapshot | null>;
  /** 给真实模型名解析候选渠道（顺序任意——加权调度在 inference；空 = 无渠道） */
  resolveChannels(realModel: string): Promise<ChannelCandidate[]>;
}
