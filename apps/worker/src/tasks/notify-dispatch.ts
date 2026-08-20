/**
 * 告警投递（v1 runNotifyDispatch 的 v2 移植）：轮询 notify_outbox 未投递行 →
 * 按渠道 events 过滤 → webhook POST + HMAC-SHA256 签名头（时间戳防重放）/ 邮件；
 * 指数退避重试 3 次后标 failed（sent_at 置时间——终态不再扫描）。
 *
 * v2 复活背景：v1 退役审计发现本循环未移植——channel_disabled / billing_dead /
 * balance_low / reconcile_discrepancy 全部静默堆积在 outbox，运营告警面为空。
 */
import { createHmac, randomUUID } from 'node:crypto';
import { NotificationRepository, type Db } from '@ai-gateway/repository';
import { decrypt } from '@ai-gateway/core';
import { assertSafeUrl } from '@ai-gateway/ai';

export interface NotifyMailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

export async function runNotifyDispatchOnce(
  db: Db,
  logger: { warn(obj: unknown, msg: string): void },
  mailer?: NotifyMailer,
  options: {
    encryptionKey?: string;
    webhookAllowLocalUrl?: boolean;
    ownerId?: string;
    claimLeaseMs?: number;
    repository?: NotificationRepository;
  } = {},
): Promise<{ sent: number; failed: number }> {
  const repository = options.repository ?? new NotificationRepository();
  const ownerId = options.ownerId ?? `notify-${process.pid}-${randomUUID()}`;
  const claimLeaseMs = options.claimLeaseMs ?? 60_000;
  const context = {
    requestId: `notify-dispatch:${ownerId}`,
    actor: { kind: 'system' } as const,
    traceParent: null,
  };
  const channels = await repository.listActive({ db, ...context });

  let sent = 0;
  let failed = 0;
  for (let processed = 0; processed < 50; processed += 1) {
    // 一次只认领当前即将投递的一行，避免整批排队导致后排记录租约尚未执行就过期。
    const claimed = await db.transaction((tx) =>
      repository.claimPending(
        { db: tx, ...context },
        { ownerId, limit: 1, leaseMs: claimLeaseMs, maxAttempts: 3 },
      ),
    );
    const item = claimed[0];
    if (!item) break;
    const delivered = new Set(item.deliveredChannelIds);
    const matched = channels.filter((ch) => ch.events.includes(item.event) && !delivered.has(ch.id));
    if (matched.length === 0) {
      // 无订阅渠道：终态化（不再重扫）
      await db.transaction((tx) =>
        repository.completeClaim({ db: tx, ...context }, { id: item.id, ownerId, claimToken: item.claimToken }),
      );
      continue;
    }
    // 同一事件的渠道并行投递，使租约上界只受最慢渠道影响而非渠道数量线性累加。
    const outcomes = await Promise.all(
      matched.map((ch) =>
        deliver(
          `${item.id}:${ch.id}`,
          ch.type,
          ch.config,
          item.event,
          item.payload,
          logger,
          mailer,
          options,
        ).catch(() => false),
      ),
    );
    const succeededChannelIds = matched.filter((_, index) => outcomes[index]).map((channel) => channel.id);
    const progressRecorded = await db.transaction((tx) =>
      repository.recordDeliveredChannels(
        { db: tx, ...context },
        { id: item.id, ownerId, claimToken: item.claimToken, channelIds: succeededChannelIds },
      ),
    );
    if (!progressRecorded) {
      logger.warn({ outboxId: item.id, ownerId }, 'notify claim expired before progress recording');
      continue;
    }
    const allOk = outcomes.every(Boolean);
    if (allOk) {
      const completed = await db.transaction((tx) =>
        repository.completeClaim({ db: tx, ...context }, { id: item.id, ownerId, claimToken: item.claimToken }),
      );
      if (completed) sent += 1;
      else logger.warn({ outboxId: item.id, ownerId }, 'notify claim expired before completion');
    } else {
      const recorded = await db.transaction((tx) =>
        repository.failClaim(
          { db: tx, ...context },
          { id: item.id, ownerId, claimToken: item.claimToken, maxAttempts: 3, error: 'delivery failed' },
        ),
      );
      if (recorded) failed += 1;
      else logger.warn({ outboxId: item.id, ownerId }, 'notify claim expired before failure recording');
    }
  }
  return { sent, failed };
}

/** 单渠道投递（导出供 SSRF 硬门回归测试直击） */
export async function deliver(
  deliveryId: string | number,
  type: string,
  config: Record<string, unknown>,
  event: string,
  payload: Record<string, unknown>,
  logger: { warn(obj: unknown, msg: string): void },
  mailer?: NotifyMailer,
  options: { encryptionKey?: string; webhookAllowLocalUrl?: boolean } = {},
): Promise<boolean> {
  if (type === 'webhook') {
    const url = typeof config.url === 'string' ? config.url : '';
    let secret = typeof config.secret === 'string' ? config.secret : '';
    if (!url) return false;
    // SSRF 硬门（与 AI 上游 fetch 同一原语）：https-only + 私网/回环/metadata 段
    // 全拒 + DNS 逐地址判定防 rebinding——管理员配置的 webhook URL 不得成为
    // 内网探测跳板；dev/test 逃生门由装配层双门控制（生产恒 false）
    try {
      await assertSafeUrl(url, { allowLocal: options.webhookAllowLocalUrl === true });
    } catch (error) {
      logger.warn({ url, error: (error as Error).message }, 'webhook url blocked by ssrf guard');
      return false;
    }
    // webhook secret 只允许统一密文形态；缺密钥、明文存量或解密失败都 fail-closed。
    if (!secret.startsWith('enc:') || !options.encryptionKey) return false;
    try {
      secret = decrypt(secret, options.encryptionKey);
    } catch {
      return false;
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ event, timestamp, payload });
    const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-notify-delivery': String(deliveryId),
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
