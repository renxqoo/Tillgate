/**
 * ChannelStore port：渠道配置与运营资金的持久化边界。
 * 表族 = 聚合：channels（预算/敞口）与 channel_recharges（其账本流水）是渠道运营资金
 * 的不可分单元。守卫内联 UPDATE WHERE，并发超扣在结构上不可达（v1 语义）。
 * 热路径族（路由候选/死凭据/敞口守卫/成本扣减）不在此——归 inference 波次（G1）；
 * 任务渠道读（findTaskChannel，worker 波轮询的上游凭据源）例外在此。
 * 返回形状永不包含 apiKeyEnc 之外的密钥事实；管理面返回不含密文（探针专用读除外）。
 */
import type { DbLike } from '@tokenlens/db';
import type { ListQuery, ListResult } from '../domain/list';
import type { ChannelPatchInput } from '../domain/channel/channel';

/** 渠道管理面行（join 供应商名；不含 apiKeyEnc——密文不出库） */
export interface ChannelListRow {
  readonly id: number;
  readonly name: string;
  readonly providerId: number;
  readonly providerName: string;
  readonly baseUrlOverride: string | null;
  readonly models: string[] | null;
  readonly weight: number;
  readonly priority: number;
  readonly status: number;
  readonly failCount: number;
  readonly rpmLimit: number | null;
  readonly tpmLimit: number | null;
  readonly upstreamBudget: string;
  readonly upstreamThreshold: string | null;
  readonly createdAt: Date;
}

/** 渠道资金面行（进货/调账用例的余额与敞口事实） */
export interface ChannelFundsRow {
  readonly id: number;
  readonly upstreamBudget: string;
  readonly upstreamReserved: string;
  readonly upstreamThreshold: string | null;
  readonly status: number;
}


/** 网关路由候选行（G1，gateway P5 波；v1 findRouteCandidates 语义）：启用渠道 + 密文 + 调度权重 */
export interface RouteCandidateRow {
  readonly channelId: number;
  readonly channelName: string;
  readonly apiKeyEnc: string;
  readonly baseUrlOverride: string | null;
  readonly providerName: string;
  readonly providerBaseUrl: string;
  readonly providerProtocol: string;
  readonly providerVendor: string | null;
  readonly priority: number;
  readonly weight: number;
  readonly rpmLimit: number | null;
  readonly tpmLimit: number | null;
  readonly upstreamBudget: string;
}

/** 探针专用读（含密文——仅 application 解密用，返回面不回传） */
export interface ChannelProbeRow {
  readonly channelId: number;
  readonly channelName: string;
  readonly apiKeyEnc: string;
  readonly baseUrlOverride: string | null;
  readonly providerBaseUrl: string;
  readonly providerProtocol: string;
}

export interface RechargeRow {
  readonly id: number;
  readonly channelId: number;
  readonly channelName: string;
  readonly type: string;
  readonly amount: string;
  readonly balanceAfter: string;
  readonly orderNo: string | null;
  readonly voucher: string | null;
  readonly remark: string | null;
  /** 操作管理员（左连接——管理员被删则 null，历史流水保留） */
  readonly adminId: number | null;
  readonly adminEmail: string | null;
  readonly adminDisplayName: string | null;
  readonly createdAt: Date;
}

export type ChannelSortField = 'id' | 'name' | 'status' | 'priority' | 'createdAt';
export type RechargeSortField = 'id' | 'amount' | 'createdAt';

export interface ChannelStore {
  insertChannel(
    db: DbLike,
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
  ): Promise<{ id: number; name: string; providerId: number }>;
  findChannelByName(
    db: DbLike,
    name: string,
  ): Promise<{ id: number; rpmLimit: number | null } | null>;
  /** 部分更新（白名单字段；apiKeyEnc/运行态复位由 application 组好传入）。0 行 = 不存在 */
  updateChannel(
    db: DbLike,
    input: {
      channelId: number;
      patch: Omit<ChannelPatchInput, 'apiKey' | 'upstreamThreshold'> & {
        apiKeyEnc?: string;
        status?: number;
        failCount?: number;
        cooldownUntil?: Date | null;
        upstreamThreshold?: string | null;
      };
    },
  ): Promise<{ id: number; name: string; status: number; failCount: number } | null>;
  /** 软退役：status=1（历史绑定/流水保留） */
  retireChannel(db: DbLike, input: { channelId: number }): Promise<boolean>;
  /** 单渠道连接信息（探针用：join provider；含密文——仅 application 解密用） */
  findChannelForProbe(db: DbLike, channelId: number): Promise<ChannelProbeRow | null>;
  /** 渠道资金面行（进货/调账的存在性与余额事实） */
  findChannelFunds(db: DbLike, channelId: number): Promise<ChannelFundsRow | null>;
  /** 统一列表：q 命中渠道名/供应商名（join 表计数同步） */
  listChannels(db: DbLike, query: ListQuery<ChannelSortField>): Promise<ListResult<ChannelListRow>>;
  /** 页内渠道的已绑定模型（外部名；绑定时同步落 model_mappings） */
  listBoundModelsByChannelIds(
    db: DbLike,
    channelIds: readonly number[],
  ): Promise<Array<{ channelId: number; externalName: string }>>;
  /** 页内渠道的上游累计消耗（已结算口径；跨域只读 usage_logs 聚合——billing 波次后改经 facade） */
  sumUpstreamConsumedByChannelIds(
    db: DbLike,
    channelIds: readonly number[],
  ): Promise<Map<number, string>>;

  // ── 运营资金（守卫原子 UPDATE；调用方持事务） ──────────────────────────────

  /** 进货：budget += amount（正数）；熔断(3)自动复活为启用(0)；返回新余额。0 行 = 渠道不存在 */
  rechargeBudget(
    db: DbLike,
    input: { channelId: number; amount: string; now: Date },
  ): Promise<string>;
  /** 调账：budget += amount（可负）；守卫 = 调后不得为负。ok:false = 守卫未过或渠道不存在 */
  tryAdjustBudget(
    db: DbLike,
    input: { channelId: number; amount: string; now: Date },
  ): Promise<{ ok: true; budget: string } | { ok: false }>;
  /** 流水行（余额历史投影；只追加） */
  insertRecharge(
    db: DbLike,
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
  ): Promise<number>;
  /** 流水列表：q 命中 单号/备注/渠道名（join channels；leftJoin admins 带操作人） */
  listRecharges(
    db: DbLike,
    query: ListQuery<RechargeSortField> & { channelId?: number; type?: 'recharge' | 'adjust' },
  ): Promise<ListResult<RechargeRow>>;
  // ---- 网关热路径读（G1，gateway P5 波） ----
  /**
   * 真实模型 → 路由候选渠道（启用 status=0；基序 priority/weight 降序——加权调度在
   * inference）。含渠道密文与渠道维限流/预算列（网关 admitChannel 消费）。
   */
  findRouteCandidates(db: DbLike, realModel: string): Promise<RouteCandidateRow[]>;
  /**
   * 单渠道连接信息（worker 波任务轮询/代执行的上游凭据源；v1 findTaskChannel
   * 语义）。by id 不按启用状态过滤——已提交任务所属渠道事后停用仍须可达。
   */
  findTaskChannel(db: DbLike, channelId: number): Promise<RouteCandidateRow | null>;
}
