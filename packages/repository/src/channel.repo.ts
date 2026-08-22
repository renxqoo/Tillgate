/**
 * channel 仓储：进货额度与在途敞口的守卫原子操作 + 管理面 CRUD/列表。
 * 表族 = 聚合：channels（预算/敞口）与 channel_recharges（其账本流水）是渠道运营资金
 * 的不可分单元——流水行是渠道余额的历史投影，与 wallet 腿同构。
 * 余额口径 = upstream_budget（进货额度）− upstream_reserved（在途敞口）；
 * 守卫内联 UPDATE WHERE，并发超扣在结构上不可达。
 */
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { DbTx } from '@ai-gateway/db';
import {
  admins,
  channelRecharges,
  channels,
  modelChannels,
  modelMappings,
  providers,
  usageLogs,
} from '@ai-gateway/db';
import type { RepoContext } from './context.js';
import { escapeLikePattern } from './search.js';

function tx(c: RepoContext): DbTx {
  return c.db as DbTx;
}

/** 路由候选（读模型）：真实模型 → 可用渠道 × 供应商连接信息，调度排序在 app 层 */
export interface RouteCandidateRow {
  channelId: number;
  channelName: string;
  apiKeyEnc: string;
  baseUrlOverride: string | null;
  providerName: string;
  providerBaseUrl: string;
  providerProtocol: string;
  providerVendor: string | null;
  priority: number;
  weight: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  upstreamBudget: string;
}

export interface ChannelRow {
  id: number;
  upstreamBudget: string;
  upstreamReserved: string;
  upstreamThreshold: string | null;
  status: number;
}

/** 任务轮询渠道连接信息（在途任务可达——不做 status=0 过滤，任务终态化优先） */
export interface TaskChannelRow {
  channelId: number;
  channelName: string;
  apiKeyEnc: string;
  baseUrlOverride: string | null;
  providerName: string;
  providerBaseUrl: string;
  providerProtocol: string;
  providerVendor: string | null;
}

const CHANNEL_COLUMNS = {
  id: channels.id,
  upstreamBudget: channels.upstreamBudget,
  upstreamReserved: channels.upstreamReserved,
  upstreamThreshold: channels.upstreamThreshold,
  status: channels.status,
};

/** 渠道运营资金仓储（无状态；方法统一接收 RepoContext——事务由用例层注入） */
export class ChannelRepository {
  /** 路由候选：realModel → 绑定渠道（status=0 启用）× 供应商连接信息；priority/weight 降序基序 */
  async findRouteCandidates(c: RepoContext, realModel: string): Promise<RouteCandidateRow[]> {
    const rows = await c.db
      .select({
        channelId: channels.id,
        channelName: channels.name,
        apiKeyEnc: channels.apiKeyEnc,
        baseUrlOverride: channels.baseUrlOverride,
        providerName: providers.name,
        providerBaseUrl: providers.baseUrl,
        providerProtocol: providers.protocol,
        providerVendor: providers.vendor,
        priority: modelChannels.priority,
        weight: modelChannels.weight,
        rpmLimit: channels.rpmLimit,
        tpmLimit: channels.tpmLimit,
        upstreamBudget: channels.upstreamBudget,
      })
      .from(modelChannels)
      .innerJoin(channels, eq(modelChannels.channelId, channels.id))
      .innerJoin(providers, eq(channels.providerId, providers.id))
      .innerJoin(modelMappings, eq(modelChannels.mappingId, modelMappings.id))
      .where(and(eq(modelMappings.realModel, realModel), eq(channels.status, 0)))
      .orderBy(desc(modelChannels.priority), desc(modelChannels.weight));
    return rows as RouteCandidateRow[];
  }

  async findChannel(c: RepoContext, channelId: number): Promise<ChannelRow | null> {
    const [row] = await c.db.select(CHANNEL_COLUMNS).from(channels).where(eq(channels.id, channelId));
    return (row as ChannelRow) ?? null;
  }

  /** 任务轮询渠道连接信息（join provider 寻址/协议；在途任务不受渠道停用影响） */
  async findTaskChannel(c: RepoContext, channelId: number): Promise<TaskChannelRow | null> {
    const [row] = await c.db
      .select({
        channelId: channels.id,
        channelName: channels.name,
        apiKeyEnc: channels.apiKeyEnc,
        baseUrlOverride: channels.baseUrlOverride,
        providerName: providers.name,
        providerBaseUrl: providers.baseUrl,
        providerProtocol: providers.protocol,
        providerVendor: providers.vendor,
      })
      .from(channels)
      .innerJoin(providers, eq(channels.providerId, providers.id))
      .where(eq(channels.id, channelId));
    return (row as TaskChannelRow) ?? null;
  }

  async lockChannel(c: RepoContext, channelId: number): Promise<ChannelRow | null> {
    const [row] = await tx(c).select(CHANNEL_COLUMNS).from(channels).where(eq(channels.id, channelId)).for('update');
    return (row as ChannelRow) ?? null;
  }

  /** 进货：budget += amount（正数）；熔断(3)自动复活为启用(0)；返回新余额 */
  async rechargeBudget(
    c: RepoContext,
    input: { channelId: number; amount: string; now: Date },
  ): Promise<string> {
    const rows = await tx(c)
      .update(channels)
      .set({
        upstreamBudget: sql`${channels.upstreamBudget} + ${input.amount}::numeric`,
        status: sql`case when ${channels.status} = 3 then 0 else ${channels.status} end`,
        updatedAt: input.now,
      })
      .where(eq(channels.id, input.channelId))
      .returning({ budget: channels.upstreamBudget });
    if (rows.length === 0) throw new Error('channel.recharge_missed');
    return rows[0]!.budget;
  }

  /** 调账：budget += amount（可负）；守卫 = 调后不得为负。返回新余额；ok:false=守卫未过 */
  async tryAdjustBudget(
    c: RepoContext,
    input: { channelId: number; amount: string; now: Date },
  ): Promise<{ ok: true; budget: string } | { ok: false }> {
    const rows = await tx(c)
      .update(channels)
      .set({ upstreamBudget: sql`${channels.upstreamBudget} + ${input.amount}::numeric`, updatedAt: input.now })
      .where(
        sql`${channels.id} = ${input.channelId}
            and ${channels.upstreamBudget} + ${input.amount}::numeric >= 0`,
      )
      .returning({ budget: channels.upstreamBudget });
    const row = rows[0];
    return row ? { ok: true, budget: row.budget } : { ok: false };
  }

  /** 敞口预留：reserved += delta；守卫 = 余额 ≥ delta。返回 null=守卫未过，否则新值 */
  async tryIncreaseReserved(
    c: RepoContext,
    input: { channelId: number; delta: string; now: Date },
  ): Promise<{ reserved: string; budget: string } | null> {
    const rows = await tx(c)
      .update(channels)
      .set({ upstreamReserved: sql`${channels.upstreamReserved} + ${input.delta}::numeric`, updatedAt: input.now })
      .where(
        sql`${channels.id} = ${input.channelId}
            and ${channels.upstreamBudget} - ${channels.upstreamReserved} >= ${input.delta}::numeric`,
      )
      .returning({ reserved: channels.upstreamReserved, budget: channels.upstreamBudget });
    const row = rows[0];
    return row ? { reserved: row.reserved, budget: row.budget } : null;
  }

  /** 敞口释放：reserved −= amount；守卫 = 在途足额（防二次释放偷走他人敞口） */
  async tryDecreaseReserved(
    c: RepoContext,
    input: { channelId: number; amount: string; now: Date },
  ): Promise<boolean> {
    const rows = await tx(c)
      .update(channels)
      .set({ upstreamReserved: sql`${channels.upstreamReserved} - ${input.amount}::numeric`, updatedAt: input.now })
      .where(
        sql`${channels.id} = ${input.channelId}
            and ${channels.upstreamReserved} >= ${input.amount}::numeric`,
      )
      .returning({ id: channels.id });
    return rows.length > 0;
  }

  /**
   * 成本扣减：budget −= upstreamCost（结算后；无守卫——真实成本必须入账，可负穿）；
   * 余额 ≤ 阈值 → 熔断 status=3（仅启用态）。返回是否触发熔断。
   */
  async deductBudgetAndMaybeBreak(
    c: RepoContext,
    input: { channelId: number; upstreamCost: string; now: Date },
  ): Promise<boolean> {
    const rows = await tx(c)
      .update(channels)
      .set({ upstreamBudget: sql`${channels.upstreamBudget} - ${input.upstreamCost}::numeric`, updatedAt: input.now })
      .where(eq(channels.id, input.channelId))
      // 熔断判定放 SQL 侧（numeric 精确比较）——drizzle returning 的 numeric 是 string，
      // JS 侧 `<=` 为字典序（'9' <= '10' 为 false——10~99 元区间熔断失灵）
      .returning({
        broken: sql<boolean>`(${channels.upstreamBudget} <= coalesce(${channels.upstreamThreshold}, 0))`,
      });
    const row = rows[0];
    if (!row) return false;
    if (row.broken) {
      await tx(c)
        .update(channels)
        .set({ status: 3, updatedAt: input.now })
        .where(sql`${channels.id} = ${input.channelId} and ${channels.status} = 0`);
      return true;
    }
    return false;
  }

  async insertRecharge(
    c: RepoContext,
    values: {
      channelId: number;
      type: 'recharge' | 'adjust';
      amount: string;
      balanceAfter: string;
      orderNo?: string | null;
      voucher?: string | null;
      remark?: string | null;
      adminId: number;
    },
  ): Promise<number> {
    const [row] = await tx(c)
      .insert(channelRecharges)
      .values(values)
      .returning({ id: channelRecharges.id });
    if (!row) throw new Error('channel.insert_recharge_failed');
    return row.id;
  }

  // ── 管理面 CRUD ────────────────────────────────────────────────────────────
  // 返回形状永不包含 apiKeyEnc（密文也不出库）；明文只在服务层加密前/解密后内存存在。

  /** 管理列表行的安全列集（含供应商名；不含 apiKeyEnc） */
  async insertChannel(
    c: RepoContext,
    input: {
      providerId: number;
      name: string;
      apiKeyEnc: string;
      baseUrlOverride?: string | null;
      models?: string[] | null;
      weight?: number;
      priority?: number;
      rpmLimit?: number | null;
      tpmLimit?: number | null;
      upstreamBudget?: string;
      status?: number;
    },
  ): Promise<{ id: number; name: string; providerId: number }> {
    const [row] = await c.db
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
  }

  async findChannelByName(
    c: RepoContext,
    name: string,
  ): Promise<{ id: number; rpmLimit: number | null } | null> {
    const [row] = await c.db
      .select({ id: channels.id, rpmLimit: channels.rpmLimit })
      .from(channels)
      .where(eq(channels.name, name));
    return row ?? null;
  }

  /** 部分更新（白名单字段；apiKeyEnc 由服务层加密后传入）。0 行 = 不存在 */
  async updateChannel(
    c: RepoContext,
    input: {
      channelId: number;
      patch: {
        name?: string;
        apiKeyEnc?: string;
        baseUrlOverride?: string | null;
        models?: string[] | null;
        weight?: number;
        priority?: number;
        status?: number;
        rpmLimit?: number | null;
        tpmLimit?: number | null;
        upstreamThreshold?: string | null;
        cooldownUntil?: Date | null;
      };
    },
  ): Promise<{ id: number; name: string; status: number; failCount: number } | null> {
    const rows = await c.db
      .update(channels)
      .set({ ...input.patch, updatedAt: new Date() })
      .where(eq(channels.id, input.channelId))
      .returning({
        id: channels.id,
        name: channels.name,
        status: channels.status,
        failCount: channels.failCount,
      });
    return rows[0] ?? null;
  }

  /** 软退役：status=1（历史绑定/流水保留） */
  async retireChannel(c: RepoContext, input: { channelId: number }): Promise<boolean> {
    const rows = await c.db
      .update(channels)
      .set({ status: 1, updatedAt: new Date() })
      .where(eq(channels.id, input.channelId))
      .returning({ id: channels.id });
    return rows.length > 0;
  }

  /** 单渠道连接信息（探针 /test 用：join provider；含密文——仅服务层解密用） */
  async findChannelForProbe(c: RepoContext, channelId: number): Promise<{
    channelId: number;
    channelName: string;
    apiKeyEnc: string;
    baseUrlOverride: string | null;
    providerBaseUrl: string;
    providerProtocol: string;
  } | null> {
    const [row] = await c.db
      .select({
        channelId: channels.id,
        channelName: channels.name,
        apiKeyEnc: channels.apiKeyEnc,
        baseUrlOverride: channels.baseUrlOverride,
        providerBaseUrl: providers.baseUrl,
        providerProtocol: providers.protocol,
        providerVendor: providers.vendor,
      })
      .from(channels)
      .innerJoin(providers, eq(channels.providerId, providers.id))
      .where(eq(channels.id, channelId));
    return row ?? null;
  }

  /** 统一列表：q 命中渠道名/供应商名（join 表计数同步——防 42P01 500 类） */
  async listChannels(
    c: RepoContext,
    input: {
      q?: string;
      sortBy: 'id' | 'name' | 'status' | 'priority' | 'createdAt';
      order: 'asc' | 'desc';
      limit: number;
      offset: number;
    },
  ): Promise<{
    rows: Array<{
      id: number;
      name: string;
      providerId: number;
      providerName: string;
      baseUrlOverride: string | null;
      models: string[] | null;
      weight: number;
      priority: number;
      status: number;
      failCount: number;
      rpmLimit: number | null;
      tpmLimit: number | null;
      upstreamBudget: string;
      upstreamThreshold: string | null;
      createdAt: Date;
    }>;
    total: number;
  }> {
    const pattern = input.q ? escapeLikePattern(input.q) : null;
    const where = pattern
      ? or(ilike(channels.name, pattern), ilike(providers.name, pattern))
      : undefined;
    const sorts = {
      id: channels.id,
      name: channels.name,
      status: channels.status,
      priority: channels.priority,
      createdAt: channels.createdAt,
    } as const;
    const column = sorts[input.sortBy];
    const orderBy = [input.order === 'asc' ? asc(column) : desc(column), desc(channels.id)];
    const [rows, countRows] = await Promise.all([
      c.db
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
          createdAt: channels.createdAt,
        })
        .from(channels)
        .innerJoin(providers, eq(channels.providerId, providers.id))
        .where(where)
        .orderBy(...orderBy)
        .limit(input.limit)
        .offset(input.offset),
      c.db
        .select({ count: sql<number>`count(*)::int` })
        .from(channels)
        .innerJoin(providers, eq(channels.providerId, providers.id))
        .where(where),
    ]);
    return { rows, total: countRows[0]?.count ?? 0 };
  }

  /** 页内渠道的已绑定模型（外部名；绑定时同步落 model_mappings） */
  async listBoundModelsByChannelIds(
    c: RepoContext,
    channelIds: readonly number[],
  ): Promise<Array<{ channelId: number; externalName: string }>> {
    if (channelIds.length === 0) return [];
    return c.db
      .select({ channelId: modelChannels.channelId, externalName: modelMappings.externalName })
      .from(modelChannels)
      .innerJoin(modelMappings, eq(modelChannels.mappingId, modelMappings.id))
      .where(inArray(modelChannels.channelId, [...channelIds]));
  }

  /** 页内渠道的上游累计消耗（已结算口径；缺省 '0'） */
  async sumUpstreamConsumedByChannelIds(
    c: RepoContext,
    channelIds: readonly number[],
  ): Promise<Map<number, string>> {
    if (channelIds.length === 0) return new Map();
    const rows = await c.db
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
  }

  /** 渠道资金流水列表：q 命中 单号/备注/渠道名（join channels；leftJoin admins 带操作人） */
  async listRecharges(
    c: RepoContext,
    input: {
      q?: string;
      channelId?: number;
      type?: 'recharge' | 'adjust';
      sortBy: 'id' | 'amount' | 'createdAt';
      order: 'asc' | 'desc';
      limit: number;
      offset: number;
    },
  ): Promise<{
    rows: Array<{
      id: number;
      channelId: number;
      channelName: string;
      type: string;
      amount: string;
      balanceAfter: string;
      orderNo: string | null;
      voucher: string | null;
      remark: string | null;
      /** 操作管理员（左连接——管理员被删则 null，历史流水保留） */
      adminId: number | null;
      adminEmail: string | null;
      adminDisplayName: string | null;
      createdAt: Date;
    }>;
    total: number;
  }> {
    const conditions = [];
    if (input.q) {
      const pattern = escapeLikePattern(input.q);
      conditions.push(
        or(
          ilike(channelRecharges.orderNo, pattern),
          ilike(channelRecharges.remark, pattern),
          ilike(channels.name, pattern),
        )!,
      );
    }
    if (input.channelId !== undefined) conditions.push(eq(channelRecharges.channelId, input.channelId));
    if (input.type !== undefined) conditions.push(eq(channelRecharges.type, input.type));
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const sorts = {
      id: channelRecharges.id,
      amount: channelRecharges.amount,
      createdAt: channelRecharges.createdAt,
    } as const;
    const column = sorts[input.sortBy];
    const orderBy = [input.order === 'asc' ? asc(column) : desc(column), desc(channelRecharges.id)];
    const selection = {
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
    };
    const [rows, countRows] = await Promise.all([
      c.db
        .select(selection)
        .from(channelRecharges)
        .innerJoin(channels, eq(channelRecharges.channelId, channels.id))
        .leftJoin(admins, eq(channelRecharges.adminId, admins.id))
        .where(where)
        .orderBy(...orderBy)
        .limit(input.limit)
        .offset(input.offset),
      c.db
        .select({ count: sql<number>`count(*)::int` })
        .from(channelRecharges)
        .innerJoin(channels, eq(channelRecharges.channelId, channels.id))
        .where(where),
    ]);
    return { rows, total: countRows[0]?.count ?? 0 };
  }
}
