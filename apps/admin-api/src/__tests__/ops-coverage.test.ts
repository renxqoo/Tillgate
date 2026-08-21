/**
 * 切片三覆盖收尾：tracing 全链 / billing 死单复核正路径 / 通知 email 渠道 /
 * generation-tasks / ops 查询分支。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import {
  billingRequests,
  generationTasks,
  notifyOutbox,
  traceSpans,
} from '@ai-gateway/db';
import { createTracingService } from '../services/tracing.service.js';
import { createBillingReviewService } from '../services/billing-review.service.js';
import {
  buildTestApp,
  db,
  newAdmin,
  newChannelRow,
  newProviderRow,
  newUserRow,
  uid,
  wallet,
} from './helpers.js';

let runCtx = { requestId: 'ops-coverage', actor: { kind: 'admin' as const, id: 0 }, traceParent: null };

async function adminCtxForAudit(): Promise<void> {
  const { id } = await newAdmin();
  runCtx = { ...runCtx, actor: { kind: 'admin', id } };
}

describe('tracing 全链', () => {
  it('种子 span → recent 过滤 / 瀑布 / by-request / 拓扑 / 统计 / 空守卫', async () => {
    const service = createTracingService({ db });
    const traceId = randomUUID().replace(/-/g, '').slice(0, 32);
    const requestId = `req-${uid('t')}`;
    const now = Date.now();
    await db.insert(traceSpans).values([
      { traceId, spanId: 's1', parentSpanId: null, name: 'POST /v1/chat/completions', service: `svc-${uid('x')}`, startTime: new Date(now), endTime: new Date(now + 300), durationMs: 300, statusCode: 0, requestId, attributes: {} },
      { traceId, spanId: 's2', parentSpanId: 's1', name: 'upstream provider-a', service: 'gateway', startTime: new Date(now + 10), endTime: new Date(now + 280), durationMs: 270, statusCode: 2, requestId, attributes: { channel: 'provider-a' } },
    ]);

    // recent：errorsOnly 命中（含 statusCode=2 的 trace）
    const errors = await service.recent({ errorsOnly: true, limit: 100, offset: 0 });
    expect(errors.rows.some((t) => t.traceId === traceId)).toBe(true);
    // recent：正常列表 + minDuration 过滤
    const all = await service.recent({ limit: 100, offset: 0 });
    expect(all.rows.some((t) => t.traceId === traceId)).toBe(true);
    const longOnly = await service.recent({ minDurationMs: 999, limit: 10, offset: 0 });
    expect(longOnly.rows.every((t) => t.durationMs >= 999)).toBe(true);
    // service 过滤
    const byService = await service.recent({ service: 'gateway', limit: 100, offset: 0 });
    expect(byService.rows.every((t) => t.services.includes('gateway'))).toBe(true);

    // 瀑布：双 span、services、时长
    const detail = await service.traceDetail(traceId);
    expect(detail.spans).toHaveLength(2);
    expect(detail.services).toContain('gateway');
    expect(detail.durationMs).toBeGreaterThanOrEqual(280);

    // by-request 关联
    const byReq = await service.byRequest(requestId);
    expect(byReq.spans).toHaveLength(2);

    // 拓扑（gateway upstream 分组）
    const topology = await service.topology(24);
    expect(Array.isArray(topology)).toBe(true);

    // 统计
    const stats = await service.stats();
    expect(stats).toHaveProperty('spans');

    // 空守卫：坏 traceId/requestId → 空详情
    expect((await service.traceDetail('!!!not-hex!!!')).spans).toEqual([]);
    expect((await service.byRequest(' ')).spans).toEqual([]);

    // 清理种子
    await db.delete(traceSpans).where(eq(traceSpans.traceId, traceId));
  });

  it('HTTP 面：recent/traces/topology/stats 全 200', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    expect((await request('/v1/tracing/recent?errorsOnly=true', { token })).status).toBe(200);
    expect((await request('/v1/tracing/recent?minDurationMs=50&service=gateway', { token })).status).toBe(200);
    expect((await request('/v1/tracing/traces/abcdef0123', { token })).status).toBe(200);
    expect((await request('/v1/tracing/topology?hours=48', { token })).status).toBe(200);
    expect((await request('/v1/tracing/stats', { token })).status).toBe(200);
  });
});

describe('billing 死单复核正路径', () => {
  it('retry：CAS dead→retry_wait + 审计同事务 + 幂等重放；错 revision 409', async () => {
    await adminCtxForAudit();
    const userId = await newUserRow();
    const requestId = randomUUID();
    await db.insert(billingRequests).values({
      requestId,
      userId,
      estimatedExposureAmount: '0',
      reservedAmount: '0',
      status: 'dead',
      revision: 3,
      quote: {},
      receipt: { requestId: '', kind: 'chat' },
      authorizationFingerprint: 'x'.repeat(64),
      failureCode: 'upstream_error',
    });
    try {
      const service = createBillingReviewService({ db, wallet });
      const list = await service.list(runCtx, { limit: 10, offset: 0 });
      expect(list.rows.some((r) => (r as { requestId: string }).requestId === requestId)).toBe(true);

      // 错 revision → 409
      await expect(
        service.retry(runCtx, { adminId: runCtx.actor.id, operationId: uid('op'), requestId, expectedRevision: 2, reason: '错版本' }),
      ).rejects.toMatchObject({ status: 409, code: 'billing_state_conflict' });

      // 正确 retry → retry_wait
      const key = uid('op');
      const first = await service.retry(runCtx, { adminId: runCtx.actor.id, operationId: key, requestId, expectedRevision: 3, reason: '复核重试' });
      expect(first.status).toBe('retry_wait');
      // 同键重放
      const replay = await service.retry(runCtx, { adminId: runCtx.actor.id, operationId: key, requestId, expectedRevision: 3, reason: '复核重试' });
      expect(replay.replayed).toBe(true);
      // 审计行落库（同事务）
      const { auditLogs } = await import('@ai-gateway/db');
      const audits = await db.select().from(auditLogs).where(eq(auditLogs.targetId, requestId));
      expect(audits.some((a) => a.action === 'billing.retry_dead')).toBe(true);
    } finally {
      await db.delete(billingRequests).where(eq(billingRequests.requestId, requestId));
    }
  });

  it('abandon：dead→released（零预扣直发）+ 审计；HTTP 面全链', async () => {
    const userId = await newUserRow();
    const requestId = randomUUID();
    await db.insert(billingRequests).values({
      requestId,
      userId,
      estimatedExposureAmount: '0',
      reservedAmount: '0',
      status: 'dead',
      revision: 1,
      quote: {},
      receipt: { requestId: '', kind: 'chat' },
      authorizationFingerprint: 'x'.repeat(64),
    });
    try {
      const { request } = buildTestApp();
      const { token } = await newAdmin();
      const abandoned = await request(`/v1/billing-operations/${requestId}/abandon`, {
        method: 'POST',
        token,
        body: { expectedRevision: 1, reason: '上游确认失败，放弃结算', evidenceRefs: ['ticket-123'] },
        headers: { 'idempotency-key': uid('op') },
      });
      expect(abandoned.status).toBe(200);
      expect(((await abandoned.json()) as { released: boolean }).released).toBe(true);

      const [row] = await db.select().from(billingRequests).where(eq(billingRequests.requestId, requestId));
      expect(row!.status).toBe('released');
      // 再 abandon（已非 dead）→ 409
      expect(
        (await request(`/v1/billing-operations/${requestId}/abandon`, {
          method: 'POST',
          token,
          body: { expectedRevision: 1, reason: '再试' },
          headers: { 'idempotency-key': uid('op') },
        })).status,
      ).toBe(409);
    } finally {
      await db.delete(billingRequests).where(eq(billingRequests.requestId, requestId));
    }
  });
});

describe('通知 email 渠道 + ops 收尾', () => {
  it('email 渠道（recipients）创建/更新/测试/删除；未知事件 400；不存在 404', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();

    const badEvent = await request('/v1/notifications', {
      token,
      body: { name: uid('n'), type: 'email', config: { recipients: ['a@b.test'] }, events: ['not_an_event'] },
    });
    expect(badEvent.status).toBe(400);

    const created = await request('/v1/notifications', {
      token,
      body: { name: uid('mail'), type: 'email', config: { recipients: ['ops@example.test'] }, events: ['balance_low'] },
    });
    expect(created.status).toBe(201);
    const channelId = ((await created.json()) as { id: number }).id;

    // 更新事件与配置
    const patched = await request(`/v1/notifications/${channelId}`, {
      method: 'PATCH',
      token,
      body: { events: ['billing_dead'], config: { recipients: ['ops2@example.test'] } },
    });
    expect(patched.status).toBe(200);

    expect((await request(`/v1/notifications/${channelId}/test`, { method: 'POST', token })).status).toBe(200);
    expect((await request('/v1/notifications/999999999/test', { method: 'POST', token })).status).toBe(404);
    expect((await request('/v1/notifications/999999999', { method: 'DELETE', token })).status).toBe(404);

    await db.delete(notifyOutbox).where(like(notifyOutbox.dedupeKey, `test:${channelId}:%`));
    expect((await request(`/v1/notifications/${channelId}`, { method: 'DELETE', token })).status).toBe(200);
  });

  it('generation-tasks：kind/status 过滤 + 账单状态回显 + 实扣回填', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const userId = await newUserRow();
    const providerId = await newProviderRow();
    const channelId = await newChannelRow(providerId);
    const taskId = randomUUID();
    // 账单先行（generation_tasks.requestId FK → billing_requests）
    await db.insert(billingRequests).values({
      requestId: taskId,
      userId,
      estimatedExposureAmount: '0',
      reservedAmount: '0',
      status: 'settled',
      quote: {},
      receipt: { requestId: '', kind: 'chat' },
      authorizationFingerprint: 'x'.repeat(64),
    });
    const { newMappingRow } = await import('./helpers.js');
    const mappingId = await newMappingRow();
    await db.insert(generationTasks).values({
      id: taskId,
      requestId: taskId,
      kind: 'video',
      status: 'succeeded',
      finishedAt: new Date(),
      result: { url: 'https://cdn.example.test/v.mp4' },
      userId,
      channelId,
      mappingId,
      params: {},
      receiptTemplate: {},
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const { usageLogs } = await import('@ai-gateway/db');
    await db.insert(usageLogs).values({
      requestId: taskId,
      userId,
      channelId,
      credentialType: 'api_key',
      externalModel: `gt-${uid('m')}`,
      realModel: 'gt-real',
      amount: '0.5',
      paygAmount: '0.5',
      coefficient: '1.000',
      billedBy: 'payg',
      status: 0,
    });
    try {
      const list = (await (
        await request('/v1/generation-tasks?kind=video&status=succeeded', { token })
      ).json()) as { total: number; items: Array<{ id: string; billingStatus: string | null; settledAmount: string | null }> };
      const mine = list.items.find((i) => i.id === taskId);
      expect(mine).toBeTruthy();
      expect(mine!.billingStatus).toBe('settled');
      expect(new (await import('@ai-gateway/domain')).Decimal(mine!.settledAmount ?? '0').eq(0.5)).toBe(true);
    } finally {
      await db.delete(usageLogs).where(eq(usageLogs.requestId, taskId));
      await db.delete(generationTasks).where(eq(generationTasks.id, taskId));
      await db.delete(billingRequests).where(eq(billingRequests.requestId, taskId));
    }
  });

  it('审计日志全局列表 + 订单/用量排序分支', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const audits = (await (
      await request('/v1/audit-logs?q=user.update&page_size=5', { token })
    ).json()) as { rows: unknown[]; total: number };
    expect(Array.isArray(audits.rows)).toBe(true);

    expect((await request('/v1/payment-orders?sort_by=amount&order=asc', { token })).status).toBe(200);
    expect((await request('/v1/usage-logs?sort_by=inputTokens&order=asc&userId=999999999', { token })).status).toBe(200);
    expect((await request('/v1/logs?sort_by=statusCode&order=asc&statusCode=401', { token })).status).toBe(200);
    expect((await request('/v1/generation-tasks?kind=music&limit=1&offset=0', { token })).status).toBe(200);
  });
});
