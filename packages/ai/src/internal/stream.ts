/**
 * 流式首帧探测（D3：流式空完成判定）。
 *
 * 用途：chatStream 拿到 200 Response 后、交给 relayStream 之前，预读首个 chunk。
 *   - 上游立即 EOF（无任何 data 帧）→ 空完成，可在 withRetry 内按 empty 重试（≤ emptyCompletionRetries）。
 *   - 有首帧 → 把 first + 剩余 reader 包装成新 ReadableStream，无缝交给 relayStream。
 *
 * 与 readBody 同样的 signal 接入：abort 时 cancel reader，让 pending 的 read() 退出（不 hang）。
 */

export interface PeekResult {
  /** true = 上游空流（EOF，无任何 chunk） */
  done: boolean;
  /** 首帧（done=false 时有值） */
  first?: Uint8Array;
  /** 剩余流：first 之后的内容（含 first 已被预取的语义——rest 会先吐 first 再继续读上游） */
  rest?: ReadableStream<Uint8Array>;
}

/**
 * 预读首个 chunk。超时/abort 时抛 Error（调用方按 timeout/network 分类）。
 * 注意：返回的 rest 已消费 first.value，调用方应使用 rest 而非原 body。
 */
export async function peekFirstChunk(
  body: ReadableStream<Uint8Array>,
  opts: { signal?: AbortSignal } = {},
): Promise<PeekResult> {
  const reader = body.getReader();
  const onAbort = (): void => {
    void reader.cancel().catch(() => {});
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const { done, value } = await reader.read();
    if (done) {
      // 上游空流：reader 已释放，body 无需再读
      return { done: true };
    }
    if (!value || value.length === 0) {
      // 边界：读到空 chunk（极少见），按 done 处理避免空帧进入 relay
      return { done: true };
    }
    // 有首帧：包装 rest = [first] + 原始 reader 剩余
    const first = value;
    const rest = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first); // 先吐首帧
      },
      async pull(controller) {
        try {
          const r = await reader.read();
          if (r.done) {
            controller.close();
            return;
          }
          if (r.value) controller.enqueue(r.value);
        } catch (err) {
          controller.error(err);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return { done: false, first, rest };
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
