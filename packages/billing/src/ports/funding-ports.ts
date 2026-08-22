/**
 * 计费链路的协作 port（总纲 §5.2：跨能力事实由消费方定义 port、装配注入）：
 *   FundingSourceResolver  凭证 → 订阅绑定/转按量开关/每日限额（accounts/identity 侧事实，
 *                           app assembly 桥接实现；billing 不回查 accounts 内部对象）
 *   SubscriptionQuotaStore 订阅额度三原语 + 快照/成员限额（user_subscriptions/org_members；
 *                           订阅能力归 billing——U4 application/subscriptions 同域）
 *   ChannelExposureStore   渠道进货额度敞口（channels 表的守卫原子 UPDATE 族）
 */
import type { WalletConn } from './wallet-store.js';

/** 凭证解析结果（authorize 一次查出注入瀑布——策略不重复查库，§3.10） */
export interface ResolvedFundingSource {
  subscriptionId: number | null;
  /** api_keys.allow_payg_fallback（App JWT 恒 false） */
  allowPaygFallback: boolean;
  userDailyLimit: string | null;
  keyDailyLimit: string | null;
}

export interface FundingSourceResolver {
  resolve(
    conn: WalletConn,
    input: { userId: number; apiKeyId: number | null; appId: number | null },
  ): Promise<ResolvedFundingSource>;
}

/** 订阅快照（subscription-source probe 的闸门输入） */
export interface SubscriptionSnapshot {
  userId: number;
  orgId: number | null;
  quotaAmount: string;
  usedAmount: string;
  reservedAmount: string;
}

export interface SubscriptionQuotaStore {
  /** 有效订阅快照（无/到期为 null） */
  activeSubscriptionSnapshot(
    conn: WalletConn,
    subscriptionId: number,
    now: Date,
  ): Promise<SubscriptionSnapshot | null>;
  /** org 成员限额（非成员为 null） */
  memberLimits(
    conn: WalletConn,
    input: { orgId: number; userId: number },
  ): Promise<{ dailySpendLimit: string | null; monthlyQuota: string | null } | null>;
  /** reserved += amount WHERE 有效且余量足；输家 'exhausted' / 失效 'inactive' */
  tryReserveQuota(
    tx: WalletConn,
    input: { subscriptionId: number; amount: string },
  ): Promise<'ok' | 'exhausted' | 'inactive'>;
  /** reserved −= amount WHERE 足额；0 行 = 在途事实脱节 */
  tryReleaseQuota(
    tx: WalletConn,
    input: { subscriptionId: number; reserved: string },
  ): Promise<boolean>;
  /** reserved −= r, used += c WHERE 守卫（核销预留内份额） */
  trySettleQuota(
    tx: WalletConn,
    input: { subscriptionId: number; reserved: string; consumed: string },
  ): Promise<boolean>;
}

export interface ChannelExposureStore {
  findChannel(
    conn: WalletConn,
    channelId: number,
  ): Promise<{ upstreamBudget: string; upstreamReserved: string } | null>;
  /** reserved += delta WHERE 余量足（守卫原子 UPDATE）；false = 预算不足/并发占走 */
  tryIncreaseReserved(
    tx: WalletConn,
    input: { channelId: number; delta: string; now: Date },
  ): Promise<{ budget: string; reserved: string } | null>;
  /** reserved −= amount WHERE 足额（防二次释放偷走他人敞口） */
  tryDecreaseReserved(
    tx: WalletConn,
    input: { channelId: number; amount: string; now: Date },
  ): Promise<boolean>;
  /** budget −= upstreamCost（无守卫——真实成本必须入账可负穿）；余额 ≤ 阈值 → 熔断（仅启用态） */
  deductBudgetAndMaybeBreak(
    tx: WalletConn,
    input: { channelId: number; upstreamCost: string; now: Date },
  ): Promise<boolean>;
}
