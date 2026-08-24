/**
 * model_mappings 模型映射 postgres 适配器（v1 model-mapping.repo 管理面子集等价迁移）：
 * 管理面 CRUD/绑定全量替换/探针读/目录比对读。
 * 报价候选链解析与 /v1/models 在架目录读是网关热路径——不在此（inference 波次 G1）。
 */
import { and, asc, desc, eq, ilike, inArray, isNull, isNotNull, or, sql } from 'drizzle-orm';
import { channels, modelChannels, modelMappings, providers } from '@tillgate/db';
import type {
  ModelStore,
  ModelRecord,
  ModelInsertInput,
  ModelSortField,
  ModelProbeChannelRow,
  ActiveMappingRow,
} from '../../ports/model-store';
import { escapeLikePattern } from './search';

const MAPPING_ADMIN_COLUMNS = {
  id: modelMappings.id,
  externalName: modelMappings.externalName,
  realModel: modelMappings.realModel,
  contextLength: modelMappings.contextLength,
  status: modelMappings.status,
  inputPrice: modelMappings.inputPrice,
  outputPrice: modelMappings.outputPrice,
  cacheInputPrice: modelMappings.cacheInputPrice,
  cacheWritePrice: modelMappings.cacheWritePrice,
  pricingUnit: modelMappings.pricingUnit,
  unitPrice: modelMappings.unitPrice,
  billingConfig: modelMappings.billingConfig,
  isFree: modelMappings.isFree,
  billingPolicy: modelMappings.billingPolicy,
  rpmLimit: modelMappings.rpmLimit,
  tpmLimit: modelMappings.tpmLimit,
  deletedAt: modelMappings.deletedAt,
  createdAt: modelMappings.createdAt,
  updatedAt: modelMappings.updatedAt,
} as const;

const ACTIVE_MAPPING_COLUMNS = {
  id: modelMappings.id,
  externalName: modelMappings.externalName,
  realModel: modelMappings.realModel,
  contextLength: modelMappings.contextLength,
  inputPrice: modelMappings.inputPrice,
  outputPrice: modelMappings.outputPrice,
  cacheInputPrice: modelMappings.cacheInputPrice,
  cacheWritePrice: modelMappings.cacheWritePrice,
  pricingUnit: modelMappings.pricingUnit,
  unitPrice: modelMappings.unitPrice,
  pricingGroup: modelMappings.pricingGroup,
  isFree: modelMappings.isFree,
  fallbackModels: modelMappings.fallbackModels,
  billingPolicy: modelMappings.billingPolicy,
  billingConfig: modelMappings.billingConfig,
} as const;

const MAPPING_SORTS = {
  id: modelMappings.id,
  externalName: modelMappings.externalName,
  realModel: modelMappings.realModel,
  status: modelMappings.status,
  createdAt: modelMappings.createdAt,
} as const;

export const postgresModelStore: ModelStore = {
  async insertMapping(db, input: ModelInsertInput) {
    const [row] = await db
      .insert(modelMappings)
      .values({
        externalName: input.externalName,
        realModel: input.realModel,
        contextLength: input.contextLength ?? null,
        status: input.status ?? 0,
        inputPrice: input.inputPrice,
        outputPrice: input.outputPrice,
        cacheInputPrice: input.cacheInputPrice,
        cacheWritePrice: input.cacheWritePrice ?? '0',
        pricingUnit: input.pricingUnit ?? 'token',
        unitPrice: input.unitPrice ?? '0',
        billingConfig: input.billingConfig ?? {},
        isFree: input.isFree,
        billingPolicy: input.billingPolicy ?? null,
        rpmLimit: input.rpmLimit ?? null,
        tpmLimit: input.tpmLimit ?? null,
      })
      .returning(MAPPING_ADMIN_COLUMNS);
    if (!row) throw new Error('model_mapping.insert_failed');
    return row as ModelRecord;
  },

  async findById(db, mappingId) {
    const [row] = await db
      .select(MAPPING_ADMIN_COLUMNS)
      .from(modelMappings)
      .where(and(eq(modelMappings.id, mappingId), isNull(modelMappings.deletedAt)));
    return (row as ModelRecord) ?? null;
  },

  async findByExternalName(db, externalName) {
    const [row] = await db
      .select(MAPPING_ADMIN_COLUMNS)
      .from(modelMappings)
      .where(and(eq(modelMappings.externalName, externalName), isNull(modelMappings.deletedAt)));
    return (row as ModelRecord) ?? null;
  },

  async updateMapping(db, input) {
    const rows = await db
      .update(modelMappings)
      .set({ ...input.patch, updatedAt: new Date() })
      // 已删除记录不可编辑（回收站行只读——恢复走 restoreMapping）
      .where(and(eq(modelMappings.id, input.mappingId), isNull(modelMappings.deletedAt)))
      .returning(MAPPING_ADMIN_COLUMNS);
    return (rows[0] as ModelRecord) ?? null;
  },

  async retireMapping(db, input) {
    const rows = await db
      .update(modelMappings)
      .set({ status: 1, updatedAt: new Date() })
      .where(and(eq(modelMappings.id, input.mappingId), isNull(modelMappings.deletedAt)))
      .returning({ id: modelMappings.id });
    return rows.length > 0;
  },

  async softDeleteMapping(db, input) {
    const rows = await db
      .update(modelMappings)
      // status 同步压 1：热路径 status=0 过滤天然排除（删除不可留在上架态）
      .set({ status: 1, deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(modelMappings.id, input.mappingId), isNull(modelMappings.deletedAt)))
      .returning({ id: modelMappings.id });
    return rows.length > 0;
  },

  async restoreMapping(db, input) {
    const rows = await db
      .update(modelMappings)
      // 回下架态：不直接复活上架——复核后由管理员显式上架
      .set({ deletedAt: null, status: 1, updatedAt: new Date() })
      .where(and(eq(modelMappings.id, input.mappingId), isNotNull(modelMappings.deletedAt)))
      .returning({ id: modelMappings.id });
    return rows.length > 0;
  },

  async listMappings(db, query) {
    const pattern = query.q ? escapeLikePattern(query.q) : null;
    // 视图：active（缺省）= 在册（不含已删除）；deleted = 回收站（仅已删除）
    const viewWhere =
      query.view === 'deleted'
        ? isNotNull(modelMappings.deletedAt)
        : isNull(modelMappings.deletedAt);
    const where = pattern
      ? and(
          viewWhere,
          or(ilike(modelMappings.externalName, pattern), ilike(modelMappings.realModel, pattern)),
        )
      : viewWhere;
    const column = MAPPING_SORTS[query.sortBy as ModelSortField];
    const orderBy = [query.order === 'asc' ? asc(column) : desc(column), desc(modelMappings.id)];
    const [rows, countRows] = await Promise.all([
      db
        .select(MAPPING_ADMIN_COLUMNS)
        .from(modelMappings)
        .where(where)
        .orderBy(...orderBy)
        .limit(query.limit)
        .offset(query.offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(modelMappings)
        .where(where),
    ]);
    return { rows: rows as ModelRecord[], total: countRows[0]?.count ?? 0 };
  },

  async replaceModelChannels(db, input) {
    // 绑定全量替换：删旧插新（同一事务）；空 = 解绑全部
    await db.delete(modelChannels).where(eq(modelChannels.mappingId, input.mappingId));
    if (input.channels.length === 0) return 0;
    await db
      .insert(modelChannels)
      .values(input.channels.map((ch) => ({ ...ch, mappingId: input.mappingId })));
    return input.channels.length;
  },

  async listChannelIdsByMappingIds(db, mappingIds) {
    if (mappingIds.length === 0) return [];
    return db
      .select({ mappingId: modelChannels.mappingId, channelId: modelChannels.channelId })
      .from(modelChannels)
      .where(inArray(modelChannels.mappingId, [...mappingIds]));
  },

  async listBoundChannelsForProbe(db, mappingId) {
    return (
      db
        .select({
          channelId: channels.id,
          channelName: channels.name,
          apiKeyEnc: channels.apiKeyEnc,
          baseUrlOverride: channels.baseUrlOverride,
          providerBaseUrl: providers.baseUrl,
          providerProtocol: providers.protocol,
        })
        .from(modelChannels)
        .innerJoin(channels, eq(modelChannels.channelId, channels.id))
        .innerJoin(providers, eq(channels.providerId, providers.id))
        // 已删除渠道不参与探针（回收站行只读；残留绑定仅作历史追溯）
        .where(and(eq(modelChannels.mappingId, mappingId), isNull(channels.deletedAt))) as Promise<
        ModelProbeChannelRow[]
      >
    );
  },

  async ensureModelChannelBinding(db, input) {
    // 目录导入幂等绑定：已绑定时不重复插（复合主键冲突跳过）
    await db
      .insert(modelChannels)
      .values({ mappingId: input.mappingId, channelId: input.channelId, weight: 1, priority: 0 })
      .onConflictDoNothing({ target: [modelChannels.mappingId, modelChannels.channelId] });
  },

  async listEnabledByRealModels(db, realModels) {
    if (realModels.length === 0) return [];
    const rows = await db
      .select(MAPPING_ADMIN_COLUMNS)
      .from(modelMappings)
      .where(
        and(
          inArray(modelMappings.realModel, [...realModels]),
          eq(modelMappings.status, 0),
          isNull(modelMappings.deletedAt),
        ),
      );
    return rows as ModelRecord[];
  },

  async listMappingRowsByChannelId(db, channelId) {
    return db
      .select({
        mappingId: modelChannels.mappingId,
        externalName: modelMappings.externalName,
        realModel: modelMappings.realModel,
      })
      .from(modelChannels)
      .innerJoin(modelMappings, eq(modelChannels.mappingId, modelMappings.id))
      .where(and(eq(modelChannels.channelId, channelId), isNull(modelMappings.deletedAt)));
  },

  async countActiveMappingsByChannel(db, channelId) {
    // 绑定守卫计数：仅算在册映射（已删除映射的残留绑定是历史追溯，不算下游占用）
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(modelChannels)
      .innerJoin(modelMappings, eq(modelChannels.mappingId, modelMappings.id))
      .where(and(eq(modelChannels.channelId, channelId), isNull(modelMappings.deletedAt)));
    return row?.count ?? 0;
  },

  // ---- 网关热路径读（G1；v1 QUOTE_COLUMNS 子集 + status=0 过滤） ----

  async findActiveByExternalName(db, externalName) {
    const [row] = await db
      .select(ACTIVE_MAPPING_COLUMNS)
      .from(modelMappings)
      .where(
        and(
          eq(modelMappings.externalName, externalName),
          eq(modelMappings.status, 0),
          isNull(modelMappings.deletedAt),
        ),
      );
    return (row as ActiveMappingRow) ?? null;
  },

  async findActiveByExternalNames(db, externalNames) {
    if (externalNames.length === 0) return new Map();
    const rows = await db
      .select(ACTIVE_MAPPING_COLUMNS)
      .from(modelMappings)
      .where(
        and(
          inArray(modelMappings.externalName, [...externalNames]),
          eq(modelMappings.status, 0),
          isNull(modelMappings.deletedAt),
        ),
      );
    return new Map(
      rows.map((row) => [(row as ActiveMappingRow).externalName, row as ActiveMappingRow]),
    );
  },

  async listEnabledMappings(db) {
    const rows = await db
      .select({
        externalName: modelMappings.externalName,
        realModel: modelMappings.realModel,
        pricingUnit: modelMappings.pricingUnit,
      })
      .from(modelMappings)
      .where(and(eq(modelMappings.status, 0), isNull(modelMappings.deletedAt)))
      .orderBy(asc(modelMappings.externalName));
    return rows;
  },
};
