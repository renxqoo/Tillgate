/**
 * 尝试开始事件的统一发射（chat/stream 两个尝试执行体共用——事件时序契约
 * 见 events.ts 头注释：attempt_start 是每次尝试的第一个事件）。
 */
import type { AiEvent } from '../events';
import type { CallCtx } from './context';

export function emitAttemptStart(
  emit: (e: AiEvent) => void,
  input: { ctx: CallCtx; key: string; attempt: number },
): void {
  const { ctx, key, attempt } = input;
  emit({
    type: 'attempt_start',
    requestId: ctx.requestId,
    channelKey: key,
    attempt,
    atMs: Date.now(),
  });
}
