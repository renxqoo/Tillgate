import { describe, expect, it } from 'vitest';
import { rewriteSseModel } from '../sse-model-rewrite.js';

/**
 * SSE 响应模型名改写（对外隐藏真实上游模型）：
 *   - 只改 `data: {json}` 帧里的 model 字段（chat.completion.chunk / 通用对象）
 *   - `data: [DONE]`、注释行、非 JSON 行原样透传
 *   - 跨 chunk 撕裂的行要缓冲拼接（字节流不保证行边界）
 *   - model 名出现在 content 等其他字段时绝不能误伤（只解析 JSON 改字段，不做字符串替换）
 */

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const dec = new TextDecoder();
  let out = '';
  await stream.pipeTo(
    new WritableStream<Uint8Array>({
      write(chunk) {
        out += dec.decode(chunk, { stream: true });
      },
    }),
  );
  return out + dec.decode();
}

function chunksOf(text: string, splitAt: number[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  const cuts = [0, ...splitAt, bytes.length];
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < cuts.length - 1; i++) {
        c.enqueue(bytes.slice(cuts[i]!, cuts[i + 1]!));
      }
      c.close();
    },
  });
}

describe('rewriteSseModel', () => {
  it('改写 data 帧的 model 字段；[DONE]/注释/非 JSON 行透传', async () => {
    const input =
      ': keep-alive\n\n' +
      'data: {"id":"1","object":"chat.completion.chunk","model":"deepseek-v3:free","choices":[]}\n\n' +
      'data: [DONE]\n\n';
    const out = await collect(rewriteSseModel(chunksOf(input, [7, 30]), 'gpt-proxy-4o'));
    expect(out).toContain('"model":"gpt-proxy-4o"');
    expect(out).not.toContain('deepseek-v3:free');
    expect(out).toContain('data: [DONE]');
    expect(out).toContain(': keep-alive');
  });

  it('跨 chunk 撕裂的 JSON 行正确缓冲改写', async () => {
    const line = 'data: {"model":"qwen3.5:0.8b","choices":[{"delta":{"content":"a"}}]}\n\n';
    // 撕裂点切在 "model":" 的中间
    const out = await collect(rewriteSseModel(chunksOf(line, [9, 16, 40]), 'my-external'));
    expect(out.trim()).toBe(
      'data: {"model":"my-external","choices":[{"delta":{"content":"a"}}]}',
    );
  });

  it('content 里包含真实模型名字符串时不受影响（只改 JSON model 字段）', async () => {
    const line =
      'data: {"model":"real-x","choices":[{"delta":{"content":"try real-x and \\"model\\":\\"real-x\\""}}]}\n\n';
    const out = await collect(rewriteSseModel(chunksOf(line, [25]), 'ext-y'));
    expect(out).toContain('"model":"ext-y"');
    expect(out).toContain('try real-x');
  });

  it('无 model 字段的 JSON 帧与二进制安全透传', async () => {
    const input = 'data: {"object":"ping"}\n\n';
    const out = await collect(rewriteSseModel(chunksOf(input, [5]), 'ext'));
    expect(out.trim()).toBe('data: {"object":"ping"}');
  });
});
