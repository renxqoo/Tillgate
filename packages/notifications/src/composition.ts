/**
 * 装配子入口(内部 workspace 契约,非公开 API):
 * 业务能力包(accounts/billing/control-plane 的 adapter)或 app assembly 需要与
 * 自身业务状态**同一事务**写入 outbox 时,经此 bridge 参与;DbTx 不进根 facade。
 * 仅 app assembly、迁移脚本与 adapter 集成测试可引用本入口。
 */
import type { DbTx } from '@tillgate/db';
import { notifyOutbox } from '@tillgate/db';
import { isNotifyEvent } from './domain/events';
import { notificationsErrors } from './errors';

export interface OutboxEnqueueInput {
  readonly event: string;
  readonly payload: Record<string, unknown>;
  readonly dedupeKey: string;
}

export interface OutboxWithinTx {
  /** 词表门 + 幂等写(唯一冲突静默跳过);入箱失败随业务事务回滚 */
  enqueue(input: OutboxEnqueueInput): Promise<void>;
}

export function outboxWithinTx(tx: DbTx): OutboxWithinTx {
  return {
    async enqueue(input) {
      if (!isNotifyEvent(input.event)) {
        throw notificationsErrors.business('unknown_event', { event: input.event });
      }
      if (
        input.dedupeKey.length === 0 ||
        input.dedupeKey.length > 128 ||
        // payload 必须是纯对象：数组 typeof 也是 'object'，一并拒绝（jsonb 落库前收口）
        input.payload == null ||
        typeof input.payload !== 'object' ||
        Array.isArray(input.payload)
      ) {
        throw notificationsErrors.business('invalid_outbox_input', { dedupeKey: input.dedupeKey });
      }
      await tx.insert(notifyOutbox).values(input).onConflictDoNothing();
    },
  };
}
