/**
 * 入箱:事件词表门 + dedupe 幂等写(dedupe_key 唯一冲突静默跳过)。
 * 业务侧需要与自身状态同事务入箱时走 ./composition bridge(本动词自持事务,
 * DbTx 不进 facade——总纲 §5.4)。fire-and-forget 场景由调用方持有(告警不反噬请求)。
 */
import type { Db } from '@tokenlens/db';
import type { NotifyStore } from '../ports/notify-store';
import { isNotifyEvent } from '../domain/events';
import { notificationsErrors } from '../errors';

export interface EnqueueDeps {
  readonly db: Db;
  readonly store: NotifyStore;
}

export interface EnqueueInput {
  readonly event: string;
  readonly payload: Record<string, unknown>;
  /** 业务自然键(如 balance-low:{userId}:{yyyyMMdd};DDL varchar(128)) */
  readonly dedupeKey: string;
}

export async function enqueue(deps: EnqueueDeps, input: EnqueueInput): Promise<void> {
  if (!isNotifyEvent(input.event)) {
    throw notificationsErrors.business('unknown_event', { event: input.event });
  }
  if (
    input.dedupeKey.length < 1 ||
    input.dedupeKey.length > 128 ||
    input.payload == null ||
    typeof input.payload !== 'object'
  ) {
    throw notificationsErrors.business('invalid_outbox_input', { dedupeKey: input.dedupeKey });
  }
  await deps.db.transaction((tx) =>
    deps.store.insertOutboxEvent(tx, {
      event: input.event,
      payload: input.payload,
      dedupeKey: input.dedupeKey,
    }),
  );
}
