/**
 * 入箱用例:词表门、dedupe 幂等(v1 balance-low 按键一行的机制面)、参数域。
 */
import { describe, expect, it } from 'vitest';
import { buildFacade } from './memory';

describe('enqueue', () => {
  it('词表外事件 → unknown_event', async () => {
    const { facade } = buildFacade();
    const err = await facade
      .enqueue({ event: 'concurrency_probe', payload: {}, dedupeKey: 'k1' })
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('notifications.unknown_event');
  });

  it('dedupeKey 空/超 128 → invalid_outbox_input', async () => {
    const { facade } = buildFacade();
    const empty = await facade
      .enqueue({ event: 'billing_dead', payload: {}, dedupeKey: '' })
      .catch((e: unknown) => e);
    expect((empty as { code: string }).code).toBe('notifications.invalid_outbox_input');
    const tooLong = await facade
      .enqueue({ event: 'billing_dead', payload: {}, dedupeKey: 'k'.repeat(129) })
      .catch((e: unknown) => e);
    expect((tooLong as { code: string }).code).toBe('notifications.invalid_outbox_input');
  });

  it('payload 数组形状 → invalid_outbox_input（typeof object 放过数组的口子收紧）', async () => {
    const { facade, memory } = buildFacade();
    const arrayPayload = await facade
      .enqueue({
        event: 'billing_dead',
        payload: [1, 2, 3] as unknown as Record<string, unknown>,
        dedupeKey: 'arr-1',
      })
      .catch((e: unknown) => e);
    expect((arrayPayload as { code: string }).code).toBe('notifications.invalid_outbox_input');
    expect(memory.pendingRows()).toHaveLength(0); // 无行落库
  });

  it('同 dedupeKey 幂等:仍一行(onConflictDoNothing 机制面)', async () => {
    const { facade, memory } = buildFacade();
    const input = {
      event: 'balance_low',
      payload: { userId: 7, balance: '0.5' },
      dedupeKey: 'balance-low:7:20260823',
    } as const;
    await facade.enqueue(input);
    await facade.enqueue(input);
    const rows = memory.pendingRows().filter((r) => r.dedupeKey === input.dedupeKey);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event).toBe('balance_low');
    expect(rows[0]!.payload).toEqual({ userId: 7, balance: '0.5' });
  });

  it('异 dedupeKey 各自成行', async () => {
    const { facade, memory } = buildFacade();
    await facade.enqueue({
      event: 'balance_low',
      payload: { userId: 1 },
      dedupeKey: 'balance-low:1:d1',
    });
    await facade.enqueue({
      event: 'balance_low',
      payload: { userId: 2 },
      dedupeKey: 'balance-low:2:d1',
    });
    expect(memory.pendingRows()).toHaveLength(2);
  });
});
