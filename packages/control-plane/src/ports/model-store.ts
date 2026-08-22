/**
 * ModelStore port：模型映射（对外名→真实模型）与渠道绑定的持久化边界。
 * 报价候选链解析（findActiveBy*）与在架目录读（listEnabledModels）是网关热路径——
 * 不在此（inference 波次 G1）；本 port 只覆盖管理面 CRUD/绑定/探针读/目录比对读。
 */
import type { DbLike } from '@tokenlens/db';
import type { BillingConfig } from '../domain/model/model';
import type { ListQuery, ListResult } from '../domain/list';

/** 管理面映射行（全字段——目录/绑定/价格编辑共用） */
export interface ModelRecord {
  readonly id: number;
  readonly externalName: string;
  readonly realModel: string;
  readonly contextLength: number | null;
  /** 0 上架 / 1 下架（目录 reference 导入用 1 = 草稿态） */
  readonly status: number;
  readonly inputPrice: string;
  readonly outputPrice: string;
  readonly cacheInputPrice: string;
  readonly cacheWritePrice: string;
  readonly pricingUnit: string;
  readonly unitPrice: string;
  /** 变体价格配置（分辨率差价）——管理面编辑回显依赖此列（列 notNull default {}） */
  readonly billingConfig: BillingConfig;
  readonly isFree: boolean;
  readonly billingPolicy: Record<string, unknown> | null;
  readonly rpmLimit: number | null;
  readonly tpmLimit: number | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ModelInsertInput {
  readonly externalName: string;
  readonly realModel: string;
  readonly contextLength?: number | null;
  readonly inputPrice: string;
  readonly outputPrice: string;
  readonly cacheInputPrice: string;
  readonly cacheWritePrice?: string;
  readonly unitPrice?: string;
  readonly pricingUnit?: string;
  readonly billingConfig?: BillingConfig;
  readonly isFree: boolean;
  readonly status?: number;
  readonly billingPolicy?: Record<string, unknown> | null;
  readonly rpmLimit?: number | null;
  readonly tpmLimit?: number | null;
}

/** 管理面更新补丁（价格字符串由 application 格式化；undefined=不改） */
export interface ModelPatch {
  readonly externalName?: string;
  readonly realModel?: string;
  readonly contextLength?: number | null;
  readonly status?: number;
  readonly inputPrice?: string;
  readonly outputPrice?: string;
  readonly cacheInputPrice?: string;
  readonly cacheWritePrice?: string;
  readonly unitPrice?: string;
  readonly pricingUnit?: string;
  readonly billingConfig?: BillingConfig;
  readonly isFree?: boolean;
  readonly billingPolicy?: Record<string, unknown> | null;
  readonly rpmLimit?: number | null;
  readonly tpmLimit?: number | null;
}

/** 模型探针专用读：绑定渠道连接信息（含密文——仅 application 解密） */
export interface ModelProbeChannelRow {
  readonly channelId: number;
  readonly channelName: string;
  readonly apiKeyEnc: string;
  readonly baseUrlOverride: string | null;
  readonly providerBaseUrl: string;
  readonly providerProtocol: string;
}

export type ModelSortField = 'id' | 'externalName' | 'realModel' | 'status' | 'createdAt';

export interface ModelStore {
  insertMapping(db: DbLike, input: ModelInsertInput): Promise<ModelRecord>;
  findById(db: DbLike, mappingId: number): Promise<ModelRecord | null>;
  findByExternalName(db: DbLike, externalName: string): Promise<ModelRecord | null>;
  /** 部分更新（白名单字段）。0 行 = 不存在 */
  updateMapping(
    db: DbLike,
    input: { mappingId: number; patch: ModelPatch },
  ): Promise<ModelRecord | null>;
  /** 软下架：status=1 */
  retireMapping(db: DbLike, input: { mappingId: number }): Promise<boolean>;
  /** 统一列表：q 命中 externalName/realModel（字面匹配） */
  listMappings(db: DbLike, query: ListQuery<ModelSortField>): Promise<ListResult<ModelRecord>>;
  /** 绑定全量替换：删旧插新（事务内）；空 channels = 解绑全部。返回新绑定数 */
  replaceModelChannels(
    db: DbLike,
    input: {
      mappingId: number;
      channels: Array<{ channelId: number; weight: number; priority: number }>;
    },
  ): Promise<number>;
  /** 页内映射的绑定渠道 id（列表回显 channelIds；未绑定 = 缺席，application 补 []） */
  listChannelIdsByMappingIds(
    db: DbLike,
    mappingIds: readonly number[],
  ): Promise<Array<{ mappingId: number; channelId: number }>>;
  /** 单映射的绑定渠道连接信息（模型探针用；含密文——仅 application 解密） */
  listBoundChannelsForProbe(
    db: DbLike,
    mappingId: number,
  ): Promise<readonly ModelProbeChannelRow[]>;
  /** 目录导入幂等绑定：已绑定时不重复插（复合主键冲突跳过） */
  ensureModelChannelBinding(
    db: DbLike,
    input: { mappingId: number; channelId: number },
  ): Promise<void>;
  /** 在架映射按真实名批量查（目录对比用：已导入回填卖价） */
  listEnabledByRealModels(
    db: DbLike,
    realModels: readonly string[],
  ): Promise<readonly ModelRecord[]>;
  /** 按渠道查绑定映射（目录「上游消失」检测：绑定到本源渠道的行） */
  listMappingRowsByChannelId(
    db: DbLike,
    channelId: number,
  ): Promise<Array<{ mappingId: number; externalName: string; realModel: string }>>;
}
