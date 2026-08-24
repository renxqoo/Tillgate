/**
 * 邀请佣金日结用例（v1 apps/worker tasks/referral-commission.ts 迁移，语义不变）：
 * 被邀请人已结算消费按邀请人求和 × 比例 → wallet.credit。
 *
 * 幂等 = wallet 自然键（refType 'referral' + refId referral-commission:{inviter}:{yyyyMMdd}
 * + kind credit 唯一）——多副本并发/同日重跑结构性只入一次，无需分布式锁。
 * 金额 = floor(合计 × rate, 18 位小数)（DESIGN §2.2 第 6 条：派生支付额跨落库
 * 边界显式收敛——全精度乘积超 18 位小数会被 out_of_scale 永久拒绝）。
 *
 * 窗口回补：每轮跑最近 backfillDays 个「完整结束的 UTC 自然日」（缺勤补算——
 * 幂等键保证已结算日零副作用）。只跑「昨日」的形态下，worker 停机跨过 D+2
 * 窗口即永久丢失 D 日佣金。rate ≤ 0 = 功能关闭直接返回；非法 rate 记错误跳过
 * 本轮（下一 tick 自愈）。费率与幂等键词表的单一真相在 accounts domain
 * （marketing_settings / commissionRefId）——本包不依赖 accounts，经装配注入。
 */
import { Decimal } from '../domain/money.js';
import { commissionCreditAmount } from '../domain/commission.js';
import type { CommissionStatsStore } from '../ports/commission-stats.js';

/** 佣金入账所需的 wallet 动词窄面（装配注入 wallet facade） */
export interface CommissionWallet {
  credit(input: {
    userId: number;
    amount: string;
    refType: string;
    refId: string;
    memo?: string;
  }): Promise<{ replayed: boolean }>;
}

export interface ReferralCommissionDeps {
  stats: CommissionStatsStore;
  wallet: CommissionWallet;
  /** 佣金比例（0–1 字符串；每 tick 由调用方读 marketing_settings 现值） */
  rate: () => Promise<string>;
  /** 幂等键（accounts commissionRefId 词表——(inviterId, yyyyMMdd) → refId） */
  refIdOf: (inviterId: number, utcDayKey: string) => string;
  /** 回补窗口（完整 UTC 自然日数；v1 BACKFILL_DAYS=7 的装配注入形态） */
  backfillDays: number;
  /** 时钟（装配必填——窗口计算不读系统时钟，铁律 3） */
  clock: () => Date;
  /** 单行入账异常的记录口（跳过不中断——下一轮/他副本按同一自然键收敛） */
  onError: (error: unknown, context: string) => void;
}

export interface ReferralCommissionResult {
  /** 新入账笔数（同键重放不计） */
  credited: number;
}

const DAY_MS = 86_400_000;

/** yyyyMMdd（UTC 自然日键——与 accounts commissionRefId 词表同格式） */
function dayKeyOf(dayStart: Date): string {
  return dayStart.toISOString().slice(0, 10).replace(/-/g, '');
}

export function createReferralCommissionUseCase(deps: ReferralCommissionDeps) {
  return async function runReferralCommission(): Promise<ReferralCommissionResult> {
    // 费率防御：非法值崩的是整个佣金 tick——记清晰错误后跳过本轮，下一 tick 自愈
    let rate: Decimal;
    try {
      rate = new Decimal(await deps.rate());
    } catch (error) {
      deps.onError(error, 'referral commission rate unreadable, skip this tick');
      return { credited: 0 };
    }
    if (!rate.greaterThan(0)) return { credited: 0 };

    const now = deps.clock();
    const todayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );

    let credited = 0;
    for (let offset = deps.backfillDays; offset >= 1; offset--) {
      const dayEnd = new Date(todayStart.getTime() - (offset - 1) * DAY_MS);
      const dayStart = new Date(dayEnd.getTime() - DAY_MS);
      const dayKey = dayKeyOf(dayStart);
      const rows = await deps.stats.sumInviteeSpendByInviter({ from: dayStart, to: dayEnd });
      for (const row of rows) {
        // 派生支付额显式收敛（floor 18dp）——全精度乘积会撞 out_of_scale 永久拒绝
        const amount = commissionCreditAmount(row.total, rate.toString());
        if (!amount.greaterThan(0)) continue;
        try {
          const result = await deps.wallet.credit({
            userId: row.inviterId,
            amount: amount.toString(),
            refType: 'referral',
            refId: deps.refIdOf(row.inviterId, dayKey),
            memo: `邀请佣金（${dayKey}）+${amount.toString()}`,
          });
          // wallet 同键同命令 = 重放成功（非新入账）——只计新入账
          if (!result.replayed) credited += 1;
        } catch (error) {
          deps.onError(error, `referral commission credit inviter=${row.inviterId} day=${dayKey}`);
        }
      }
    }
    return { credited };
  };
}
