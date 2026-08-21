import { describe, expect, it } from 'vitest';
import { peekFirstChunk } from '../src/internal/stream.js';

/**
 * 连接泄漏回归（审计 P0-4）：peekFirstChunk 的空流/中止/调用方放弃路径必须
 * cancel tee 的 branchB（完整上游 body），否则未消费未取消的分支让 undici
 * 连接永久保持打开——上游首帧错误持续发生时（重试最频繁的场景）耗尽连接池。
 *
 * 观测点：tee 两分支均 cancel 后底层源的 cancel 回调才触发；用「pending 源」
 * （连接仍打开）观测，已 close 的源按 spec cancel 为 no-op、无泄漏语义。
 */
describe('peekFirstChunk — 错误路径释放上游流', () => {
  it('空首块（空流判定）路径 cancel 底层源', async () => {
    let sourceCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(0)); // 空首块 → peek 判空流
        // 不 close：连接仍保持
      },
      cancel() {
        sourceCancelled = true;
      },
    });
    const peeked = await peekFirstChunk(body);
    expect(peeked.done).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(sourceCancelled).toBe(true);
  });

  it('读取中 abort → cancel 底层源', async () => {
    let sourceCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start() {}, // 挂起不吐数据
      cancel() {
        sourceCancelled = true;
      },
    });
    const ctrl = new AbortController();
    const peeking = peekFirstChunk(body, { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 10);
    await peeking; // abort → read 以 done 退出（现状），但 branchB 必须被释放
    await new Promise((r) => setTimeout(r, 10));
    expect(sourceCancelled).toBe(true);
  });

  it('调用前已 abort → 立即失败并 cancel 底层源（不得挂起）', async () => {
    let sourceCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start() {},
      cancel() {
        sourceCancelled = true;
      },
    });
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await Promise.race([
      peekFirstChunk(body, { signal: ctrl.signal }).then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise<'hang'>((r) => setTimeout(() => r('hang'), 500)),
    ]);
    expect(result).not.toBe('hang');
    await new Promise((r) => setTimeout(r, 10));
    expect(sourceCancelled).toBe(true);
  });

  it('调用方放弃 rest（首帧错误）时 cancel 释放', async () => {
    let sourceCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {}\n\n'));
        // 不 close：连接仍保持
      },
      cancel() {
        sourceCancelled = true;
      },
    });
    const peeked = await peekFirstChunk(body);
    expect(peeked.done).toBe(false);
    await peeked.rest!.cancel(); // 调用方（create-ai 首帧错误路径）放弃 rest
    await new Promise((r) => setTimeout(r, 10));
    expect(sourceCancelled).toBe(true);
  });
});
