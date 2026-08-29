import { describe, expect, it } from 'vitest';
import { defined } from './defined';
import { createMemoryGenerationTaskStore } from '../src/adapters/task-memory';
import { GENERATION_TASK_STATUSES } from '../src/ports/generation';
import type { GenerationTaskRecord } from '../src/ports/generation';

/**
 * 管理任务列表读动词(admin-api):内存适配的过滤/分页/排序/total 语义 +
 * 词表封闭。账本投影列(billingStatus/settledAmount)内存形态恒空——
 * 数据面缺席的形态约定,SQL 语义由 generation-pg.real.test.ts 承担。
 */

let seq = 0;
/** 造一条任务记录(createdAt 由插入顺序驱动 now 递增) */
function seed(overrides: Partial<GenerationTaskRecord> = {}): GenerationTaskRecord {
  seq += 1;
  return {
    taskId: `task-${seq}`,
    requestId: `req-${seq}`,
    userId: 1,
    apiKeyId: null,
    mappingId: 1,
    channelId: 2,
    kind: seq % 2 === 0 ? 'music' : 'video',
    upstreamTaskId: null,
    upstreamModel: 'gpt-x-real',
    status: 'queued',
    params: { prompt: 'p' },
    receiptTemplate: {
      requestId: `req-${seq}`,
      userId: 1,
      apiKeyId: null,
      model: 'm',
      pricingUnit: 'request',
      coefficient: '1',
      snapshot: {},
    } as unknown as GenerationTaskRecord['receiptTemplate'],
    unitsSnapshot: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
    ...overrides,
  };
}

describe('内存任务存储 adminList/settledAmounts', () => {
  it('kind/status 过滤 + createdAt 降序 + limit/offset 分页 + total 恒全量', async () => {
    let tick = 1_000;
    const store = createMemoryGenerationTaskStore(() => tick++);
    for (const record of [seed(), seed(), seed(), seed(), seed(), seed()]) {
      await store.insert(record);
    }
    await store.casTerminal({ taskId: 'task-1', status: 'succeeded', result: { ok: 1 } });
    await store.casTerminal({ taskId: 'task-3', status: 'failed', failReason: 'upstream' });

    const video = await store.adminList({ kind: 'video', limit: 10, offset: 0 });
    expect(video.total).toBe(3);
    expect(video.rows.every((r) => r.kind === 'video')).toBe(true);

    // createdAt 降序:后插入者在前
    const all = await store.adminList({ limit: 10, offset: 0 });
    expect(all.rows.map((r) => r.taskId)).toEqual([
      'task-6',
      'task-5',
      'task-4',
      'task-3',
      'task-2',
      'task-1',
    ]);

    const failed = await store.adminList({ status: 'failed', limit: 10, offset: 0 });
    expect(failed.rows).toHaveLength(1);
    expect(failed.rows[0]).toMatchObject({
      taskId: 'task-3',
      status: 'failed',
      failReason: 'upstream',
      billingStatus: null,
      finishedAt: expect.any(Number),
    });

    // 分页:total 不受分页影响;第二页续排
    const page1 = await store.adminList({ limit: 2, offset: 0 });
    const page2 = await store.adminList({ limit: 2, offset: 2 });
    expect(page1.total).toBe(6);
    expect(defined(page2.rows[0], 'page2.rows[0]').taskId).toBe('task-4');
    // 越界页空数组不抛
    const beyond = await store.adminList({ limit: 2, offset: 100 });
    expect(beyond.rows).toEqual([]);
  });

  it('内存形态账本投影恒空:billingStatus null + settledAmounts 空 Map', async () => {
    const store = createMemoryGenerationTaskStore();
    await store.insert(seed());
    const rows = await store.adminList({ limit: 10, offset: 0 });
    expect(defined(rows.rows[0], 'rows.rows[0]').billingStatus).toBeNull();
    expect(defined(rows.rows[0], 'rows.rows[0]').result).toBeNull();
    const amounts = await store.settledAmounts(['task-1']);
    expect(amounts.size).toBe(0);
    // 空入参不查询不抛
    expect(await store.settledAmounts([])).toEqual(new Map());
  });
});

describe('词表封闭(契约级,§10.1)', () => {
  it('status 词表 = v1 五态逐字;与 DB check 约束同源', () => {
    expect(GENERATION_TASK_STATUSES).toEqual([
      'queued',
      'running',
      'succeeded',
      'failed',
      'expired',
    ]);
  });

  it('kind 词表数组与 GENERATION_KINDS 注册表键集一致(单一真相不漂移)', async () => {
    const { GENERATION_KINDS, GENERATION_TASK_KINDS } = await import('../src/domain/generation');
    expect([...GENERATION_TASK_KINDS].toSorted()).toEqual(Object.keys(GENERATION_KINDS).toSorted());
  });
});
