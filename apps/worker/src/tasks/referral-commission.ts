/**
 * 邀请佣金日结：被邀请人已结算消费按邀请人求和 × 比例 → wallet.credit。
 * 幂等 = wallet 自然键（refType 'referral' + refId=referral-commission:{inviter}:{dayKey}
 * + kind credit 唯一）——多副本并发/同日重跑结构性只入一次，无需分布式锁。
 * refId 格式与 client-api 邀请概览的佣金前缀匹配（referral-commission:）保持一致。
 * 金额 = Decimal(合计) × rate 全精度（账本永不 round）。
 *
 * 窗口回补：每次跑最近 N 个 UTC 自然日（缺勤补算——幂等键保证已结算日零副作用）。
 * 只跑「昨日」的形态下，worker 停机跨过 D+2 窗口即永久丢失 D 日佣金。
 * 封禁邀请人停止派奖（与 client-api 注册奖励同口径：inviterActive）。
 */
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories } from '@ai-gateway/repository';
import { Decimal } from '@ai-gateway/domain';
import { systemContext, type RunContext, type WalletApi } from '@ai-gateway/service';

/** 每轮回补的自然日窗口数（幂等重算无副作用；覆盖一周内的停机缺口） */
const BACKFILL_DAYS = 7;

export interface ReferralCommissionDeps {
  db: Db;
  wallet: WalletApi;
  /**
   * 佣金比例（0–1；≤0 = 功能关闭直接返回）——每 tick 从 marketing_settings 读现值
   * （2026-08-21 env→DB 迁移：管理面改值下一 tick 生效，历史日不重算）。
   * 传 string 形态保留给测试注入固定值。
   */
  commissionRate: string | (() => Promise<string>);
  repos?: Repositories;
  ctx?: RunContext;
  now?: () => Date;
}

export async function runReferralCommissionOnce(
  deps: ReferralCommissionDeps,
): Promise<{ credited: number }> {
  const repos = deps.repos ?? createRepositories();
  const ctx = deps.ctx ?? systemContext('worker-referral');
  const now = deps.now ?? (() => new Date());
  // 每 tick 读现值（DB 回调形态）；string 形态为测试固定值
  const rawRate = typeof deps.commissionRate === 'function' ? await deps.commissionRate() : deps.commissionRate;
  // 费率防御：非法值崩的是整个佣金 loop 的 tick——记清晰错误后跳过本轮，下一 tick 仍可自愈
  let commissionRate: Decimal;
  try {
    commissionRate = new Decimal(rawRate);
  } catch (error) {
    console.error(`[referral] invalid commission rate (${String(rawRate)}), skip this tick:`, error);
    return { credited: 0 };
  }
  if (!commissionRate.greaterThan(0)) return { credited: 0 };

  // 窗口 = 最近 BACKFILL_DAYS 个「已完整结束的 UTC 自然日」（不含今天）
  const current = now();
  const todayStart = new Date(
    Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate()),
  );

  let credited = 0;
  for (let offset = BACKFILL_DAYS; offset >= 1; offset--) {
    const dayEnd = new Date(todayStart.getTime() - (offset - 1) * 86_400_000);
    const dayStart = new Date(dayEnd.getTime() - 86_400_000);
    const dayKey = dayStart.toISOString().slice(0, 10).replace(/-/g, '');

    const rows = await repos.referral.sumInviteeSpendByInviter(
      { db: deps.db, ...ctx },
      { from: dayStart, to: dayEnd },
    );

    for (const row of rows) {
      const amount = new Decimal(row.total).times(commissionRate);
      if (!amount.greaterThan(0)) continue;
      try {
        // 封禁/异常邀请人停发（漏一天可由重跑补——封禁解除后窗口内的份额自动补齐）
        const inviterActive = await repos.referral.inviterActive({ db: deps.db, ...ctx }, row.inviterId);
        if (!inviterActive) continue;
        const result = await deps.wallet.credit(ctx, {
          userId: row.inviterId,
          amount: amount.toString(),
          refType: 'referral',
          refId: `referral-commission:${row.inviterId}:${dayKey}`,
          memo: `邀请佣金（${dayKey}）+${amount.toString()}`,
        });
        // wallet 同键同命令 = 重放成功（非新入账）——只计新入账
        if (!result.replayed) credited += 1;
      } catch (error) {
        // 异键冲突等异常：跳过（下一轮/他副本按同一自然键收敛）——但必须留下排查线索
        console.error(`[referral] commission credit failed inviter=${row.inviterId} day=${dayKey}:`, error);
      }
    }
  }
  return { credited };
}
