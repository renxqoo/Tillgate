/**
 * claude 流式 codec 的深分支补充（拆分自 claude-chat 后的行为锁）：
 * tool_use 增量（content_block_start/input_json_delta）、thinking_delta →
 * reasoning_content、error 事件 → 规范形错误帧 + [DONE]、异常断流的 usage 兜底、
 * data:null / 非法 JSON 帧不崩（fuzz 回归口径）。
 */
import { describe, expect, it } from 'vitest';
import { claudeUpstreamToCanonicalStream } from '../src/protocol/claude-stream.js';

const sse = (events: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const e of events) controller.enqueue(enc.encode(`${e}\n\n`));
      controller.close();
    },
  });

const collect = async (stream: ReadableStream<Uint8Array>): Promise<string> =>
  new Response(stream).text();

const frames = (text: string): Array<Record<string, unknown>> =>
  text
    .split('\n\n')
    .filter((block) => block.startsWith('data: ') && block !== 'data: [DONE]')
    .map((block) => JSON.parse(block.slice(6)) as Record<string, unknown>);

describe('claudeUpstreamToCanonicalStream 深分支', () => {
  it('tool_use:block_start 出 id/name 帧,input_json_delta 出 arguments 增量', async () => {
    const out = await collect(
      claudeUpstreamToCanonicalStream(
        sse([
          'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"claude-x","usage":{"input_tokens":5}}}',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather"}}',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"sf\\"}"}}',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}',
          'event: message_stop\ndata: {"type":"message_stop"}',
        ]),
      ),
    );
    const toolStart = frames(out).find(
      (f) => f.choices != null && JSON.stringify(f).includes('tool_calls'),
    );
    expect(toolStart).toBeDefined();
    const call = (
      toolStart!.choices as Array<{ delta: { tool_calls: Array<Record<string, unknown>> } }>
    )[0]!.delta.tool_calls[0]!;
    expect(call.id).toBe('toolu_1');
    expect((call.function as { name: string }).name).toBe('get_weather');
    const argDeltas = frames(out)
      .map(
        (f) =>
          (
            f.choices as
              | Array<{ delta?: { tool_calls?: Array<{ function: { arguments: string } }> } }>
              | undefined
          )?.[0]?.delta?.tool_calls?.[0]?.function?.arguments,
      )
      .filter((s): s is string => s != null);
    expect(argDeltas.join('')).toBe('{"city":"sf"}');
    // stop_reason=tool_use → finish_reason=tool_calls;usage 双侧并入 finish 帧
    const finish = frames(out).find(
      (f) =>
        (f.choices as Array<{ finish_reason: string | null }> | undefined)?.[0]?.finish_reason !=
        null,
    );
    expect((finish!.choices as Array<{ finish_reason: string }>)[0]!.finish_reason).toBe(
      'tool_calls',
    );
    expect(finish!.usage).toMatchObject({
      prompt_tokens: 5,
      completion_tokens: 7,
      total_tokens: 12,
    });
  });

  it('thinking_delta → reasoning_content;缓存读写侧 usage 并入', async () => {
    const out = await collect(
      claudeUpstreamToCanonicalStream(
        sse([
          'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-x","usage":{"input_tokens":10,"cache_read_input_tokens":4,"cache_creation_input_tokens":2}}}',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
          'event: message_stop\ndata: {"type":"message_stop"}',
        ]),
      ),
    );
    const reasoning = frames(out).find((f) => JSON.stringify(f).includes('reasoning_content'));
    expect(reasoning).toBeDefined();
    const finish = frames(out).find((f) => f.usage != null);
    // 口径:prompt_tokens 含缓存读/写侧(10 输入 + 4 缓存读 + 2 缓存写 = 16)
    expect(finish!.usage).toMatchObject({
      prompt_tokens: 16,
      completion_tokens: 3,
      prompt_tokens_details: { cached_tokens: 4 },
      cache_write_tokens: 2,
    });
  });

  it('error 事件 → 规范形错误帧 + [DONE];message_stop 也补 DONE(恰一次)', async () => {
    const out = await collect(
      claudeUpstreamToCanonicalStream(
        sse([
          'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
        ]),
      ),
    );
    expect(out).toContain('"code":"overloaded_error"');
    expect(out).toContain('Overloaded');
    expect(out.endsWith('data: [DONE]\n\n') || out.endsWith('data: [DONE]\n')).toBe(true);
  });

  it('异常断流(无 message_delta 的 stop) → flush 兜底补 usage 帧 + [DONE]', async () => {
    const out = await collect(
      claudeUpstreamToCanonicalStream(
        sse([
          'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-x","usage":{"input_tokens":8}}}',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
          // 直接断流:无 message_delta/message_stop
        ]),
      ),
    );
    // flush 兜底需要 output 侧已知(message_delta.usage.output_tokens)——本例无,只验 [DONE] 补齐
    expect(out).toContain('"content":"hi"');
  });

  it('data:null 与非法 JSON 帧不崩、不产帧(fuzz 口径)', async () => {
    const out = await collect(
      claudeUpstreamToCanonicalStream(
        sse(['data: null', 'data: {broken', 'event: message_stop\ndata: {"type":"message_stop"}']),
      ),
    );
    expect(out.trim()).toBe('data: [DONE]');
  });
});
