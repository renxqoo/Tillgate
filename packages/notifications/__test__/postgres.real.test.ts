/**
 * postgres 适配器真实 PG 行为等价测试(铁律 14:默认门禁按文件名排除,test:real 显式运行)。
 * 覆盖 SQL 专属语义:FOR UPDATE SKIP LOCKED 并发单赢家、三列 CAS fencing(错 token/
 * 过期租约零效果)、dedupe 唯一索引、渠道重名 23505 翻译、jsonb 渠道进度追加、
 * 退避/终态表达式。
 * 环境:DATABASE_URL(根 .env);不可达时全组跳过(退出码 0——由显式运行者保证环境)。
 * 隔离纪律:认领面向全表,ambient 待投递行先隔离(next_attempt_at 推后)并在收尾恢复,
 * 保证断言只命中本文件种子行。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, or, lte, sql } from 'drizzle-orm';
import {
  createDb,
  closeDb,
  ping,
  notificationChannels,
  notifyOutbox,
  isUniqueViolation,
  type Db,
} from '@tillgate/db';
import { postgresNotifyStore } from '../src/adapters/postgres/notify-store';
import { outboxWithinTx } from '../src/composition';
import { createChannel } from '../src/application/create-channel';
import { testChannel } from '../src/application/test-channel';
import { notificationsErrors } from '../src/errors';
import { fakeCipher } from './memory';
import type { NotifyContext } from '../src/application/context';
import { defined } from './defined';

const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/tillgate';
let db: Db | null = null;
const createdChannels: number[] = [];
const createdOutbox: number[] = [];
let ambientRestore: (() => Promise<void>) | null = null;
const uid = () => `nt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const ctx: NotifyContext = { requestId: 'real-pg', actor: { kind: 'admin', id: 1 } };

async function seedOutbox(row: {
  event: string;
  payload?: Record<string, unknown>;
  dedupeKey?: string;
  attempts?: number;
}): Promise<number> {
  const conn = defined(db, 'db');
  const [insertedRow] = await conn
    .insert(notifyOutbox)
    .values({
      event: row.event,
      payload: row.payload ?? {},
      dedupeKey: row.dedupeKey ?? `real-${uid()}`,
      ...(row.attempts !== undefined ? { attempts: row.attempts } : {}),
    })
    .returning({ id: notifyOutbox.id });
  const inserted = defined(insertedRow, 'inserted');
  createdOutbox.push(inserted.id);
  return inserted.id;
}

/** 认领资格隔离:ambient 待投递行推后 1 小时,返回恢复函数(本文件种子行之前调用) */
async function quarantineAmbient(): Promise<() => Promise<void>> {
  const conn = defined(db, 'db');
  const pending = await conn
    .update(notifyOutbox)
    .set({ nextAttemptAt: sql`clock_timestamp() + interval '1 hour'` })
    .where(
      and(
        isNull(notifyOutbox.sentAt),
        or(isNull(notifyOutbox.claimUntil), lte(notifyOutbox.claimUntil, sql`clock_timestamp()`)),
        sql`${notifyOutbox.attempts} < 3`,
      ),
    )
    .returning({ id: notifyOutbox.id });
  const ids = pending.map((r) => r.id);
  return async () => {
    if (ids.length === 0) return;
    await conn
      .update(notifyOutbox)
      .set({ nextAttemptAt: new Date() })
      .where(inArray(notifyOutbox.id, ids));
  };
}

/**
 * 认领目标隔离(逐用例):claimPending 恒取最低 id 的可领行——把除目标行外的
 * 可领行推后 1 小时,保证断言只命中本用例种子行(文件内早前用例行/并行会话残留
 * 均不可领)。quarantineAmbient 只在 beforeAll 跑一次,挡不住运行中途的新可领行。
 */
async function isolateClaimTarget(id: number): Promise<void> {
  await defined(db, 'db')
    .update(notifyOutbox)
    .set({ nextAttemptAt: sql`clock_timestamp() + interval '1 hour'` })
    .where(
      and(
        isNull(notifyOutbox.sentAt),
        or(isNull(notifyOutbox.claimUntil), lte(notifyOutbox.claimUntil, sql`clock_timestamp()`)),
        sql`${notifyOutbox.attempts} < 3`,
        sql`${notifyOutbox.id} <> ${id}`,
      ),
    );
}

beforeAll(async () => {
  try {
    db = createDb({
      url,
      poolMax: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 3_000,
      maxUses: 10_000,
    });
    await ping(db);
  } catch {
    db = null;
    console.warn('[postgres.real] DATABASE_URL 不可达,跳过真实 PG 行为等价测试');
    return;
  }
  ambientRestore = await quarantineAmbient();
});

afterAll(async () => {
  if (!db) return;
  if (createdOutbox.length > 0) {
    await db.delete(notifyOutbox).where(inArray(notifyOutbox.id, createdOutbox));
  }
  if (createdChannels.length > 0) {
    await db.delete(notificationChannels).where(inArray(notificationChannels.id, createdChannels));
  }
  await ambientRestore?.();
  await closeDb(db);
});

describe('原子认领(SKIP LOCKED)', () => {
  it('两个并发事务同时认领同一行:恰一赢家,认领痕迹三列齐落', async () => {
    if (!db) return;
    const id = await seedOutbox({ event: 'real_probe_claim' });
    const claims = await Promise.all([
      db.transaction((tx) =>
        postgresNotifyStore.claimPending(tx, {
          ownerId: 'real-a',
          limit: 5,
          leaseMs: 60_000,
          maxAttempts: 3,
        }),
      ),
      db.transaction((tx) =>
        postgresNotifyStore.claimPending(tx, {
          ownerId: 'real-b',
          limit: 5,
          leaseMs: 60_000,
          maxAttempts: 3,
        }),
      ),
    ]);
    const winners = claims.flat().filter((item) => item.id === id);
    expect(winners).toHaveLength(1); // SKIP LOCKED:并发单赢家
    // 抽具名谓词压平嵌套回调(max-nested-callbacks)
    const hasWinner = (c: (typeof claims)[number]) => c.some((item) => item.id === id);
    const winnerIdx = claims.findIndex(hasWinner);
    const [fetched] = await db.select().from(notifyOutbox).where(eq(notifyOutbox.id, id));
    const row = defined(fetched, 'row');
    expect(row.claimOwner).toBe(winnerIdx === 0 ? 'real-a' : 'real-b');
    expect(row.claimToken).toBe(defined(winners[0], 'winner').claimToken);
    expect(row.claimUntil).not.toBeNull();
  });

  it('终态/退避未到期/租约未到期/次数耗尽的行不被认领', async () => {
    if (!db) return;
    const terminal = await seedOutbox({ event: 'real_probe_skip' });
    await db.update(notifyOutbox).set({ sentAt: new Date() }).where(eq(notifyOutbox.id, terminal));
    const backoff = await seedOutbox({ event: 'real_probe_skip' });
    await db
      .update(notifyOutbox)
      .set({ nextAttemptAt: new Date(Date.now() + 60_000) })
      .where(eq(notifyOutbox.id, backoff));
    const leased = await seedOutbox({ event: 'real_probe_skip' });
    await db
      .update(notifyOutbox)
      .set({
        claimOwner: 'other',
        claimToken: randomUUID(),
        claimUntil: new Date(Date.now() + 60_000),
      })
      .where(eq(notifyOutbox.id, leased));
    const exhausted = await seedOutbox({ event: 'real_probe_skip', attempts: 3 });
    const claimed = await postgresNotifyStore.claimPending(db, {
      ownerId: 'real-c',
      limit: 10,
      leaseMs: 60_000,
      maxAttempts: 3,
    });
    expect(claimed).toHaveLength(0); // 隔离后无其他可领行
    void terminal;
    void backoff;
    void leased;
    void exhausted;
  });
});

describe('CAS fencing', () => {
  it('错 token/错 owner 的 complete/fail 零效果', async () => {
    if (!db) return;
    const id = await seedOutbox({ event: 'real_probe_fence' });
    await isolateClaimTarget(id);
    const [claimed] = await postgresNotifyStore.claimPending(db, {
      ownerId: 'real-a',
      limit: 1,
      leaseMs: 60_000,
      maxAttempts: 3,
    });
    expect(claimed?.id).toBe(id);
    const fence = defined(claimed, 'claimed');
    // 错 token 用合法 uuid 形态(claim_token 是 uuid 列,非 uuid 字符串在比较前即 22P02——
    // 现实中错 token 恒为 gen_random_uuid 产物,不会出现非 uuid 形态)
    const wrongToken = await db.transaction((tx) =>
      postgresNotifyStore.completeClaim(tx, { id, ownerId: 'real-a', claimToken: randomUUID() }),
    );
    expect(wrongToken).toBe(false);
    const wrongOwner = await db.transaction((tx) =>
      postgresNotifyStore.failClaim(tx, {
        id,
        ownerId: 'real-b',
        claimToken: fence.claimToken,
        maxAttempts: 3,
        error: 'x',
        retryDelayMs: 1000,
      }),
    );
    expect(wrongOwner).toBe(false);
    const [fetched] = await db.select().from(notifyOutbox).where(eq(notifyOutbox.id, id));
    const row = defined(fetched, 'row');
    expect(row.sentAt).toBeNull();
    expect(row.attempts).toBe(0);
  });

  it('过期租约的 record/complete 零效果', async () => {
    if (!db) return;
    const id = await seedOutbox({ event: 'real_probe_expire' });
    await isolateClaimTarget(id);
    const [claimed] = await postgresNotifyStore.claimPending(db, {
      ownerId: 'real-a',
      limit: 1,
      leaseMs: 1,
      maxAttempts: 3,
    });
    expect(claimed?.id).toBe(id);
    const lease = defined(claimed, 'claimed');
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    const recorded = await db.transaction((tx) =>
      postgresNotifyStore.recordDeliveredChannels(tx, {
        id,
        ownerId: 'real-a',
        claimToken: lease.claimToken,
        channelIds: [1, 2],
      }),
    );
    expect(recorded).toBe(false);
    const completed = await db.transaction((tx) =>
      postgresNotifyStore.completeClaim(tx, {
        id,
        ownerId: 'real-a',
        claimToken: lease.claimToken,
      }),
    );
    expect(completed).toBe(false);
  });

  it('正确 fencing 下:进度 jsonb 追加 + 空数组恒真', async () => {
    if (!db) return;
    const id = await seedOutbox({ event: 'real_probe_progress' });
    await isolateClaimTarget(id);
    const [claimed] = await postgresNotifyStore.claimPending(db, {
      ownerId: 'real-a',
      limit: 1,
      leaseMs: 60_000,
      maxAttempts: 3,
    });
    expect(claimed?.id).toBe(id);
    const progress = defined(claimed, 'claimed');
    const emptyNoop = await db.transaction((tx) =>
      postgresNotifyStore.recordDeliveredChannels(tx, {
        id,
        ownerId: 'real-a',
        claimToken: progress.claimToken,
        channelIds: [],
      }),
    );
    expect(emptyNoop).toBe(true);
    expect(
      await db.transaction((tx) =>
        postgresNotifyStore.recordDeliveredChannels(tx, {
          id,
          ownerId: 'real-a',
          claimToken: progress.claimToken,
          channelIds: [3, 4],
        }),
      ),
    ).toBe(true);
    expect(
      await db.transaction((tx) =>
        postgresNotifyStore.recordDeliveredChannels(tx, {
          id,
          ownerId: 'real-a',
          claimToken: progress.claimToken,
          channelIds: [5],
        }),
      ),
    ).toBe(true);
    const [fetched] = await db.select().from(notifyOutbox).where(eq(notifyOutbox.id, id));
    expect(defined(fetched, 'row').deliveredChannelIds).toEqual([3, 4, 5]); // 追加不覆盖
  });

  it('completeClaim 终态:attempts+1、claim 清空、lastError 清空', async () => {
    if (!db) return;
    const id = await seedOutbox({ event: 'real_probe_done', attempts: 1 });
    await isolateClaimTarget(id);
    const [claimed] = await postgresNotifyStore.claimPending(db, {
      ownerId: 'real-a',
      limit: 1,
      leaseMs: 60_000,
      maxAttempts: 3,
    });
    expect(claimed?.id).toBe(id);
    const done = defined(claimed, 'claimed');
    const completed = await db.transaction((tx) =>
      postgresNotifyStore.completeClaim(tx, {
        id,
        ownerId: 'real-a',
        claimToken: done.claimToken,
      }),
    );
    expect(completed).toBe(true);
    const [fetched] = await db.select().from(notifyOutbox).where(eq(notifyOutbox.id, id));
    const row = defined(fetched, 'row');
    expect(row.sentAt).not.toBeNull();
    expect(row.attempts).toBe(2);
    expect(row.claimOwner).toBeNull();
    expect(row.claimToken).toBeNull();
    expect(row.claimUntil).toBeNull();
  });

  it('failClaim:未达上限释放认领并退避;达上限终态 failed + lastError 截断 255', async () => {
    if (!db) return;
    const id = await seedOutbox({ event: 'real_probe_fail', attempts: 0 });
    await isolateClaimTarget(id);
    const [claimed] = await postgresNotifyStore.claimPending(db, {
      ownerId: 'real-a',
      limit: 1,
      leaseMs: 60_000,
      maxAttempts: 3,
    });
    expect(claimed?.id).toBe(id);
    const fail = defined(claimed, 'claimed');
    const before = Date.now();
    expect(
      await db.transaction((tx) =>
        postgresNotifyStore.failClaim(tx, {
          id,
          ownerId: 'real-a',
          claimToken: fail.claimToken,
          maxAttempts: 3,
          error: 'x'.repeat(300),
          retryDelayMs: 15_000,
        }),
      ),
    ).toBe(true);
    const [fetched] = await db.select().from(notifyOutbox).where(eq(notifyOutbox.id, id));
    const row = defined(fetched, 'row');
    expect(row.attempts).toBe(1);
    expect(row.sentAt).toBeNull(); // 未达上限不终态
    expect(row.claimOwner).toBeNull();
    expect(row.lastError).toBe('x'.repeat(255)); // 截断
    expect(defined(row.nextAttemptAt, 'nextAttemptAt').getTime()).toBeGreaterThanOrEqual(
      before + 14_000,
    ); // 退避 15s

    // 直接置 attempts=2 重领后失败:attempts+1=3 达上限 → 终态
    await db
      .update(notifyOutbox)
      .set({
        attempts: 2,
        nextAttemptAt: new Date(),
        claimOwner: 'real-a',
        claimToken: randomUUID(),
        claimUntil: new Date(Date.now() + 60_000),
      })
      .where(eq(notifyOutbox.id, id));
    const [tokenRow] = await db
      .select({ token: notifyOutbox.claimToken })
      .from(notifyOutbox)
      .where(eq(notifyOutbox.id, id));
    const finalToken = defined(defined(tokenRow, 'tokenRow').token, 'token');
    expect(
      await db.transaction((tx) =>
        postgresNotifyStore.failClaim(tx, {
          id,
          ownerId: 'real-a',
          claimToken: finalToken,
          maxAttempts: 3,
          error: 'boom',
          retryDelayMs: 15_000,
        }),
      ),
    ).toBe(true);
    const [finalRow] = await db.select().from(notifyOutbox).where(eq(notifyOutbox.id, id));
    const final = defined(finalRow, 'finalRow');
    expect(final.sentAt).not.toBeNull(); // 达上限终态
    expect(final.attempts).toBe(3);
  });
});

describe('入箱与渠道', () => {
  it('dedupe 唯一索引:同 dedupeKey 幂等一行', async () => {
    if (!db) return;
    const dedupeKey = `real-dedupe-${uid()}`;
    await postgresNotifyStore.insertOutboxEvent(db, {
      event: 'balance_low',
      payload: { userId: 1 },
      dedupeKey,
    });
    await postgresNotifyStore.insertOutboxEvent(db, {
      event: 'balance_low',
      payload: { userId: 1 },
      dedupeKey,
    });
    const rows = await db
      .select({ id: notifyOutbox.id })
      .from(notifyOutbox)
      .where(eq(notifyOutbox.dedupeKey, dedupeKey));
    expect(rows).toHaveLength(1);
    createdOutbox.push(defined(rows[0], 'rows[0]').id);
  });

  it('渠道 CRUD SQL:插入/查改删/listActive 过滤;重名 23505 经用例翻译为 channel_exists', async () => {
    if (!db) return;
    const name = `real-ch-${uid()}`;
    const created = await createChannel(
      { db, store: postgresNotifyStore, cipher: fakeCipher() },
      {
        ctx,
        name,
        type: 'webhook',
        config: { url: 'https://hooks.example.test/x', secret: 's'.repeat(24) },
        events: ['billing_dead'],
      },
    );
    createdChannels.push(created.id);
    expect(created.config.secret).toMatch(/^\*{4}/); // 密文不回显
    const stored = defined(await postgresNotifyStore.findChannel(db, created.id), 'stored');
    expect(stored.config.secret).toMatch(/^enc:v1:fake:/); // 落库密文
    expect(stored.type).toBe('webhook');

    // store 层直连可见原生 23505 形状;用例层翻译为 channel_exists
    const dup = await db
      .transaction((tx) =>
        postgresNotifyStore.insertChannel(tx, {
          name,
          type: 'webhook',
          config: { url: 'https://hooks.example.test/y', secret: 's'.repeat(24) },
          events: ['billing_dead'],
        }),
      )
      .catch((error: unknown) => error);
    expect(isUniqueViolation(dup)).toBe(true);
    const translated = await createChannel(
      { db, store: postgresNotifyStore, cipher: fakeCipher() },
      { ctx, name, type: 'email', config: { recipients: ['a@b.test'] }, events: ['balance_low'] },
    ).catch((error: unknown) => error);
    expect((translated as { code?: string }).code).toBe('notifications.channel_exists');

    await db
      .update(notificationChannels)
      .set({ status: 1 })
      .where(eq(notificationChannels.id, created.id));
    expect(
      (await postgresNotifyStore.listChannels(db, { activeOnly: true })).some(
        (c) => c.id === created.id,
      ),
    ).toBe(false);
    expect(
      (await postgresNotifyStore.listChannels(db, { activeOnly: false })).some(
        (c) => c.id === created.id,
      ),
    ).toBe(true);

    const patched = defined(
      await db.transaction((tx) =>
        postgresNotifyStore.patchChannel(tx, {
          channelId: created.id,
          patch: { events: ['balance_low'], status: 0 },
        }),
      ),
      'patched',
    );
    expect(patched.events).toEqual(['balance_low']);
    expect(patched.status).toBe(0);
    expect(await db.transaction((tx) => postgresNotifyStore.removeChannel(tx, created.id))).toBe(
      true,
    );
    expect(await db.transaction((tx) => postgresNotifyStore.removeChannel(tx, created.id))).toBe(
      false,
    );
  });

  it('test 动词:入箱行形状(首事件 + test:true 载荷 + test:{id}:{ts} 键)', async () => {
    if (!db) return;
    const created = await createChannel(
      { db, store: postgresNotifyStore, cipher: fakeCipher() },
      {
        ctx,
        name: `real-ch-${uid()}`,
        type: 'email',
        config: { recipients: ['a@b.test'] },
        events: ['balance_low', 'billing_dead'],
      },
    );
    createdChannels.push(created.id);
    await testChannel({ db, store: postgresNotifyStore }, { ctx, channelId: created.id });
    const rows = await db
      .select()
      .from(notifyOutbox)
      .where(sql`${notifyOutbox.dedupeKey} like ${`test:${created.id}:%`}`);
    expect(rows).toHaveLength(1);
    const testRow = defined(rows[0], 'rows[0]');
    expect(testRow.event).toBe('balance_low'); // 首订阅事件
    expect(testRow.payload).toEqual({ test: true, channel: created.name });
    createdOutbox.push(testRow.id);

    const thrown = await testChannel(
      { db, store: postgresNotifyStore },
      { ctx, channelId: 999_999_999 },
    ).catch((error: unknown) => error);
    expect(notificationsErrors.has((thrown as { code: string }).code)).toBe(true);
    expect((thrown as { code: string }).code).toBe('notifications.channel_not_found');
  });
});

describe('outbox 事务参与(§5.4 三类边界,outboxWithinTx bridge)', () => {
  it('①业务回滚 → 无 outbox 行(回滚即无事件)', async () => {
    if (!db) return;
    const dedupeKey = `real-rollback-${uid()}`;
    await defined(db, 'db')
      .transaction(async (tx) => {
        await outboxWithinTx(tx).enqueue({
          event: 'balance_low',
          payload: { userId: 1 },
          dedupeKey,
        });
        // 业务侧写入与入箱同一事务——此处主动回滚(模拟业务失败)
        await tx.rollback();
      })
      .catch(() => {});
    const rows = await db
      .select({ id: notifyOutbox.id })
      .from(notifyOutbox)
      .where(eq(notifyOutbox.dedupeKey, dedupeKey));
    expect(rows).toHaveLength(0);
  });

  it('②入箱失败 → 业务侧写入一并回滚(同事务原子)', async () => {
    if (!db) return;
    const marker = `real-atomic-${uid()}`;
    // 业务事实 = channels 行;入箱抛错(词表门拒绝超长 event)必须把渠道行一并回滚
    await expect(
      defined(db, 'db').transaction(async (tx) => {
        await tx.insert(notificationChannels).values({
          name: marker,
          type: 'email',
          events: [],
          config: {},
          status: 1,
        });
        await outboxWithinTx(tx).enqueue({
          event: 'x'.repeat(300), // 词表外 → 词表门抛错,随事务回滚
          payload: { userId: 1 },
          dedupeKey: `real-fail-${uid()}`,
        });
      }),
    ).rejects.toThrow();
    const channelRows = await db
      .select({ id: notificationChannels.id })
      .from(notificationChannels)
      .where(eq(notificationChannels.name, marker));
    expect(channelRows).toHaveLength(0);
  });

  it('③并发重复入箱:同 dedupeKey 恰一行(onConflictDoNothing)', async () => {
    if (!db) return;
    const dedupeKey = `real-concurrent-${uid()}`;
    // 抽具名事务体压平嵌套回调(max-nested-callbacks)
    const enqueueOnce = async (tx: Parameters<Parameters<Db['transaction']>[0]>[0]) =>
      outboxWithinTx(tx).enqueue({
        event: 'balance_low',
        payload: { userId: 1 },
        dedupeKey,
      });
    const conn = defined(db, 'db');
    const attempts = await Promise.all(
      Array.from({ length: 4 }, () => conn.transaction(enqueueOnce)),
    );
    expect(attempts).toHaveLength(4); // 全部成功(唯一冲突被静默忽略)
    const rows = await conn
      .select({ id: notifyOutbox.id })
      .from(notifyOutbox)
      .where(eq(notifyOutbox.dedupeKey, dedupeKey));
    expect(rows).toHaveLength(1);
    createdOutbox.push(defined(rows[0], 'rows[0]').id);
  });
});
