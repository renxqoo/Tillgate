/**
 * channels 渠道 postgres 适配器（管理面）：
 * CRUD/列表富化读 + 探针读 + 运营资金守卫原子操作（budget/recharge 族），
 * 以及网关路由候选与 worker 任务渠道热路径读。
 * 管理面返回形状永不包含 apiKeyEnc（密文不出库；探针读与热路径读除外，仅 application 解密用）。
 */
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import {
  admins,
  channelRecharges,
  channels,
  modelChannels,
  modelMappings,
  providers,
  usageLogs,
} from '@tillgate/db';
import type {
  ChannelStore,
  ChannelListRow,
  RechargeRow,
  RouteCandidateRow,
  TaskChannelRow,
  RechargeSortField,
  ChannelListQuery,
} from '../../ports/channel-store';
import { escapeLikePattern } from './search';

const CHANNEL_LIST_SORTS = {
  id: channels.id,
  name: channels.name,
  status: channels.status,
  priority: channels.priority,
  createdAt: channels.createdAt,
} as const;

// 充值流水列表选取面:纯列引用,模块级复用避免函数超限
const RECHARGE_LIST_SELECTION = {
  id: channelRecharges.id,
  channelId: channelRecharges.channelId,
  channelName: channels.name,
  type: channelRecharges.type,
  amount: channelRecharges.amount,
  balanceAfter: channelRecharges.balanceAfter,
  orderNo: channelRecharges.orderNo,
  voucher: channelRecharges.voucher,
  remark: channelRecharges.remark,
  adminId: channelRecharges.adminId,
  adminEmail: admins.email,
  adminDisplayName: admins.displayName,
  createdAt: channelRecharges.createdAt,
} as const;

const RECHARGE_SORTS = {
  id: channelRecharges.id,
  amount: channelRecharges.amount,
  createdAt: channelRecharges.createdAt,
} as const;

/** 路由候选成本五轴 + 成本配置（COALESCE 绑定覆盖/映射官方——读取处单轨收口，docs/channel-cost-pricing.md C2） */
const ROUTE_COST_COLUMNS = {
  costInputPrice: sql<string>`coalesce(${modelChannels.costInputPrice}, ${modelMappings.inputPrice})::text`,
  costOutputPrice: sql<string>`coalesce(${modelChannels.costOutputPrice}, ${modelMappings.outputPrice})::text`,
  costCacheInputPrice: sql<string>`coalesce(${modelChannels.costCacheInputPrice}, ${modelMappings.cacheInputPrice})::text`,
  costCacheWritePrice: sql<string>`coalesce(${modelChannels.costCacheWritePrice}, ${modelMappings.cacheWritePrice})::text`,
  costUnitPrice: sql<string>`coalesce(${modelChannels.costUnitPrice}, ${modelMappings.unitPrice})::text`,
  costConfig: modelChannels.costConfig,
  costIsFree: modelChannels.costIsFree,
} as const;

export const postgresChannelStore: ChannelStore = {
  async insertChannel(db, input) {
    const [row] = await db
      .insert(channels)
      .values({
        providerId: input.providerId,
        name: input.name,
        apiKeyEnc: input.apiKeyEnc,
        baseUrlOverride: input.baseUrlOverride ?? null,
        models: input.models ?? null,
        weight: input.weight ?? 1,
        priority: input.priority ?? 0,
        rpmLimit: input.rpmLimit ?? null,
        tpmLimit: input.tpmLimit ?? null,
        upstreamBudget: input.upstreamBudget ?? '0',
        status: input.status ?? 0,
      })
      .returning({ id: channels.id, name: channels.name, providerId: channels.providerId });
    if (!row) throw new Error('channel.insert_failed');
    return row;
  },

  async findChannelByName(db, name) {
    const [row] = await db
      .select({ id: channels.id, rpmLimit: channels.rpmLimit })
      .from(channels)
      .where(and(eq(channels.name, name), isNull(channels.deletedAt)));
    return row ?? null;
  },

  async updateChannel(db, input) {
    const rows = await db
      .update(channels)
      .set({ ...input.patch, updatedAt: new Date() })
      // 已删除记录不可编辑（回收站行只读——恢复走 restoreChannel）
      .where(and(eq(channels.id, input.channelId), isNull(channels.deletedAt)))
      .returning({
        id: channels.id,
        name: channels.name,
        status: channels.status,
        failCount: channels.failCount,
      });
    return rows[0] ?? null;
  },

  async retireChannel(db, input) {
    const rows = await db
      .update(channels)
      .set({ status: 1, updatedAt: new Date() })
      .where(and(eq(channels.id, input.channelId), isNull(channels.deletedAt)))
      .returning({ id: channels.id });
    return rows.length > 0;
  },

  async softDeleteChannel(db, input) {
    const rows = await db
      .update(channels)
      // status 同步压 1：路由 status=0 过滤天然排除（删除不可留在启用态）
      .set({ status: 1, deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(channels.id, input.channelId), isNull(channels.deletedAt)))
      .returning({ id: channels.id });
    return rows.length > 0;
  },

  async restoreChannel(db, input) {
    const rows = await db
      .update(channels)
      // 回停用态：不直接启用——复核后由管理员显式启用
      .set({ deletedAt: null, status: 1, updatedAt: new Date() })
      .where(and(eq(channels.id, input.channelId), isNotNull(channels.deletedAt)))
      .returning({ id: channels.id });
    return rows.length > 0;
  },

  async countActiveByProvider(db, providerId) {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(channels)
      .where(and(eq(channels.providerId, providerId), isNull(channels.deletedAt)));
    return row?.count ?? 0;
  },

  async findChannelForProbe(db, channelId) {
    const [row] = await db
      .select({
        channelId: channels.id,
        channelName: channels.name,
        apiKeyEnc: channels.apiKeyEnc,
        baseUrlOverride: channels.baseUrlOverride,
        providerBaseUrl: providers.baseUrl,
        providerProtocol: providers.protocol,
      })
      .from(channels)
      .innerJoin(providers, eq(channels.providerId, providers.id))
      .where(eq(channels.id, channelId));
    return row ?? null;
  },

  async findChannelFunds(db, channelId) {
    const [row] = await db
      .select({
        id: channels.id,
        upstreamBudget: channels.upstreamBudget,
        upstreamReserved: channels.upstreamReserved,
        upstreamThreshold: channels.upstreamThreshold,
        status: channels.status,
      })
      .from(channels)
      .where(eq(channels.id, channelId));
    return row ?? null;
  },

  async listChannels(db, query: ChannelListQuery) {
    const pattern = query.q ? escapeLikePattern(query.q) : null;
    // 视图：active（缺省）= 在册（不含已删除）；deleted = 回收站（仅已删除）
    const viewWhere =
      query.view === 'deleted' ? isNotNull(channels.deletedAt) : isNull(channels.deletedAt);
    const where = pattern
      ? and(viewWhere, or(ilike(channels.name, pattern), ilike(providers.name, pattern)))
      : viewWhere;
    const column = CHANNEL_LIST_SORTS[query.sortBy];
    const orderBy = [query.order === 'asc' ? asc(column) : desc(column), desc(channels.id)];
    const [rows, countRows] = await Promise.all([
      db
        .select({
          id: channels.id,
          name: channels.name,
          providerId: channels.providerId,
          providerName: providers.name,
          baseUrlOverride: channels.baseUrlOverride,
          models: channels.models,
          weight: channels.weight,
          priority: channels.priority,
          status: channels.status,
          failCount: channels.failCount,
          rpmLimit: channels.rpmLimit,
          tpmLimit: channels.tpmLimit,
          upstreamBudget: channels.upstreamBudget,
          upstreamThreshold: channels.upstreamThreshold,
          deletedAt: channels.deletedAt,
          createdAt: channels.createdAt,
        })
        .from(channels)
        .innerJoin(providers, eq(channels.providerId, providers.id))
        .where(where)
        .orderBy(...orderBy)
        .limit(query.limit)
        .offset(query.offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(channels)
        .innerJoin(providers, eq(channels.providerId, providers.id))
        .where(where),
    ]);
    return { rows: rows as ChannelListRow[], total: countRows[0]?.count ?? 0 };
  },

  async listBoundModelsByChannelIds(db, channelIds) {
    if (channelIds.length === 0) return [];
    return db
      .select({ channelId: modelChannels.channelId, externalName: modelMappings.externalName })
      .from(modelChannels)
      .innerJoin(modelMappings, eq(modelChannels.mappingId, modelMappings.id))
      .where(inArray(modelChannels.channelId, [...channelIds]));
  },

  async sumUpstreamConsumedByChannelIds(db, channelIds) {
    if (channelIds.length === 0) return new Map();
    const rows = await db
      .select({
        channelId: usageLogs.channelId,
        consumed: sql<string>`coalesce(sum(${usageLogs.upstreamCost}), 0)::numeric`,
      })
      .from(usageLogs)
      .where(and(inArray(usageLogs.channelId, [...channelIds]), eq(usageLogs.status, 0)))
      .groupBy(usageLogs.channelId);
    return new Map(
      rows
        .filter((row): row is { channelId: number; consumed: string } => row.channelId != null)
        .map((row) => [row.channelId, row.consumed]),
    );
  },

  async rechargeBudget(db, input) {
    const rows = await db
      .update(channels)
      .set({
        upstreamBudget: sql`${channels.upstreamBudget} + ${input.amount}::numeric`,
        // 熔断(3)自动复活为启用(0)
        status: sql`case when ${channels.status} = 3 then 0 else ${channels.status} end`,
        updatedAt: input.now,
      })
      .where(eq(channels.id, input.channelId))
      .returning({ budget: channels.upstreamBudget });
    const [row] = rows;
    if (row === undefined) throw new Error('channel.recharge_missed');
    return row.budget;
  },

  async tryAdjustBudget(db, input) {
    const rows = await db
      .update(channels)
      .set({
        upstreamBudget: sql`${channels.upstreamBudget} + ${input.amount}::numeric`,
        updatedAt: input.now,
      })
      .where(
        sql`${channels.id} = ${input.channelId}
            and ${channels.upstreamBudget} + ${input.amount}::numeric >= 0`,
      )
      .returning({ budget: channels.upstreamBudget });
    const [row] = rows;
    return row ? { ok: true as const, budget: row.budget } : { ok: false as const };
  },

  async insertRecharge(db, values) {
    const [row] = await db
      .insert(channelRecharges)
      .values(values)
      .returning({ id: channelRecharges.id });
    if (!row) throw new Error('channel.insert_recharge_failed');
    return row.id;
  },

  async listRecharges(db, query) {
    const conditions = [];
    if (query.q) {
      const pattern = escapeLikePattern(query.q);
      // drizzle or() 返回 SQL|undefined,三个非空入参下必为 SQL——显式收窄
      const cond = or(
        ilike(channelRecharges.orderNo, pattern),
        ilike(channelRecharges.remark, pattern),
        ilike(channels.name, pattern),
      );
      if (cond !== undefined) conditions.push(cond);
    }
    if (query.channelId !== undefined) {
      conditions.push(eq(channelRecharges.channelId, query.channelId));
    }
    if (query.type !== undefined) conditions.push(eq(channelRecharges.type, query.type));
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const column = RECHARGE_SORTS[query.sortBy as RechargeSortField];
    const orderBy = [query.order === 'asc' ? asc(column) : desc(column), desc(channelRecharges.id)];
    const [rows, countRows] = await Promise.all([
      db
        .select(RECHARGE_LIST_SELECTION)
        .from(channelRecharges)
        .innerJoin(channels, eq(channelRecharges.channelId, channels.id))
        .leftJoin(admins, eq(channelRecharges.adminId, admins.id))
        .where(where)
        .orderBy(...orderBy)
        .limit(query.limit)
        .offset(query.offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(channelRecharges)
        .innerJoin(channels, eq(channelRecharges.channelId, channels.id))
        .where(where),
    ]);
    return { rows: rows as RechargeRow[], total: countRows[0]?.count ?? 0 };
  },

  // ---- 网关热路径读 ----

  async findRouteCandidates(db, realModel) {
    const rows = await db
      .select({
        channelId: channels.id,
        channelName: channels.name,
        apiKeyEnc: channels.apiKeyEnc,
        baseUrlOverride: channels.baseUrlOverride,
        providerName: providers.name,
        providerBaseUrl: providers.baseUrl,
        providerProtocol: providers.protocol,
        providerVendor: providers.vendor,
        upstreamModel: modelChannels.upstreamModel,
        // 路由排序单轨：渠道层 weight/priority（用户裁决 D4——绑定级旧列已迁移清退）
        priority: channels.priority,
        weight: channels.weight,
        rpmLimit: channels.rpmLimit,
        tpmLimit: channels.tpmLimit,
        upstreamBudget: channels.upstreamBudget,
        upstreamRemaining: sql<string>`(${channels.upstreamBudget} - ${channels.upstreamReserved})::numeric`,
        ...ROUTE_COST_COLUMNS,
      })
      .from(modelChannels)
      .innerJoin(channels, eq(modelChannels.channelId, channels.id))
      .innerJoin(providers, eq(channels.providerId, providers.id))
      .innerJoin(modelMappings, eq(modelChannels.mappingId, modelMappings.id))
      // 已删除供应商的渠道不再路由（记录面删除在服务面同步生效；禁用 status 不在此语义内）
      .where(
        and(
          eq(modelMappings.realModel, realModel),
          eq(channels.status, 0),
          isNull(channels.deletedAt),
          isNull(providers.deletedAt),
          // 渠道白名单交集：SQL NULL / 空数组 = 不限；非空数组须包含绑定出站名（标量包含）。
          // 防御：契约外非数组值（含 jsonb null 标量）按不限放行——单行脏数据不熔断整条路由
          or(
            isNull(channels.models),
            sql`jsonb_typeof(${channels.models}) <> 'array'`,
            sql`jsonb_array_length(${channels.models}) = 0`,
            sql`${channels.models} @> to_jsonb(${modelChannels.upstreamModel}::text)`,
          ),
        ),
      )
      .orderBy(desc(channels.priority), desc(channels.weight));
    // costConfig 列类型 BillingConfigJson（接口无索引签名）→ 行边界整体收窄到端口类型
    return rows as unknown as RouteCandidateRow[];
  },

  // ---- worker 任务轮询读 ----

  async findTaskChannel(db, channelId) {
    // 不按启用状态过滤：已提交任务所属渠道即使事后停用，轮询/代执行仍须可达
    // （渠道级 priority/weight 对任务推进无意义，取表列原值填充形状；出站名在任务行快照）
    const [row] = await db
      .select({
        channelId: channels.id,
        channelName: channels.name,
        apiKeyEnc: channels.apiKeyEnc,
        baseUrlOverride: channels.baseUrlOverride,
        providerName: providers.name,
        providerBaseUrl: providers.baseUrl,
        providerProtocol: providers.protocol,
        providerVendor: providers.vendor,
        priority: channels.priority,
        weight: channels.weight,
        rpmLimit: channels.rpmLimit,
        tpmLimit: channels.tpmLimit,
        upstreamBudget: channels.upstreamBudget,
        upstreamRemaining: sql<string>`(${channels.upstreamBudget} - ${channels.upstreamReserved})::numeric`,
      })
      .from(channels)
      .innerJoin(providers, eq(channels.providerId, providers.id))
      .where(eq(channels.id, channelId));
    return (row as TaskChannelRow | undefined) ?? null;
  },
};
