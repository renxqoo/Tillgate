/**
 * model_mappings 模型映射 postgres 适配器（v1 model-mapping.repo 管理面子集等价迁移）：
 * 管理面 CRUD/绑定全量替换/探针读/目录比对读。
 * 报价候选链解析与 /v1/models 在架目录读是网关热路径——不在此（inference 波次 G1）。
 */
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { channels, modelChannels, modelMappings, providers } from '@tokenlens/db';
import type {
  ModelStore,
  ModelRecord,
  ModelInsertInput,
  ModelPatch,
  ModelSortField,
  ModelProbeChannelRow,
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
  createdAt: modelMappings.createdAt,
  updatedAt: modelMappings.updatedAt,
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
      .where(eq(modelMappings.id, mappingId));
    return (row as ModelRecord) ?? null;
  },

  async findByExternalName(db, externalName) {
    const [row] = await db
      .select(MAPPING_ADMIN_COLUMNS)
      .from(modelMappings)
      .where(eq(modelMappings.externalName, externalName));
    return (row as ModelRecord) ?? null;
  },

  async updateMapping(db, input: { mappingId: number; patch: ModelPatch }) {
    const rows = await db
      .update(modelMappings)
      .set({ ...input.patch, updatedAt: new Date() })
      .where(eq(modelMappings.id, input.mappingId))
      .returning(MAPPING_ADMIN_COLUMNS);
    return (rows[0] as ModelRecord) ?? null;
  },

  async retireMapping(db, input) {
    const rows = await db
      .update(modelMappings)
      .set({ status: 1, updatedAt: new Date() })
      .where(eq(modelMappings.id, input.mappingId))
      .returning({ id: modelMappings.id });
    return rows.length > 0;
  },

  async listMappings(db, query) {
    const pattern = query.q ? escapeLikePattern(query.q) : null;
    const where = pattern
      ? or(ilike(modelMappings.externalName, pattern), ilike(modelMappings.realModel, pattern))
      : undefined;
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
    return db
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
      .where(eq(modelChannels.mappingId, mappingId)) as Promise<ModelProbeChannelRow[]>;
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
      .where(and(inArray(modelMappings.realModel, [...realModels]), eq(modelMappings.status, 0)));
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
      .where(eq(modelChannels.channelId, channelId));
  },
};
