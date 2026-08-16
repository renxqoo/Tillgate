/**
 * SSE 响应模型名改写：对外隐藏真实上游模型（externalName ↔ realModel 映射的响应侧闭环）。
 *
 * 字节流不保证行边界 → 逐行缓冲；只对 `data: {json}` 帧解析后改写 model 字段
 * （不做字符串替换，model 出现在 content 里也不会误伤）；[DONE]/注释/非 JSON 原样透传。
 * 改写失败（畸形 JSON）按透传处理：不因观测改写破坏可用性。
 */
export function rewriteSseModel(
  stream: ReadableStream<Uint8Array>,
  externalModel: string,
  sanitize?: (frame: Record<string, unknown>) => Record<string, unknown>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  function rewriteLine(line: string): string {
    if (!line.startsWith('data:')) return line;
    const payload = line.slice(5).trimStart();
    if (!payload.startsWith('{')) return line;
    try {
      let obj = JSON.parse(payload) as { model?: unknown; error?: unknown; message?: unknown };
      const isErrorFrame = obj.error !== undefined || obj.message !== undefined;
      if (typeof obj.model === 'string') obj.model = externalModel;
      // 错误帧 message 脱敏：上游真实模型名/供应商/URL 不得经错误面出站
      if (isErrorFrame && sanitize) {
        obj = sanitize(obj) as { model?: unknown };
        return `data: ${JSON.stringify(obj)}`;
      }
      if (typeof obj.model !== 'string') return line;
      return `data: ${JSON.stringify(obj)}`;
    } catch {
      return line;
    }
  }

  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        // 按换行切出完整行；行尾 \r 归一（SSE 规范 CRLF）
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const raw = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
          controller.enqueue(encoder.encode(`${rewriteLine(line)}\n`));
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer.length > 0) {
          const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
          controller.enqueue(encoder.encode(rewriteLine(line)));
        }
      },
    }),
  );
}
