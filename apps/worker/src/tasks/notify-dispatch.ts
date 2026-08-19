/**
 * 告警投递（v1 runNotifyDispatch 的 v2 移植）：轮询 notify_outbox 未投递行 →
 * 按渠道 events 过滤 → webhook POST + HMAC-SHA256 签名头（时间戳防重放）/ 邮件；
 * 指数退避重试 3 次后标 failed（sent_at 置时间——终态不再扫描）。
 *
 * v2 复活背景：v1 退役审计发现本循环未移植——channel_disabled / billing_dead /
 * balance_low / reconcile_discrepancy 全部静默堆积在 outbox，运营告警面为空。
 */
import { eq, sql } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import type { Db } from '@ai-gateway/repository';
import { notificationChannels, notifyOutbox } from '@ai-gateway/db';
import { decrypt } from '@ai-gateway/core';

export interface NotifyMailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

export async function runNotifyDispatchOnce(
  db: Db,
  logger: { warn(obj: unknown, msg: string): void },
  mailer?: NotifyMailer,
  options: { encryptionKey?: string } = {},
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
      const ok = await deliver(
        ch.type,
        (ch.config ?? {}) as Record<string, unknown>,
        item.event,
        (item.payload ?? {}) as Record<string, unknown>,
        logger,
        mailer,
        options,
      ).catch(() => false);
      if (!ok) allOk = false;
    }
    if (allOk) {
      await db
        .update(notifyOutbox)
        .set({ sentAt: new Date(), attempts: item.attempts + 1 })
        .where(eq(notifyOutbox.id, item.id));
      sent += 1;
    } else {
      const attempts = item.attempts + 1;
      await db
        .update(notifyOutbox)
        .set({
          attempts,
          lastError: 'delivery failed',
          ...(attempts >= 3 ? { sentAt: new Date() } : {}), // 达上限：终态 failed
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
  logger: { warn(obj: unknown, msg: string): void },
  mailer?: NotifyMailer,
  options: { encryptionKey?: string } = {},
): Promise<boolean> {
  if (type === 'webhook') {
    const url = typeof config.url === 'string' ? config.url : '';
    let secret = typeof config.secret === 'string' ? config.secret : '';
    if (!url) return false;
    // 落库密文解密（enc:v1 前缀；存量明文原样用——懒兼容，迁移脚本收口）
    if (secret.startsWith('enc:') && options.encryptionKey) {
      try {
        secret = decrypt(secret, options.encryptionKey);
      } catch {
        return false; // 解密失败 = 密钥轮换断层——该渠道不可投递（fail-closed）
      }
    }
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
    const text = `${event}\n${JSON.stringify(payload, null, 2)}`;
    await Promise.all(recipients.map((to) => mailer.send(to, subject, text)));
    return true;
  }
  return false;
}
