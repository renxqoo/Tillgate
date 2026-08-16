import { describe, expect, it } from 'vitest';
import { relayStream, type RelayStreamEvent } from '../../src/transport/relay-stream.js';

/**
 * 红测（new-api #6649 同类）：客户端在收到 [DONE] 之后立刻断开（HTTP/1.1 流式
 * 客户端的标准行为）时，本应「正常完成」的流被误分类为 client_disconnect。
 *
 * 现状：relay-stream 的 cancel() 回调（relay-stream.ts:202-216）不检查 scanner
 * 是否已收到 [DONE]/终止帧——只要 readable 被 cancel 就一律发
 * terminated='client_disconnect'。下游影响：usage_logs.stream_aborted=true、
 * span 记「用户取消」；无 usage 的流还会走 recordEstimatedCancel（估算结算）。
 *
 * 本测只证明 bug 存在，不修复（修复方向：cancel() 先判 hasDone/hasTerminalFrame，
 * 已完成的流按正常完成归类）。
 */

const enc = (s: string) => new TextEncoder().encode(s);

describe('relay-stream：[DONE] 后客户端立刻断开（#6649 同类红测）', () => {
  it('已完成（收到 [DONE]）的流被客户端关闭 → 不得归类为 client_disconnect', async () => {
    // 上游：usage 帧 + [DONE]，然后保持连接不关（制造「客户端先关」的竞态窗口）
    let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
    });
    const events: RelayStreamEvent[] = [];
    const handle = relayStream(upstream, { heartbeatIdleMs: 1000, inactivityTimeoutMs: 5000 });
    handle.onEvent((e) => events.push(e));

    ctrl!.enqueue(
      enc(
        'data: ' +
          JSON.stringify({
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }) +
          '\n\n',
      ),
    );
    ctrl!.enqueue(enc('data: [DONE]\n\n'));

    // 客户端读完两个 chunk（含 [DONE]）后立刻断开——标准 HTTP/1.1 客户端行为
    const reader = handle.stream.getReader();
    let seenDone = false;
    while (!seenDone) {
      const { done, value } = await reader.read();
      if (done) break;
      if (new TextDecoder().decode(value).includes('[DONE]')) seenDone = true;
    }
    expect(seenDone).toBe(true);
    await reader.cancel(); // 客户端在 [DONE] 后关闭连接

    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent).toBeDefined();
    if (doneEvent!.type !== 'done') throw new Error('unreachable');
    // 期望：正常完成（无 terminated 或非 client_disconnect），且 usage 保留。
    // 现状：terminated='client_disconnect' → 红。
    expect(doneEvent!.terminated).not.toBe('client_disconnect');
    expect(doneEvent!.usage).not.toBeNull();
  });
});
