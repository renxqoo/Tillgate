/**
 * ModelStore port：模型映射（对外名→真实模型）与渠道绑定的持久化边界。
 * 网关热路径读（findActiveBy* / listEnabledMappings）见文件尾「网关热路径读」分区；
 * 其余方法覆盖管理面 CRUD/绑定/探针读/目录比对读。
 */
import type { DbLike } from '@tillgate/db';
import type { BillingConfig } from '../domain/model/model';
import type { ListQuery, ListResult } from '../domain/list';

/**
 * 网关热路径读行：在架映射的报价快照原料——价格/计价维度/
 * 分组键/免费标记/fallback 链/策略配置。快照的最终组装（费率卡系数、请求体单位上界）
 * 在 apps/gateway 的 catalog-port 桥（billing 纯函数 + 本行原料）。
 */
export interface ActiveMappingRow {
  readonly id: number;
  readonly externalName: string;
  readonly realModel: string;
  readonly contextLength: number | null;
  readonly inputPrice: string;
  readonly outputPrice: string;
  readonly cacheInputPrice: string;
  readonly cacheWritePrice: string;
  readonly pricingUnit: string;
  readonly unitPrice: string;
  /** 费率卡 scope='group' 匹配键（可空） */
  readonly pricingGroup: string | null;
  /** 模型维限流（可空 = 不限；网关 admitModel 钩子消费——管理台可配必生效） */
  readonly rpmLimit: number | null;
  readonly tpmLimit: number | null;
  readonly isFree: boolean;
  /** fallback 对外名链（一级展开；null/空 = 不降级） */
  readonly fallbackModels: string[] | null;
  readonly billingPolicy: Record<string, unknown> | null;
  readonly billingConfig: BillingConfig;
}

/** /v1/models 在架目录行（三协议形状的原料） */
export interface EnabledModelRow {
  readonly externalName: string;
  readonly realModel: string;
  readonly pricingUnit: string;
}

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
  /** 记录面逻辑删除时刻（回收站）：null = 在册；非空 = 已删除 */
  readonly deletedAt: Date | null;
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
  /** 该渠道的出站模型名（探针请求用它，不用映射规范名） */
  readonly upstreamModel: string;
}

export type ModelSortField = 'id' | 'externalName' | 'realModel' | 'status' | 'createdAt';

/** 列表视图：active = 在册（缺省，含上/下架，不含已删除）；deleted = 回收站（仅已删除） */
export type ModelListView = 'active' | 'deleted';

/** 管理面列表查询（统一列表形状 + 回收站视图） */
export type ModelListQuery = ListQuery<ModelSortField> & { readonly view?: ModelListView };

export interface ModelStore {
  insertMapping(db: DbLike, input: ModelInsertInput): Promise<ModelRecord>;
  /** 仅在册（deleted_at IS NULL）；已删除记录不可见 = null */
  findById(db: DbLike, mappingId: number): Promise<ModelRecord | null>;
  /** 仅在册——已删除记录的外部名视为可复用（导入/建卡按新记录处理） */
  findByExternalName(db: DbLike, externalName: string): Promise<ModelRecord | null>;
  /** 部分更新（白名单字段，仅在册行）。0 行 = 不存在（含已删除） */
  updateMapping(
    db: DbLike,
    input: { mappingId: number; patch: ModelPatch },
  ): Promise<ModelRecord | null>;
  /** 软下架：status=1（仅在册行） */
  retireMapping(db: DbLike, input: { mappingId: number }): Promise<boolean>;
  /**
   * 逻辑删除（回收站）：status=1 + deleted_at=now（仅在册行可删）。
   * 记录与渠道绑定保留可追溯；外部名随部分唯一索引释放可复用。
   */
  softDeleteMapping(db: DbLike, input: { mappingId: number }): Promise<boolean>;
  /** 恢复记录：deleted_at=NULL + status=1（回下架态，不直接复活上架；仅已删除行） */
  restoreMapping(db: DbLike, input: { mappingId: number }): Promise<boolean>;
  /** 统一列表：q 命中 externalName/realModel（字面匹配）；view 缺省 = 在册 */
  listMappings(db: DbLike, query: ModelListQuery): Promise<ListResult<ModelRecord>>;
  /** 绑定全量替换：删旧插新（事务内）；空 channels = 解绑全部。返回新绑定数 */
  replaceModelChannels(
    db: DbLike,
    input: {
      mappingId: number;
      channels: Array<{
        channelId: number;
        upstreamModel: string;
        weight: number;
        priority: number;
      }>;
    },
  ): Promise<number>;
  /** 页内映射的绑定行（列表回显渠道+出站名；未绑定 = 缺席，application 补 []） */
  listBindingsByMappingIds(
    db: DbLike,
    mappingIds: readonly number[],
  ): Promise<Array<{ mappingId: number; channelId: number; upstreamModel: string }>>;
  /** 单映射的绑定渠道连接信息（模型探针用；含密文——仅 application 解密） */
  listBoundChannelsForProbe(
    db: DbLike,
    mappingId: number,
  ): Promise<readonly ModelProbeChannelRow[]>;
  /** 目录导入幂等绑定：已绑定时不重复插（复合主键冲突跳过） */
  ensureModelChannelBinding(
    db: DbLike,
    input: { mappingId: number; channelId: number; upstreamModel: string },
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
  /** 绑定到渠道的在册映射数（渠道删除守卫：>0 → channel_has_models；已删除映射的残留绑定不计） */
  countActiveMappingsByChannel(db: DbLike, channelId: number): Promise<number>;
  // ---- 网关热路径读 ----
  /** 按对外名查在架映射（status=0 且未删除）；无/下架/已删除返回 null */
  findActiveByExternalName(db: DbLike, externalName: string): Promise<ActiveMappingRow | null>;
  /** 批量查在架映射（fallback 链展开）；空入参返回空表 */
  findActiveByExternalNames(
    db: DbLike,
    externalNames: readonly string[],
  ): Promise<Map<string, ActiveMappingRow>>;
  /** 在架模型目录（/v1/models 三协议形状原料；按外部名排序） */
  listEnabledMappings(db: DbLike): Promise<EnabledModelRow[]>;
}
