/**
 * 协议面静默降级回归（2026-08-30 红测锁存 → 同日修复转绿）。
 *
 * 三类「丢而不报错」的修复面回归 + 行为锁定：
 * ① /v1/responses 子集 codec：tools/tool_choice/reasoning.effort/text.format
 *    映射进规范形（此前静默丢弃）；tool_calls 在响应/流式两面还原为
 *    function_call output item。previous_response_id/background 的显式 400
 *    由路由 schema 承担（gateway e2e protocol-parity 覆盖）。
 * ② azure-openai：能力声明收窄为已实现寻址的 chat/embeddings（此前继承 9 端点
 *    声明，7 个端点被 catch-all 静默错路由到 chat 部署路径）；探测改 Azure 形。
 * ③ input_audio 多模态：claude/gemini 出站无损转换（audio 块 / inlineData），
 *    原生形态透传（同协议往返不降级），claude 入站 audio 块归一为规范形。
 */
import { describe, expect, it } from 'vitest';
import { createAi, allowAllUrls } from '../src/index.js';
import { defined } from './defined';
import { AzureOpenAIAdapter } from '../src/adapters/azure-openai.js';
import {
  chatRequestToClaude,
  chatResponseToClaude,
  claudeRequestToChat,
  claudeResponseToChat,
} from '../src/protocol/claude-chat.js';
import { chatRequestToGemini, geminiRequestToChat } from '../src/protocol/gemini-chat.js';
import { chatResponseToResponses, responsesRequestToChat } from '../src/protocol/responses-chat.js';
import { canonicalStreamToResponsesStream } from '../src/protocol/responses-stream.js';

const ch = (baseUrl = 'https://x.test', protocol = 'openai-compatible') => ({
  baseUrl,
  apiKey: 'k',
  protocol,
});
const pi = { model: 'm', requestId: 'r', stream: false };

const audioPart = { type: 'input_audio', input_audio: { data: 'aGVsbG8=', format: 'wav' } };

const sseOf = (frames: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(frames.join('')));
      c.close();
    },
  });

describe('① responses codec：参数不再静默丢弃', () => {
  it('tools/tool_choice 映射进规范形（chat function 包裹形）', () => {
    const decoded = responsesRequestToChat({
      model: 'm',
      input: 'hi',
      tools: [
        {
          type: 'function',
          name: 'get_weather',
          description: 'd',
          parameters: { type: 'object', properties: {} },
        },
      ],
      tool_choice: 'auto',
    });
    expect(decoded.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'd',
          parameters: { type: 'object', properties: {} },
        },
      },
    ]);
    expect(decoded.tool_choice).toBe('auto');
  });
  it('tool_choice 具名 function 与 required 映射；非 function 工具不映射', () => {
    const decoded = responsesRequestToChat({
      model: 'm',
      input: 'hi',
      tool_choice: { type: 'function', name: 'get_weather' },
      tools: [{ type: 'web_search' }, { type: 'function', name: 'f' }],
    });
    expect(decoded.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
    expect(decoded.tools).toEqual([
      { type: 'function', function: { name: 'f', description: '', parameters: {} } },
    ]);
  });
  it('agentic 历史：function_call → assistant.tool_calls、function_call_output → tool 消息', () => {
    const decoded = responsesRequestToChat({
      model: 'm',
      input: [
        { role: 'user', content: '北京天气？' },
        {
          type: 'function_call',
          call_id: 'fc_1',
          name: 'get_weather',
          arguments: '{"city":"北京"}',
        },
        { type: 'function_call_output', call_id: 'fc_1', output: '{"temp":21}' },
      ],
    });
    const msgs = decoded.messages as Array<Record<string, unknown>>;
    expect(msgs).toHaveLength(3);
    expect(msgs[1]).toMatchObject({ role: 'assistant' });
    expect(JSON.stringify(msgs[1])).toContain('"tool_calls"');
    expect(JSON.stringify(msgs[1])).toContain('get_weather');
    expect(msgs[2]).toMatchObject({ role: 'tool', tool_call_id: 'fc_1', content: '{"temp":21}' });
    // 非字符串 output 序列化不丢
    const objectOutput = responsesRequestToChat({
      model: 'm',
      input: [{ type: 'function_call_output', call_id: 'c', output: { a: 1 } }],
    });
    expect((objectOutput.messages as Array<Record<string, unknown>>)[0]).toMatchObject({
      role: 'tool',
      tool_call_id: 'c',
      content: '{"a":1}',
    });
  });
  it('input 媒体块：input_image/input_audio 归一为规范形；非 data/http(s) scheme 退占位', () => {
    const decoded = responsesRequestToChat({
      model: 'm',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: '看和听' },
            { type: 'input_image', image_url: 'data:image/png;base64,aW1n' },
            { type: 'input_audio', input_audio: { data: 'aGVsbG8=', format: 'wav' } },
            { type: 'input_image', image_url: 'file:///etc/passwd' },
          ],
        },
      ],
    });
    const content =
      (decoded.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]?.content ?? [];
    expect(content).toEqual([
      { type: 'text', text: '看和听' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1n' } },
      { type: 'input_audio', input_audio: { data: 'aGVsbG8=', format: 'wav' } },
      { type: 'text', text: '' },
    ]);
  });
  it('reasoning.effort → reasoning_effort；text.format → response_format', () => {
    const decoded = responsesRequestToChat({
      model: 'm',
      input: 'hi',
      reasoning: { effort: 'medium' },
      text: { format: { type: 'json_object' } },
    });
    expect(decoded.reasoning_effort).toBe('medium');
    expect(decoded.response_format).toEqual({ type: 'json_object' });

    const schema = responsesRequestToChat({
      model: 'm',
      input: 'hi',
      text: {
        format: { type: 'json_schema', name: 'out', schema: { type: 'object' }, strict: true },
      },
    });
    expect(schema.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'out', schema: { type: 'object' }, strict: true },
    });
  });
  it('非流式响应：tool_calls 还原为 function_call output item', () => {
    const res = chatResponseToResponses({
      id: 'r1',
      model: 'm',
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"x"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }) as { output: Array<Record<string, unknown>> };
    expect(res.output).toHaveLength(1);
    expect(res.output[0]).toMatchObject({
      type: 'function_call',
      call_id: 'call_1',
      name: 'get_weather',
      arguments: '{"city":"x"}',
    });
  });
  it('流式：tool_calls 分片 → added/arguments.delta/done + completed.output 携带', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]}}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const out = await new Response(canonicalStreamToResponsesStream(sseOf([frames]))).text();
    expect(out).toContain('"type":"function_call"');
    expect(out).toContain('response.function_call_arguments.delta');
    expect(out).toContain('response.output_item.done');
    expect(out).toContain('response.completed');
    // SSE data 是 JSON 序列化文本（内引号带转义）——事件负载断言走解析而非裸子串
    const events = [...out.matchAll(/^data: (\{.*\})$/gm)].map(
      (m) => JSON.parse(String(m[1])) as Record<string, unknown>,
    );
    const itemDone = events.find(
      (e) =>
        e.type === 'response.output_item.done' &&
        (e.item as { type?: string })?.type === 'function_call',
    );
    expect((itemDone?.item as { arguments?: string })?.arguments).toBe('{"city":"x"}');
    const completed = events.find((e) => e.type === 'response.completed');
    const response = (completed?.response ?? {}) as {
      output?: Array<{ type?: string; arguments?: string }>;
      usage?: { input_tokens?: number };
    };
    expect(response.output?.[0]).toMatchObject({ type: 'function_call', name: 'get_weather' });
    expect(response.output?.[0]?.arguments).toBe('{"city":"x"}');
    expect(response.usage?.input_tokens).toBe(5);
    // 终态事件只发一次（DONE 分支发出后 flush 兜底不重复补发）
    expect(events.filter((e) => e.type === 'response.completed')).toHaveLength(1);
  });
  it('流式分桶：同 index 出现新 id = 新调用（参数不跨调用串接）；缺 index 按 id 分桶', async () => {
    const frames = [
      // 厂商复用 index=0 但换了 id——两段 arguments 分属两个调用，串接会产出
      // 静默语义损坏的 JSON（最危险形态）
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"f1","arguments":"{\\"a\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"arguments":"1}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_b","type":"function","function":{"name":"f2","arguments":"{\\"b\\":2}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const out = await new Response(canonicalStreamToResponsesStream(sseOf([frames]))).text();
    const events = [...out.matchAll(/^data: (\{.*\})$/gm)].map(
      (m) => JSON.parse(String(m[1])) as Record<string, unknown>,
    );
    const completed = defined(
      events.find((e) => e.type === 'response.completed'),
      'completed event',
    );
    const response = (completed.response ?? {}) as {
      output?: Array<{ type?: string; call_id?: string; arguments?: string }>;
    };
    const calls = (response.output ?? []).filter((o) => o.type === 'function_call');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ call_id: 'call_a', arguments: '{"a":1}' });
    expect(calls[1]).toMatchObject({ call_id: 'call_b', arguments: '{"b":2}' });
  });
  it('流式失败单终态：error 帧后 DONE/flush 不再补 completed（失败不被成功遮蔽）', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"部分"}}]}\n\n',
      'data: {"error":{"code":"overloaded","message":"upstream overloaded"}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const out = await new Response(canonicalStreamToResponsesStream(sseOf([frames]))).text();
    expect(out).toContain('response.failed');
    expect(out).not.toContain('event: response.completed');
    expect(out).not.toContain('event: response.incomplete');
  });
  it('流式正文：output_text.done 携带全文、completed.output 携带 message', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"世界"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const out = await new Response(canonicalStreamToResponsesStream(sseOf([frames]))).text();
    expect(out).toContain('response.output_text.done');
    expect(out).toContain('"text":"你好世界"');
    const completed = /event: response\.completed\ndata: (\{.*)\n\n/.exec(out)?.[1];
    expect(JSON.parse(String(completed)).response.output[0].content[0].text).toBe('你好世界');
  });
  it('reasoning：非流式 reasoning_content → reasoning output item；thinking 双向归一', () => {
    const res = chatResponseToResponses({
      id: 'r1',
      model: 'm',
      choices: [{ message: { role: 'assistant', content: '答', reasoning_content: '想一想' } }],
    }) as { output: Array<Record<string, unknown>> };
    expect(res.output[0]).toMatchObject({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: '想一想' }],
    });
    // claude thinking 块 → 规范形 reasoning_content → /v1/messages 面还原 thinking 块
    const canonical = claudeResponseToChat({
      id: 'm1',
      model: 'c',
      content: [
        { type: 'thinking', thinking: '先想', signature: 'sig' },
        { type: 'text', text: '答' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 2 },
    });
    const message = ((canonical as { choices: Array<{ message: Record<string, unknown> }> })
      .choices[0]?.message ?? {}) as { reasoning_content?: string; content?: string };
    expect(message.reasoning_content).toBe('先想');
    const back = chatResponseToClaude(canonical) as { content: Array<Record<string, unknown>> };
    expect(back.content[0]).toMatchObject({ type: 'thinking', thinking: '先想' });
  });
  it('流式 reasoning：reasoning_content 增量 → summary 事件 + 终态 output 携带 reasoning', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"reasoning_content":"先"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"答"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const out = await new Response(canonicalStreamToResponsesStream(sseOf([frames]))).text();
    expect(out).toContain('"type":"reasoning"');
    expect(out).toContain('response.reasoning_summary_text.delta');
    const events = [...out.matchAll(/^data: (\{.*\})$/gm)].map(
      (m) => JSON.parse(String(m[1])) as Record<string, unknown>,
    );
    const completed = defined(
      events.find((e) => e.type === 'response.completed'),
      'completed event',
    );
    const response = (completed.response ?? {}) as {
      output?: Array<{ type?: string; summary?: Array<{ text?: string }> }>;
    };
    expect(response.output?.[0]).toMatchObject({ type: 'reasoning' });
    expect(response.output?.[0]?.summary?.[0]?.text).toBe('先想');
  });
  it('截断：finish_reason=length → 非流式 incomplete / 流式 response.incomplete 事件', async () => {
    const nonstream = chatResponseToResponses({
      id: 'r1',
      model: 'm',
      choices: [{ message: { role: 'assistant', content: '截' }, finish_reason: 'length' }],
    }) as { status: string; incomplete_details?: { reason: string } };
    expect(nonstream.status).toBe('incomplete');
    expect(nonstream.incomplete_details).toEqual({ reason: 'max_output_tokens' });

    const frames = [
      'data: {"choices":[{"delta":{"content":"长"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":3,"completion_tokens":9,"total_tokens":12}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const out = await new Response(canonicalStreamToResponsesStream(sseOf([frames]))).text();
    expect(out).toContain('response.incomplete');
    expect(out).not.toContain('event: response.completed');
    const events = [...out.matchAll(/^data: (\{.*\})$/gm)].map(
      (m) => JSON.parse(String(m[1])) as Record<string, unknown>,
    );
    const incomplete = defined(
      events.find((e) => e.type === 'response.incomplete'),
      'incomplete event',
    );
    const response = (incomplete.response ?? {}) as {
      status?: string;
      incomplete_details?: { reason: string };
    };
    expect(response.status).toBe('incomplete');
    expect(response.incomplete_details).toEqual({ reason: 'max_output_tokens' });
  });
});

describe('② azure：声明面收窄 + 探测 Azure 形', () => {
  it('supportedEndpoints 收窄为已实现寻址的两端点', () => {
    expect(AzureOpenAIAdapter.supportedEndpoints).toEqual(['chat', 'embeddings']);
  });
  it('已实现端点的寻址与认证头不变（部署制 + api-key）', () => {
    const chat = AzureOpenAIAdapter.planRequest(ch('https://x.openai.azure.com', 'azure-openai'), {
      ...pi,
      endpoint: 'chat',
    });
    expect(chat.path).toContain('/openai/deployments/m/chat/completions');
    expect(chat.path).toContain('api-version=');
    expect(chat.headers['api-key']).toBe('k');
    expect(
      AzureOpenAIAdapter.planRequest(ch('https://x.openai.azure.com', 'azure-openai'), {
        ...pi,
        endpoint: 'embeddings',
      }).path,
    ).toContain('/openai/deployments/m/embeddings');
  });
  it('探测请求：/openai/models + api-key 头（非 Bearer /v1/models）', () => {
    const probes = AzureOpenAIAdapter.probeRequests(
      ch('https://x.openai.azure.com', 'azure-openai'),
    );
    expect(probes[0]?.path).toContain('/openai/models');
    expect(probes[0]?.headers['api-key']).toBe('k');
    expect(probes[0]?.headers.authorization).toBeUndefined();
  });
  it('能力门：未声明端点（images）→ 明确 invalid_config（不再静默错路由）', async () => {
    const ai = createAi(
      {
        retry: {
          maxAttempts: 1,
          baseDelayMs: 5,
          maxDelayMs: 10,
          jitterRatio: 0,
          deadlineMs: 5000,
          emptyCompletionRetries: 0,
        },
        timeout: { connectMs: 2000, totalMs: 5000 },
        stream: { heartbeatIdleMs: 60_000, firstByteTimeoutMs: 2000, inactivityTimeoutMs: 5000 },
      },
      { guardUrl: allowAllUrls },
    );
    const r = await ai.chat(
      ch('https://x.test', 'azure-openai'),
      { model: 'm', messages: [] },
      {
        endpoint: 'images',
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('invalid_config');
      expect(r.error.message).toContain('does not support endpoint images');
    }
  });
});

describe('③ input_audio：出站无损转换 + 原生形态透传 + 入站归一', () => {
  it('claude 出站：input_audio → audio 块（base64 + audio/wav media_type）', () => {
    const out = chatRequestToClaude({
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: '听这段' }, audioPart] }],
    });
    expect(JSON.stringify(out)).toContain('aGVsbG8=');
    const blocks = (
      (out as { messages: Array<{ content: Array<Record<string, unknown>> }> }).messages[0]
        ?.content ?? []
    ).filter((b) => b.type === 'audio');
    expect(blocks[0]).toEqual({
      type: 'audio',
      source: { type: 'base64', media_type: 'audio/wav', data: 'aGVsbG8=' },
    });
  });
  it('gemini 出站：input_audio → inlineData（audio/wav）', () => {
    const out = chatRequestToGemini({
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: '听这段' }, audioPart] }],
    });
    const parts = (
      (out as { contents: Array<{ parts: Array<Record<string, unknown>> }> }).contents[0]?.parts ??
      []
    ).filter((p) => p.inlineData !== undefined);
    expect(parts[0]?.inlineData).toEqual({ mimeType: 'audio/wav', data: 'aGVsbG8=' });
  });
  it('media_type 已带 audio/ 前缀的格式不重复加前缀；缺 data 的残块退空文本', () => {
    const out = chatRequestToGemini({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'input_audio', input_audio: { data: 'QQ==', format: 'audio/mpeg' } },
            { type: 'input_audio', input_audio: { format: 'wav' } },
          ],
        },
      ],
    });
    const parts =
      (out as { contents: Array<{ parts: Array<Record<string, unknown>> }> }).contents[0]?.parts ??
      [];
    expect(parts[0]?.inlineData).toEqual({ mimeType: 'audio/mpeg', data: 'QQ==' });
    expect(parts[1]).toEqual({ text: '' });
  });
  it('claude 入站 audio 块 → 规范形 input_audio（跨协议路由可继续转换）', () => {
    const decoded = claudeRequestToChat({
      model: 'm',
      max_tokens: 10,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '听' },
            {
              type: 'audio',
              source: { type: 'base64', media_type: 'audio/wav', data: 'aGVsbG8=' },
            },
          ],
        },
      ],
    });
    const content =
      (decoded.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]?.content ?? [];
    expect(content.some((p) => JSON.stringify(p).includes('aGVsbG8='))).toBe(true);
    expect(
      content.some((p) => p.type === 'input_audio' && JSON.stringify(p).includes('"format":"wav"')),
    ).toBe(true);
  });
  it('同协议往返：原生 claude image/audio 块与 gemini inlineData/fileData 透传不降级', () => {
    const claudeOut = chatRequestToClaude({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1n' } },
            {
              type: 'audio',
              source: { type: 'url', url: 'https://cdn.test/a.wav' },
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(claudeOut)).toContain('aW1n');
    expect(JSON.stringify(claudeOut)).toContain('https://cdn.test/a.wav');
    expect(JSON.stringify(claudeOut)).not.toContain('"text":""');

    const geminiOut = chatRequestToGemini({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { inlineData: { mimeType: 'audio/wav', data: 'aGVsbG8=' } },
            { fileData: { mimeType: 'image/png', fileUri: 'https://g.test/x.png' } },
          ],
        },
      ],
    });
    expect(JSON.stringify(geminiOut)).toContain('aGVsbG8=');
    expect(JSON.stringify(geminiOut)).toContain('https://g.test/x.png');
    expect(JSON.stringify(geminiOut)).not.toContain('"text":""');
  });
  it('未知 part 类型仍降级空文本占位（消息结构保留——既有语义锁定）', () => {
    const out = chatRequestToClaude({
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'mystery' }] }],
    });
    expect(JSON.stringify(out)).toContain('"text":""');
    const gem = chatRequestToGemini({
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'mystery' }] }],
    });
    expect(JSON.stringify(gem)).toContain('"text":""');
  });
  it('gemini 入站：inlineData/fileData 媒体归一为规范形（image_url / input_audio）', () => {
    const decoded = geminiRequestToChat(
      {
        contents: [
          {
            role: 'user',
            parts: [
              { text: '看和听' },
              { inlineData: { mimeType: 'image/png', data: 'aW1n' } },
              { inlineData: { mimeType: 'audio/wav', data: 'aGVsbG8=' } },
              { fileData: { mimeType: 'image/png', fileUri: 'https://g.test/x.png' } },
            ],
          },
        ],
      },
      'm',
    );
    const content =
      (decoded.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]?.content ?? [];
    expect(content).toEqual([
      { type: 'text', text: '看和听' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1n' } },
      { type: 'input_audio', input_audio: { data: 'aGVsbG8=', format: 'wav' } },
      { type: 'image_url', image_url: { url: 'https://g.test/x.png' } },
    ]);
  });
  it('跨协议闭环：claude 原生 image 入站 → 规范形 → gemini 出站还原 inlineData', () => {
    const canonical = claudeRequestToChat({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '图' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1n' } },
          ],
        },
      ],
    });
    const geminiOut = chatRequestToGemini(canonical);
    const parts =
      (geminiOut as { contents: Array<{ parts: Array<Record<string, unknown>> }> }).contents[0]
        ?.parts ?? [];
    expect(parts).toEqual([
      { text: '图' },
      { inlineData: { mimeType: 'image/png', data: 'aW1n' } },
    ]);
  });
});
