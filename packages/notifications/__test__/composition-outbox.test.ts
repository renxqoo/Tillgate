/**
 * composition bridge(outboxWithinTx)单元门禁(不依赖 PG——真实事务语义见
 * postgres.real.test.ts「outbox 事务参与(§5.4)」组):
 * 入箱 SQL 构造(notify_outbox 表 + values 原样 + onConflictDoNothing 幂等)
 * 与词表/参数域校验(含 payload 拒数组)。
 */
import { describe, expect, it } from 'vitest';
import type { DbTx } from '@tillgate/db';
import { notifyOutbox } from '@tillgate/db';
import { NOTIFY_EVENTS } from '../src/domain/events';
import { outboxWithinTx } from '../src/composition';
import { defined } from './defined';

interface RecordedInsert {
  table: unknown;
  values: unknown;
  onConflictDoNothing: boolean;
}

/** drizzle 链式替身:捕获 insert(table).values(v).onConflictDoNothing() 三段事实 */
function fakeTx() {
  const inserts: RecordedInsert[] = [];
  const tx = {
    insert(table: unknown) {
      return {
        values(values: unknown) {
          return {
            onConflictDoNothing() {
              inserts.push({ table, values, onConflictDoNothing: true });
              return Promise.resolve(null);
            },
          };
        },
      };
    },
  } as unknown as DbTx;
  return { tx, inserts };
}

describe('outboxWithinTx:入箱 SQL 构造(机制面)', () => {
  it('合法输入 → notify_outbox 表、values 原样、onConflictDoNothing 幂等写', async () => {
    const { tx, inserts } = fakeTx();
    const input = {
      event: 'balance_low',
      payload: { userId: 7, balance: '0.5' },
      dedupeKey: 'balance-low:7:20260823',
    };
    await outboxWithinTx(tx).enqueue(input);
    expect(inserts).toHaveLength(1);
    const insert = defined(inserts[0], 'inserts[0]');
    expect(insert.table).toBe(notifyOutbox); // 表目标唯一(不误写他表)
    expect(insert.values).toEqual(input); // values 原样透传(无改写/无补字段)
    expect(insert.onConflictDoNothing).toBe(true); // dedupe 幂等在 SQL 层
  });

  it('词表封闭性:全部 NOTIFY_EVENTS 可入箱(新增事件自动获得覆盖)', async () => {
    for (const event of NOTIFY_EVENTS) {
      const { tx, inserts } = fakeTx();
      await outboxWithinTx(tx).enqueue({
        event,
        payload: { probe: true },
        dedupeKey: `vocab:${event}`,
      });
      expect(inserts, event).toHaveLength(1);
    }
  });
});

describe('outboxWithinTx:词表与参数域校验(零 SQL 触达)', () => {
  it('词表外事件 → unknown_event,不触 insert', async () => {
    const { tx, inserts } = fakeTx();
    await expect(
      outboxWithinTx(tx).enqueue({ event: 'made_up_event', payload: {}, dedupeKey: 'k' }),
    ).rejects.toMatchObject({ code: 'notifications.unknown_event' });
    expect(inserts).toHaveLength(0);
  });

  it('payload 数组/非对象 → invalid_outbox_input(typeof object 放过数组的口子收紧)', async () => {
    for (const payload of [[1, 2, 3], ['a'], []]) {
      const { tx, inserts } = fakeTx();
      await expect(
        outboxWithinTx(tx).enqueue({
          event: 'billing_dead',
          payload: payload as unknown as Record<string, unknown>,
          dedupeKey: 'arr',
        }),
      ).rejects.toMatchObject({ code: 'notifications.invalid_outbox_input' });
      expect(inserts, JSON.stringify(payload)).toHaveLength(0);
    }
  });

  it('dedupeKey 空/超 128 → invalid_outbox_input', async () => {
    for (const dedupeKey of ['', 'k'.repeat(129)]) {
      const { tx, inserts } = fakeTx();
      await expect(
        outboxWithinTx(tx).enqueue({ event: 'billing_dead', payload: {}, dedupeKey }),
      ).rejects.toMatchObject({ code: 'notifications.invalid_outbox_input' });
      expect(inserts, `len=${dedupeKey.length}`).toHaveLength(0);
    }
  });
});
