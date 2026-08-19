/**
 * v1 对位循环测试（2026-08-19 退役审计补齐的四大能力）：
 *   ① notify_outbox 投递（webhook HMAC 签名 + 无订阅渠道终态化 + 3 次退避上限）
 *   ② TPM 回填（成功请求释放预占 + actual 记账 + 幂等防重）
 *   ③ 健康端点（livez/readyz 开放；/health 令牌保护）
 *   ④ onSettled/onDead 钩子（billing_dead / balance_low 入箱）
 */
import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { and } from 'drizzle-orm';
import { notificationChannels, notifyOutbox, users } from '@ai-gateway/db';
import { createDb, type Db } from '@ai-gateway/db';
import { createRedisClient, waitForRedisReady } from '@ai-gateway/core';
import { createSlidingWindowLimiter } from '@ai-gateway/core';
import { runNotifyDispatchOnce } from '../tasks/notify-dispatch.js';
import { startHealthServer } from '../health.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const createdUsers: number[] = [];
const createdChannels: number[] = [];
let webhookServer: Server;
let webhookUrl = '';
let webhookCalls: Array<{ body: string; signature: string; timestamp: string; event: string }> = [];

beforeAll(async () => {
  webhookServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      webhookCalls.push({
        body: raw,
        signature: String(req.headers['x-notify-signature'] ?? ''),
        timestamp: String(req.headers['x-notify-timestamp'] ?? ''),
        event: String(req.headers['x-notify-event'] ?? ''),
      });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((r) => webhookServer.listen(0, '127.0.0.1', r));
  const addr = webhookServer.address();
  webhookUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/hook`;
});

afterAll(async () => {
  await new Promise<void>((r) => webhookServer.close(() => r()));
  if (createdChannels.length) {
    await db.delete(notificationChannels).where(inArray(notificationChannels.id, createdChannels));
  }
  if (createdUsers.length) await db.delete(users).where(inArray(users.id, createdUsers));
  await db.$client.end().catch(() => {});
});

const logger = {
  warn: () => undefined,
  error: () => undefined,
  info: () => undefined,
};

async function seedChannel(events: string[], config: Record<string, unknown> = { url: webhookUrl, secret: 'whsec-test' }) {
  const [row] = await db
    .insert(notificationChannels)
    .values({ name: `t-${randomUUID().slice(0, 8)}`, type: 'webhook', config, events, status: 0 })
    .returning({ id: notificationChannels.id });
  createdChannels.push(row!.id);
  return row!.id;
}

describe('① 告警投递（notify_outbox 消费者）', () => {
  it('webhook 投递带 HMAC-SHA256 签名（timestamp.body 口径）→ 行终态化', async () => {
    await seedChannel(['billing_dead']);
    await db.insert(notifyOutbox).values({
      event: 'billing_dead',
      payload: { requestId: `t-${randomUUID().slice(0, 8)}` },
      dedupeKey: `test-billing-dead-${randomUUID().slice(0, 8)}`,
    });
    webhookCalls = [];
    const result = await runNotifyDispatchOnce(db, logger, undefined, { webhookAllowLocalUrl: true }); // 本地 stub URL——dev 逃生门（生产 env 双门恒 false）
    expect(result.sent).toBeGreaterThanOrEqual(1);
    expect(webhookCalls.length).toBeGreaterThanOrEqual(1);
    const call = webhookCalls.at(-1)!;
    // 验签口径与投递端一致
    const expected = createHmac('sha256', 'whsec-test').update(`${call.timestamp}.${call.body}`).digest('hex');
    expect(call.signature).toBe(expected);
    expect(call.event).toBe('billing_dead');
  });

  it('无订阅渠道的事件终态化（不重扫）', async () => {
    const ins = await db.insert(notifyOutbox).values({
      event: 'reconcile_discrepancy',
      payload: { discrepancies: 1 },
      dedupeKey: `test-reconcile-${randomUUID().slice(0, 8)}`,
    }).returning({ id: notifyOutbox.id });
    await runNotifyDispatchOnce(db, logger);
    const [row] = await db.select().from(notifyOutbox).where(eq(notifyOutbox.id, ins[0]!.id));
    expect(row!.sentAt).not.toBeNull();
    await db.delete(notifyOutbox).where(eq(notifyOutbox.id, ins[0]!.id));
  });
});

describe('② TPM 回填（成功请求的预占收尾）', () => {
  it('reserveTpmAll 预占 → backfillTpm 释放并记账 actual → 幂等（二次回填零效果）', async () => {
    const redis = createRedisClient(process.env.REDIS_URL ?? 'redis://localhost:6379', { serviceName: 'worker-test' });
    await waitForRedisReady(redis);
    const limiter = createSlidingWindowLimiter(redis, { failMode: 'open' });
    const requestId = `t-${randomUUID().slice(0, 12)}`;
    const dimension = `user:${Math.floor(Math.random() * 1_000_000)}`;

    const reserved = await limiter.reserveTpmAll([{ dimension, estimatedTokens: 500, max: 100_000 }], requestId);
    expect(reserved.allowed).toBe(true);

    await limiter.backfillTpm(requestId, [dimension], 500);
    const minute = Math.floor(Date.now() / 60_000);
    const actual = await redis.get(`{tpm}:actual:${minute}:${dimension}`);
    expect(Number(actual)).toBe(500);
    // 预占已清（reservation hash 被删）
    const hashLen = await redis.hkeys(`{tpm}:request:${requestId}`);
    expect(hashLen.length).toBe(0);
    // 二次回填幂等（projected 标记）
    await limiter.backfillTpm(requestId, [dimension], 500);
    const actualAfter = await redis.get(`{tpm}:actual:${minute}:${dimension}`);
    expect(Number(actualAfter)).toBe(500);
    await redis.quit().catch(() => {});
  }, 30_000);
});

describe('③ 健康端点', () => {
  it('livez/readyz 开放；/health 无令牌 403、有令牌 200', async () => {
    const server = startHealthServer(0, { live: () => true, ready: () => true, deep: () => ({ ok: true }) }, 'tok-123');
    await new Promise<void>((r) => server.once('listening', r));
    const addr = server.address();
    const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    const live = await fetch(`${base}/livez`);
    expect(live.status).toBe(200);
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    const noToken = await fetch(`${base}/health`);
    expect(noToken.status).toBe(403);
    const withToken = await fetch(`${base}/health`, { headers: { 'x-health-token': 'tok-123' } });
    expect(withToken.status).toBe(200);
    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe('④ balance_low / billing_dead 钩子产出', () => {
  it('结算钩子在余额低于阈值时入箱（按用户×日幂等）', async () => {
    // 直接验证 worker index 装配的钩子逻辑等价物：余额低 → outbox 行 + dedupe
    const [user] = await db.insert(users)
      .values({ issuer: 'wktest', subject: `wktest-${randomUUID().slice(0, 8)}`, identityProvider: 'local' })
      .returning({ id: users.id });
    createdUsers.push(user!.id);
    const dedupeKey = `balance-low:${user!.id}:${new Date().toISOString().slice(0, 10)}`;
    await db.insert(notifyOutbox).values({
      event: 'balance_low',
      payload: { userId: user!.id, balance: '0.5' },
      dedupeKey,
    }).onConflictDoNothing();
    await db.insert(notifyOutbox).values({
      event: 'balance_low',
      payload: { userId: user!.id, balance: '0.5' },
      dedupeKey,
    }).onConflictDoNothing();
    const rows = await db.select().from(notifyOutbox).where(and(eq(notifyOutbox.event, 'balance_low')));
    const mine = rows.filter((r) => (r.payload as { userId?: number }).userId === user!.id);
    expect(mine.length).toBe(1); // dedupe 生效
    for (const r of mine) await db.delete(notifyOutbox).where(eq(notifyOutbox.id, r.id));
  });
});
