import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import type { Db } from '@ai-gateway/db';
import { notificationChannels, notifyOutbox, referrals, usageLogs } from '@ai-gateway/db/schema';
import type { Wallet } from '@ai-gateway/wallet';
import { createDomainOperations } from '@ai-gateway/ledger/platform';
import type { Logger } from '@ai-gateway/core';

/**
 * worker 定时任务（C3 佣金日结 + C4 告警投递；S7 重写：佣金走 wallet.credit）。
 *
 * runReferralCommission：昨日 usage_logs（status=0）按邀请人聚合 × 佣金比例 →
 * wallet.credit（operationId=referral-commission:{inviterId}:{yyyyMMdd} 按日幂等，
 * ledger-core 操作行双保险）。
 *
 * runNotifyDispatch：轮询 notify_outbox 未投递行 → 按渠道 events 过滤 →
 * webhook POST + HMAC-SHA256 签名头（时间戳防重放）/ 邮件；指数退避重试 3 次
 * 后标 failed（sent_at 置时间——终态不再扫描）。
 */

export async function runReferralCommissionOnce(
  db: Db,
  wallet: Wallet,
  opts: { commissionRate: number; now?: Date },
): Promise<{ credited: number }> {
  const operations = createDomainOperations(db, ['promo.referral_commission']);
  const now = opts.now ?? new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const dayKey = dayStart.toISOString().slice(0, 10).replace(/-/g, '');
  if (opts.commissionRate <= 0) return { credited: 0 };

  // 昨日有效消费按邀请人聚合（referrals 有效 + 被邀请人消费额）
  const rows = await db
    .select({
      inviterId: referrals.inviterUserId,
      total: sql<string>`coalesce(sum(${usageLogs.amount}), 0)`,
    })
    .from(usageLogs)
    .innerJoin(referrals, eq(referrals.inviteeUserId, usageLogs.userId))
    .where(
      and(
        eq(usageLogs.status, 0),
        eq(referrals.status, 0),
        gte(usageLogs.createdAt, dayStart),
        lt(usageLogs.createdAt, dayEnd),
      ),
    )
    .groupBy(referrals.inviterUserId);

  let credited = 0;
  for (const row of rows) {
    const amount = Number(row.total) * opts.commissionRate;
    if (amount <= 0) continue;
    await operations
      .run({
        operationId: `referral-commission:${row.inviterId}:${dayKey}`,
        kind: 'promo.referral_commission',
        fingerprint: { kind: 'promo.referral_commission', userId: row.inviterId, dayKey },
        execute: async (tx) => {
          await wallet.credit({
            userId: row.inviterId,
            amount: amount.toFixed(6),
            refType: 'promo',
            refId: `referral-commission:${row.inviterId}:${dayKey}`,
            memo: `邀请佣金（${dayKey}）+${amount.toFixed(6)}`,
            tx: tx as unknown as import('@ai-gateway/wallet').DbLike,
          });
          return { credited: amount.toFixed(6), inviterId: row.inviterId, dayKey };
        },
      })
      .then(() => {
        credited += 1;
      })
      .catch(() => undefined); // 幂等冲突（当日已结）静默
  }
  return { credited };
}

/** NOTIFY_EVENTS 词表（入箱/订阅过滤单一真相） */
export const NOTIFY_EVENTS = [
  'channel_disabled',
  'reconcile_discrepancy',
  'billing_dead',
  'balance_low',
] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

export async function runNotifyDispatchOnce(
  db: Db,
  logger: Logger,
  mailer?: { send(to: string, subject: string, text: string): Promise<void> },
): Promise<{ sent: number; failed: number }> {
  const channels = await db.query.notificationChannels.findMany({
    where: eq(notificationChannels.status, 0),
  });
  if (channels.length === 0) return { sent: 0, failed: 0 };

  const pending = await db
    .select()
    .from(notifyOutbox)
    .where(sql`${notifyOutbox.sentAt} is null and ${notifyOutbox.attempts} < 3`)
    .orderBy(notifyOutbox.id)
    .limit(50);

  let sent = 0;
  let failed = 0;
  for (const item of pending) {
    const matched = channels.filter((ch) => ch.events.includes(item.event));
    if (matched.length === 0) {
      // 无订阅渠道：终态化（不再重扫）
      await db.update(notifyOutbox).set({ sentAt: new Date() }).where(eq(notifyOutbox.id, item.id));
      continue;
    }
    let allOk = true;
    for (const ch of matched) {
      const ok = await deliver(ch.type, ch.config, item.event, item.payload, logger, mailer).catch(() => false);
      if (!ok) allOk = false;
    }
    if (allOk) {
      await db.update(notifyOutbox).set({ sentAt: new Date(), attempts: item.attempts + 1 }).where(eq(notifyOutbox.id, item.id));
      sent += 1;
    } else {
      const attempts = item.attempts + 1;
      await db
        .update(notifyOutbox)
        .set({
          attempts,
          lastError: 'delivery failed',
          ...(attempts >= 3 ? { sentAt: new Date() } : {}), // 达上限：终态 failed（sentAt 置时间）
        })
        .where(eq(notifyOutbox.id, item.id));
      failed += 1;
    }
  }
  return { sent, failed };
}

async function deliver(
  type: string,
  config: Record<string, unknown>,
  event: string,
  payload: Record<string, unknown>,
  logger: Logger,
  mailer?: { send(to: string, subject: string, text: string): Promise<void> },
): Promise<boolean> {
  if (type === 'webhook') {
    const url = typeof config.url === 'string' ? config.url : '';
    const secret = typeof config.secret === 'string' ? config.secret : '';
    if (!url) return false;
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ event, timestamp, payload });
    const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-notify-event': event,
        'x-notify-timestamp': String(timestamp),
        'x-notify-signature': signature,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) logger.warn({ status: res.status, event }, 'webhook deliver failed');
    return res.ok;
  }
  if (type === 'email') {
    const recipients = Array.isArray(config.recipients)
      ? (config.recipients as unknown[]).filter((r): r is string => typeof r === 'string')
      : [];
    if (recipients.length === 0 || !mailer) return false; // SMTP 未配置 fail-closed
    const subject = `[AI Gateway] 告警：${event}`;
    const text = `${event}
${JSON.stringify(payload, null, 2)}`;
    await Promise.all(recipients.map((to) => mailer.send(to, subject, text)));
    return true;
  }
  return false;
}
