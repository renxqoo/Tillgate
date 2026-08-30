/**
 * protocol codec 深支矩阵（claude-chat / gemini-chat / completions-chat 纯函数面）：
 * 内容块映射（data URL/远程图/垃圾块）、tool_choice 双方言全枚举、finish_reason
 * 双向映射表、usage 方言（1h 缓存档/字符串数字）、客户端方向 codec
 * （chatResponseToClaude / chatResponseToGemini 整函数此前零覆盖）。
 * 表驱动直调纯函数——每个断言锁定一条方言映射行为（改表即红）。
 */
import { describe, expect, it } from 'vitest';
import {
  claudeRequestToChat,
  chatRequestToClaude,
  claudeResponseToChat,
  chatResponseToClaude,
  claudeUsageToUsage,
  DEFAULT_CLAUDE_MAX_TOKENS,
} from '../src/protocol/claude-chat.js';
import {
  geminiRequestToChat,
  chatRequestToGemini,
  geminiResponseToChat,
  chatResponseToGemini,
  geminiUsageToUsage,
} from '../src/protocol/gemini-chat.js';
import { canonicalStreamToGeminiStream } from '../src/protocol/gemini-stream.js';
import { completionsRequestToChat } from '../src/protocol/completions-chat.js';
import { defined } from './defined';

type Rec = Record<string, unknown>;
const msgs = (r: Rec): Rec[] => (r.messages ?? []) as Rec[];

const pick = (req: Rec): number =>
  chatRequestToClaude({ messages: [], ...req }).max_tokens as number;
const tcOf = (choice: unknown): unknown =>
  chatRequestToClaude({ model: 'm', messages: [], tool_choice: choice }).tool_choice;
const stopOf = (res: Rec): unknown => chatResponseToClaude(res).stop_reason;
const sseOf = (frames: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(c) {
      const e = new TextEncoder();
      for (const f of frames) c.enqueue(e.encode(f));
      c.close();
    },
  });

// ─────────────────── claude-chat：内容块与守卫 ───────────────────

describe('claude 内容块映射（chatContentToClaude / claudeContentToChat）', () => {
  it('入站 data URL 图 → base64 source；http(s) 远程 → url source；垃圾 url → 空文本占位（scheme 白名单）', () => {
    const cl = chatRequestToClaude({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,QQ==' } },
            { type: 'image_url', image_url: { url: 'https://cdn.example.com/x.png' } },
            { type: 'image_url', image_url: { url: 42 } },
          ],
        },
      ],
    });
    const blocks = (cl.messages as Rec[])[0]?.content as Rec[];
    expect(blocks[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'QQ==' },
    });
    expect(blocks[1]).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://cdn.example.com/x.png' },
    });
    // 非 data/http(s) scheme（含数字等垃圾）不中继给上游——退空文本占位
    expect(blocks[2]).toEqual({ type: 'text', text: '' });
  });
  it('空字符串 content → 空块数组；非对象 part 与未知 type → 占位 text 块（不丢消息结构）', () => {
    const empty = chatRequestToClaude({
      model: 'm',
      messages: [{ role: 'assistant', content: '' }],
    });
    expect((empty.messages as Rec[])[0]?.content).toEqual([]);
    const junk = chatRequestToClaude({
      model: 'm',
      messages: [{ role: 'user', content: [42, { type: 'weird' }, { type: 'text', text: 7 }] }],
    });
    expect((junk.messages as Rec[])[0]?.content).toEqual([
      { type: 'text', text: '' },
      { type: 'text', text: '' },
      { type: 'text', text: '' },
    ]);
  });
  it('claude → chat：未知/残块不产出；image/audio 块归一为规范形（跨协议路由）', () => {
    const chat = claudeRequestToChat({
      model: 'c',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'mystery' },
            7,
            { type: 'image', source: {} },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'aW1n' },
            },
            {
              type: 'audio',
              source: { type: 'base64', media_type: 'audio/wav', data: 'aGVsbG8=' },
            },
          ],
        },
      ],
    });
    const content = msgs(chat)[0]?.content;
    // 未知块/非 JSON/残缺源不入列；媒体块归一（image → image_url data URL，audio → input_audio）
    expect(content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1n' } },
      { type: 'input_audio', input_audio: { data: 'aGVsbG8=', format: 'wav' } },
    ]);
  });
});

describe('claude 入站请求深支（claudeRequestToChat）', () => {
  it('tool_choice 方言表：auto→auto / any→required / tool(named)→function / tool(无名)忽略', () => {
    expect(
      claudeRequestToChat({ model: 'm', messages: [], tool_choice: { type: 'auto' } }).tool_choice,
    ).toBe('auto');
    expect(
      claudeRequestToChat({ model: 'm', messages: [], tool_choice: { type: 'any' } }).tool_choice,
    ).toBe('required');
    expect(
      claudeRequestToChat({ model: 'm', messages: [], tool_choice: { type: 'tool', name: 'fn' } })
        .tool_choice,
    ).toEqual({ type: 'function', function: { name: 'fn' } });
    expect(
      claudeRequestToChat({ model: 'm', messages: [], tool_choice: { type: 'tool', name: 1 } })
        .tool_choice,
    ).toBeUndefined();
  });
  it('可选参数透传矩阵 + tools 非对象项过滤', () => {
    const chat = claudeRequestToChat({
      model: 'c',
      messages: [],
      max_tokens: 8,
      temperature: 0.5,
      top_p: 0.9,
      stop_sequences: ['E', 1],
      stream: true,
      tools: [null, { name: 'f' }],
    });
    expect(chat).toMatchObject({
      max_tokens: 8,
      temperature: 0.5,
      top_p: 0.9,
      stop: ['E', '1'],
      stream: true,
    });
    expect((chat.tools as Rec[]).length).toBe(1);
  });
  it('消息数组垃圾容错：非对象消息跳过；未知 role 归 user；assistant tool_use 缺字段兜底', () => {
    const chat = claudeRequestToChat({
      model: 'c',
      messages: [
        7,
        { role: 'system', content: 'mid' },
        { role: 'assistant', content: [] },
        { role: 'assistant', content: [{ type: 'tool_use' }] },
      ],
    });
    const roles = msgs(chat).map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'assistant']); // 首条垃圾跳过；claude 无 system role → 归 user
    const [firstCall] = defined(
      defined(msgs(chat)[2], 'msgs[2]').tool_calls as Rec[],
      'tool_calls',
    );
    const call = defined(firstCall, 'tool_calls[0]');
    expect(call).toMatchObject({ id: 'call_x', type: 'function' });
    expect((call.function as Rec).name).toBe('');
    expect((call.function as Rec).arguments).toBe('{}');
  });
  it('tool_result 与文本并存 → tool 消息在前 + 原角色消息在后（块序契约）', () => {
    const chat = claudeRequestToChat({
      model: 'c',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }] },
          ],
        },
      ],
    });
    const m = msgs(chat);
    expect(m[0]).toMatchObject({ role: 'tool', tool_call_id: 't1', content: 'ok' });
    expect(m[1]).toMatchObject({ role: 'user', content: 'hi' });
  });
  it('system：空字符串与空文本数组不产 system 消息', () => {
    expect(msgs(claudeRequestToChat({ model: 'm', system: '', messages: [] })).length).toBe(0);
    expect(
      msgs(claudeRequestToChat({ model: 'm', system: [{ text: '' }], messages: [] })).length,
    ).toBe(0);
  });
});

describe('claude 出站请求深支（chatRequestToClaude）', () => {
  it('max_tokens 解析链：正数直用 → 0/负数弃 → max_completion_tokens → 默认 4096', () => {
    expect(pick({ max_tokens: 5 })).toBe(5);
    expect(pick({ max_tokens: 0, max_completion_tokens: 7 })).toBe(7);
    expect(pick({ max_tokens: -1 })).toBe(DEFAULT_CLAUDE_MAX_TOKENS);
    expect(pick({})).toBe(DEFAULT_CLAUDE_MAX_TOKENS);
  });
  it('assistant 工具调用：非法 JSON 参数兜底 {}；缺 id 用 tool_u_x；非对象项跳过', () => {
    const cl = chatRequestToClaude({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            7,
            { id: 'c1', function: { name: 'f', arguments: '{bad' } },
            { function: { name: 'g', arguments: '{"a":1}' } },
          ],
        },
      ],
    });
    const blocks = (cl.messages as Rec[])[0]?.content as Rec[];
    expect(blocks.filter((b) => b.type === 'tool_use').length).toBe(2);
    expect(blocks[0]).toMatchObject({ type: 'tool_use', id: 'c1', input: {} });
    expect(blocks[1]).toMatchObject({ type: 'tool_use', id: 'tool_u_x', input: { a: 1 } });
  });
  it('system/developer 合并（非字符串 content 走 JSON 序列化）；tool 消息非字符串 content 序列化', () => {
    const cl = chatRequestToClaude({
      model: 'm',
      messages: [
        { role: 'system', content: 'a' },
        { role: 'developer', content: ['b'] },
        { role: 'tool', tool_call_id: 'c', content: { ok: true } },
      ],
    });
    expect(cl.system).toBe('a\n["b"]');
    const toolMsg = defined((cl.messages as Rec[])[0], 'cl.messages[0]');
    expect(toolMsg.role).toBe('user');
    expect((toolMsg.content as Rec[])[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'c',
      content: '{"ok":true}',
    });
  });
  it('tool_choice 方言表：auto / required|any / named / named(无名)忽略；tools 缺 function 项过滤', () => {
    expect(tcOf('auto')).toEqual({ type: 'auto' });
    expect(tcOf('required')).toEqual({ type: 'any' });
    expect(tcOf('any')).toEqual({ type: 'any' });
    expect(tcOf({ type: 'function', function: { name: 'fn' } })).toEqual({
      type: 'tool',
      name: 'fn',
    });
    expect(tcOf({ type: 'function', function: {} })).toBeUndefined();
    const cl = chatRequestToClaude({
      model: 'm',
      messages: [],
      tools: [7, { function: { name: 'f' } }],
    });
    expect((cl.tools as Rec[]).length).toBe(1);
    expect(cl.tools).toEqual([{ name: 'f', description: '', input_schema: { type: 'object' } }]);
  });
});

describe('claudeUsageToUsage：方言与容错', () => {
  it('1h 缓存档并入 cacheCreation；cache_read 超总额钳到总额', () => {
    const u = claudeUsageToUsage({
      input_tokens: 2,
      output_tokens: 1,
      cache_read_input_tokens: 99,
      cache_creation_input_tokens: 3,
      cache_creation: { ephemeral_1h_input_tokens: 4 },
    });
    expect(u).toMatchObject({ promptTokens: 108, cachedTokens: 99, cacheCreationTokens: 7 });
  });
  it('缺 output_tokens / 缺 input_tokens / 非对象 → null（严格双字段口径）', () => {
    expect(claudeUsageToUsage({ input_tokens: 1 })).toBeNull();
    expect(claudeUsageToUsage({ output_tokens: 1 })).toBeNull();
    expect(claudeUsageToUsage('x')).toBeNull();
    expect(claudeUsageToUsage(null)).toBeNull();
  });
});

describe('claude 非流式响应双向（claudeResponseToChat / chatResponseToClaude）', () => {
  it('stop_reason 映射表 + 未知非空归 stop + 空归 null', () => {
    const fr = (stop?: unknown): unknown =>
      (claudeResponseToChat({ content: [], stop_reason: stop }).choices as Rec[])[0]?.finish_reason;
    expect(fr('end_turn')).toBe('stop');
    expect(fr('stop_sequence')).toBe('stop');
    expect(fr('max_tokens')).toBe('length');
    expect(fr('tool_use')).toBe('tool_calls');
    expect(fr('refusal')).toBe('content_filter');
    expect(fr('weird')).toBe('stop');
    expect(fr()).toBeNull();
  });
  it('tool_use 块 → tool_calls；usage 缺失不产 usage 键', () => {
    const chat = claudeResponseToChat({
      content: [{ type: 'tool_use', id: 'u1', name: 'fn', input: { a: 1 } }],
    });
    const call = defined(
      ((defined((chat.choices as Rec[])[0], 'choices[0]').message as Rec).tool_calls as Rec[])[0],
      'tool_calls[0]',
    );
    expect(call).toEqual({
      id: 'u1',
      type: 'function',
      function: { name: 'fn', arguments: '{"a":1}' },
    });
    expect(chat.usage).toBeUndefined();
  });
  it('chatResponseToClaude：文本+工具调用+usage 还原（客户端方向整链路）', () => {
    const cl = chatResponseToClaude({
      id: 'r1',
      model: 'm',
      choices: [
        {
          message: {
            content: 'hi',
            tool_calls: [
              { id: 'c1', function: { name: 'f', arguments: '{"a":1}' } },
              { id: 'c2', function: { name: 'g', arguments: '{bad' } },
              7,
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 1 },
      },
    });
    expect(cl.id).toBe('r1');
    expect(cl.stop_reason).toBe('tool_use');
    expect(cl.content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'tool_use', id: 'c1', name: 'f', input: { a: 1 } },
      { type: 'tool_use', id: 'c2', name: 'g', input: {} },
    ]);
    expect(cl.usage).toEqual({ input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 1 });
  });
  it('chatResponseToClaude：finish 映射表 + 全缺省兜底', () => {
    expect(stopOf({ choices: [{ finish_reason: 'stop' }] })).toBe('end_turn');
    expect(stopOf({ choices: [{ finish_reason: 'length' }] })).toBe('max_tokens');
    expect(stopOf({ choices: [{ finish_reason: 'content_filter' }] })).toBe('refusal');
    expect(stopOf({ choices: [{ finish_reason: 'x' }] })).toBe('end_turn');
    expect(stopOf({})).toBe('end_turn');
    expect(chatResponseToClaude({}).id).toBe('msg_gateway');
    expect(chatResponseToClaude({}).usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });
});

// ─────────────────── gemini-chat：四个方向深支 ───────────────────

describe('gemini 入站请求深支（geminiRequestToChat）', () => {
  it('tools functionDeclarations 提取 + toolConfig 全枚举（ANY 命名 / AUTO / 缺 config）', () => {
    const chat = geminiRequestToChat(
      {
        model: 'm',
        messages: undefined,
        tools: [
          {
            functionDeclarations: [{ name: 'f', description: 'd', parameters: { type: 'object' } }],
          },
          7,
        ],
        toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['f'] } },
      },
      'm',
    );
    expect(chat.tools).toEqual([
      {
        type: 'function',
        function: { name: 'f', description: 'd', parameters: { type: 'object' } },
      },
    ]);
    expect(chat.tool_choice).toEqual({ type: 'function', function: { name: 'f' } });
    expect(
      geminiRequestToChat({ toolConfig: { functionCallingConfig: { mode: 'AUTO' } } }, 'm')
        .tool_choice,
    ).toBe('auto');
    expect(
      geminiRequestToChat({ toolConfig: { functionCallingConfig: { mode: 'ANY' } } }, 'm')
        .tool_choice,
    ).toBeUndefined();
    expect(geminiRequestToChat({ toolConfig: 7 }, 'm').tool_choice).toBeUndefined();
  });
  it('generationConfig 全参 + responseMimeType json + contents 垃圾容错', () => {
    const chat = geminiRequestToChat(
      {
        contents: [7, { role: 'user', parts: [{ functionResponse: { response: { ok: 1 } } }] }],
        generationConfig: {
          maxOutputTokens: 9,
          temperature: 0.1,
          topP: 0.2,
          stopSequences: ['E', 1],
          responseMimeType: 'application/json',
        },
      },
      'm',
    );
    expect(chat).toMatchObject({
      max_tokens: 9,
      temperature: 0.1,
      top_p: 0.2,
      stop: ['E', '1'],
      response_format: { type: 'json_object' },
    });
    expect(msgs(chat)[0]).toMatchObject({ role: 'tool', tool_call_id: '', content: '{"ok":1}' });
  });
  it('B-G1 回归：functionCall 非对象标量不崩（过滤后仅合法项成 call）', () => {
    const chat = geminiRequestToChat(
      {
        contents: [
          { role: 'model', parts: [{ functionCall: 7 }, { functionCall: { name: 'f' } }] },
        ],
      },
      'm',
    );
    const calls = msgs(chat)[0]?.tool_calls as Rec[];
    expect(calls.length).toBe(1);
    expect((defined(calls[0], 'calls[0]').function as Rec).name).toBe('f');
  });
  it('assistant functionCall 缺字段兜底；user 纯文本 join', () => {
    const chat = geminiRequestToChat(
      {
        contents: [
          { role: 'model', parts: [{ functionCall: { args: { a: 1 } } }, { functionCall: 7 }] },
          { role: 'user', parts: [{ text: 'a' }, { text: 'b' }] },
        ],
      },
      'm',
    );
    const calls = msgs(chat)[0]?.tool_calls as Rec[];
    expect(calls.length).toBe(1);
    expect(calls[0]?.function as Rec).toEqual({ name: '', arguments: '{"a":1}' });
    expect(msgs(chat)[1]?.content).toBe('ab');
  });
});

describe('gemini 出站请求深支（chatRequestToGemini）', () => {
  it('chatContentToParts：未知/非对象 part → 空 text part；远程图 URL → fileData；空字符串 → 空数组', () => {
    const g = chatRequestToGemini({
      model: 'm',
      messages: [
        { role: 'user', content: '' },
        {
          role: 'user',
          content: [
            7,
            { type: 'mystery' },
            { type: 'image_url', image_url: { url: 'https://cdn/x.png' } },
          ],
        },
      ],
    });
    const contents = g.contents as Rec[];
    expect((defined(contents[0], 'contents[0]').parts as Rec[]).length).toBe(0);
    expect(contents[1]?.parts).toEqual([
      { text: '' },
      { text: '' },
      { fileData: { fileUri: 'https://cdn/x.png' } },
    ]);
  });
  it('system/developer 非字符串 content 序列化合并；tool 消息非法 JSON content 兜底 {}', () => {
    const g = chatRequestToGemini({
      model: 'm',
      messages: [
        { role: 'system', content: { a: 1 } },
        { role: 'tool', tool_call_id: 'c1', content: '{bad' },
      ],
    });
    expect(((g.systemInstruction as Rec).parts as Rec[])[0]?.text).toBe('{"a":1}');
    const firstPart = defined(
      (defined((g.contents as Rec[])[0], 'contents[0]').parts as Rec[])[0],
      'parts[0]',
    );
    const fr = firstPart.functionResponse as Rec;
    expect(fr).toMatchObject({ name: 'c1', response: {} });
  });
  it('assistant 工具调用：非法 JSON 参数兜底 {}；缺 function 项跳过；user 多模态 data URL', () => {
    const g = chatRequestToGemini({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            7,
            { function: { name: 'f', arguments: '{bad' } },
            { function: { name: 'g', arguments: '{}' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AA' } }],
        },
      ],
    });
    const modelParts = (defined((g.contents as Rec[])[0], 'contents[0]').parts as Rec[]).filter(
      (p) => p.functionCall !== undefined,
    );
    expect(modelParts.length).toBe(2);
    expect(modelParts[0]).toEqual({ functionCall: { name: 'f', args: {} } });
    expect((defined((g.contents as Rec[])[1], 'contents[1]').parts as Rec[])[0]).toEqual({
      inlineData: { mimeType: 'image/jpeg', data: 'AA' },
    });
  });
  it('maxOutputTokens 解析链与 generationConfig 省略', () => {
    expect(chatRequestToGemini({ messages: [] }).generationConfig).toBeUndefined();
    expect(
      (
        chatRequestToGemini({ messages: [], max_tokens: 0, max_completion_tokens: 5 })
          .generationConfig as Rec
      ).maxOutputTokens,
    ).toBe(5);
    // max_tokens 非正且无 max_completion_tokens → 无 maxOutputTokens（其余键也缺 → 整节省略）
    expect(chatRequestToGemini({ messages: [], max_tokens: -3 }).generationConfig).toBeUndefined();
  });
  it('tool_choice 方言表：auto→AUTO / none→NONE / required→ANY / named→ANY+allowlist / named(无名)忽略', () => {
    const fcc = (choice: unknown): Rec =>
      (chatRequestToGemini({ messages: [], tool_choice: choice }).toolConfig as Rec)
        .functionCallingConfig as Rec;
    expect(fcc('auto')).toEqual({ mode: 'AUTO' });
    expect(fcc('none')).toEqual({ mode: 'NONE' });
    expect(fcc('required')).toEqual({ mode: 'ANY' });
    expect(fcc({ type: 'function', function: { name: 'fn' } })).toEqual({
      mode: 'ANY',
      allowedFunctionNames: ['fn'],
    });
    expect(
      chatRequestToGemini({ messages: [], tool_choice: { type: 'function', function: {} } })
        .toolConfig,
    ).toBeUndefined();
  });
  it('tools → functionDeclarations 单包 + 缺参兜底', () => {
    const g = chatRequestToGemini({ messages: [], tools: [7, { function: { name: 'f' } }] });
    expect(g.tools).toEqual([
      { functionDeclarations: [{ name: 'f', description: '', parameters: { type: 'object' } }] },
    ]);
  });
});

describe('gemini 非流式响应双向', () => {
  it('finishReason 映射表 + functionCall part → tool_calls + responseId 兜底', () => {
    const fr = (reason?: unknown): unknown =>
      (geminiResponseToChat({ candidates: [{ finishReason: reason }] }, 'm').choices as Rec[])[0]
        ?.finish_reason;
    expect(fr('STOP')).toBe('stop');
    expect(fr('MAX_TOKENS')).toBe('length');
    expect(fr('SAFETY')).toBe('content_filter');
    expect(fr('RECITATION')).toBe('content_filter');
    expect(fr('OTHER')).toBe('stop');
    expect(fr('WEIRD')).toBe('stop');
    expect(fr()).toBeNull();
    const chat = geminiResponseToChat(
      {
        responseId: 'g1',
        candidates: [{ content: { parts: [{ functionCall: { name: 'f', args: { a: 1 } } }, 7] } }],
      },
      'm',
    );
    expect(chat.id).toBe('g1');
    const call = defined(
      ((defined((chat.choices as Rec[])[0], 'choices[0]').message as Rec).tool_calls as Rec[])[0],
      'tool_calls[0]',
    );
    expect(call).toEqual({
      id: 'call_g0',
      type: 'function',
      function: { name: 'f', arguments: '{"a":1}' },
    });
    expect(geminiResponseToChat({}, 'm').id).toBe('chatcmpl-gemini');
  });
  it('chatResponseToGemini：文本+工具+usage 还原（客户端方向整链路）', () => {
    const g = chatResponseToGemini({
      model: 'm',
      choices: [
        {
          message: {
            content: 'hi',
            tool_calls: [
              { id: 'c1', function: { name: 'f', arguments: '{"a":1}' } },
              { id: 'c2', function: { name: 'g', arguments: '{bad' } },
              7,
            ],
          },
          finish_reason: 'length',
        },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    });
    const cand = defined((g.candidates as Rec[])[0], 'candidates[0]');
    expect((cand.content as Rec).parts).toEqual([
      { text: 'hi' },
      { functionCall: { name: 'f', args: { a: 1 } } },
      { functionCall: { name: 'g', args: {} } },
    ]);
    expect(cand?.finishReason).toBe('MAX_TOKENS');
    expect(g.usageMetadata).toEqual({
      promptTokenCount: 4,
      candidatesTokenCount: 2,
      totalTokenCount: 6,
    });
  });
  it('chatResponseToGemini：finish 映射表 + 缺 usage 归零', () => {
    const reasonOf = (res: Rec): unknown =>
      (chatResponseToGemini(res).candidates as Rec[])[0]?.finishReason;
    expect(reasonOf({ choices: [{ finish_reason: 'stop' }] })).toBe('STOP');
    expect(reasonOf({ choices: [{ finish_reason: 'content_filter' }] })).toBe('SAFETY');
    expect(reasonOf({ choices: [{ finish_reason: 'x' }] })).toBe('STOP');
    expect(reasonOf({})).toBe('STOP');
    expect(chatResponseToGemini({}).usageMetadata).toEqual({
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
    });
  });
  it('geminiUsageToUsage：cached 无 prompt 时钳 0 + thoughts 计入 output', () => {
    expect(
      geminiUsageToUsage({
        promptTokenCount: 0,
        candidatesTokenCount: 1,
        cachedContentTokenCount: 5,
      }),
    ).toMatchObject({ cachedTokens: 0, completionTokens: 1 });
    expect(
      geminiUsageToUsage({ promptTokenCount: 1, candidatesTokenCount: 1, thoughtsTokenCount: 2 }),
    ).toMatchObject({ completionTokens: 3 });
    expect(geminiUsageToUsage({ promptTokenCount: 1 })).toBeNull();
  });
});

describe('canonicalStreamToGeminiStream：客户端方向流式深支', () => {
  const read = async (frames: string[]): Promise<string> =>
    new Response(canonicalStreamToGeminiStream(sseOf(frames), 'm')).text();
  it('finish_reason length → MAX_TOKENS 终帧；空 delta 不产帧；usage 非数字字段保持旧值', async () => {
    const out = await read([
      'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":"x","completion_tokens":3}}\n\n',
      'data: [DONE]\n\n',
    ]);
    expect(out).toContain('"finishReason":"MAX_TOKENS"');
    expect(out).toContain('"candidatesTokenCount":3');
    expect(out).toContain('"promptTokenCount":0');
  });
  it('tool_calls：无名项跳过；坏 JSON 参数兜底 {}；有名项带 args', async () => {
    const out = await read([
      'data: {"choices":[{"delta":{"tool_calls":[7,{"index":0,"function":{"name":"f","arguments":"{bad"}},{"index":1,"function":{"name":"g","arguments":"{}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    expect(out).toContain('"functionCall":{"name":"f","args":{}}');
    expect(out).toContain('"functionCall":{"name":"g","args":{}}');
  });
  it('错误帧非对象兜底 + data:null/坏 JSON 不崩；无 [DONE] 结束 → flush 兜底终帧', async () => {
    const out = await read(['data: {"error":"plain"}\n\n', 'data: null\n', 'data: {bad\n']);
    expect(out).toContain('"error"');
    expect(out).toContain('"finishReason":"STOP"');
  });
});

// ─────────────────── completions-chat：prompt 形态 ───────────────────

describe('completionsRequestToChat：prompt 形态矩阵', () => {
  it('嵌套 token 数组项 String([]) 拼接 + 顶层参数透传', () => {
    const chat = completionsRequestToChat({
      model: 'm',
      prompt: [['a'], 'b', 7],
      temperature: 1,
      max_tokens: 5,
    });
    // 嵌套数组项取 String(asArray(p))；非字符串标量 asArray → [] → ''（口径：不丢已有项、不猜数字）
    expect(msgs(chat)[0]?.content).toBe('ab');
    expect(chat).toMatchObject({ temperature: 1, max_tokens: 5 });
  });
  it('无 prompt → 空消息数组；system 前插', () => {
    expect(msgs(completionsRequestToChat({ model: 'm' })).length).toBe(0);
    const chat = completionsRequestToChat({ model: 'm', prompt: 'p', system: 'S' });
    expect(msgs(chat)[0]).toMatchObject({ role: 'system', content: 'S' });
  });
});
