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
 * 预读首个 chunk 检测空流，但不消费 body（用 tee 分流）。
 *   branchA 读首块检测空流 → 立即 cancel（不再读）
 *   branchB 是完整流（含首块），交给 relayStream pipeTo（保持流式特性）
 */
export async function peekFirstChunk(
  body: ReadableStream<Uint8Array>,
  opts: { signal?: AbortSignal } = {},
): Promise<PeekResult> {
  const [branchA, branchB] = body.tee();
  const reader = branchA.getReader();
  const onAbort = (): void => {
    void reader.cancel().catch(() => {});
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const { done, value } = await reader.read();
    void reader.cancel().catch(() => {});
    if (done) return { done: true };
    if (!value || value.length === 0) return { done: true };
    return { done: false, first: value, rest: branchB };
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
