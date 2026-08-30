/**
 * OpenAI Responses ⇄ Chat 入站 codec（/v1/responses 端点用，仅客户端方向）。
 *
 * ① responsesRequestToChat  Responses 请求 → 规范形 chat 请求
 * ② chatResponseToResponses 规范形非流式响应 → Responses 响应
 * （流式 ③ 见 responses-stream.ts——同 claude/gemini codec 家族按职责拆分）
 *
 * 请求覆盖子集：input（string 或 message 数组）、instructions→system、
 * max_output_tokens、temperature、top_p、stream、tools/tool_choice（function 定义
 * ⇄ chat function 包裹形双向映射）、reasoning.effort→reasoning_effort、
 * text.format→response_format（json_object / json_schema）。非 function 工具
 * （web_search 等宿主侧工具）无 chat 规范形对应——路由 schema 显式 400。
 * 响应覆盖子集：reasoning（thinking/reasoning_content 归一 summary）、正文 text、
 * function_call（tool_calls ⇄ output item 双向）、usage、
 * finish_reason=length → status incomplete + incomplete_details。
 *
 * 状态性语义边界（网关无状态——路由 schema 显式 400，不在本 codec 层）：
 * previous_response_id / background:true 被拒绝；store 恒不生效（等价 store:false，
 * 响应总是全量返回调用方）。
 */

export type Json = Record<string, unknown>;

// 守卫三件套（responses codec 家族内部共享：responses-chat 与 responses-stream 单一实现）
export function asJson(v: unknown): Json | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null;
}
export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** responses input 条目可接受的角色词表（developer 映射 system） */
const RESPONSES_INPUT_ROLES = new Set(['user', 'assistant', 'system', 'developer']);

/** Responses 扁平 function 定义 → chat function 包裹形（非 function 类型不映射；
 *  description/parameters 缺省补空——与 claude codec 的工具映射口径一致） */
function responsesToolsToChat(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out = tools.flatMap((t) => {
    const tool = asJson(t);
    if (tool == null || tool.type !== 'function') return [];
    return [
      {
        type: 'function',
        function: {
          name: str(tool.name) ?? '',
          description: str(tool.description) ?? '',
          parameters: tool.parameters ?? {},
          ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
        },
      },
    ];
  });
  return out.length > 0 ? out : undefined;
}

/** Responses tool_choice → chat tool_choice（auto/none/required/具名 function） */
function responsesToolChoiceToChat(v: unknown): unknown | undefined {
  if (v === 'auto' || v === 'none' || v === 'required') return v;
  const tc = asJson(v);
  if (tc?.type === 'function' && typeof tc.name === 'string') {
    return { type: 'function', function: { name: tc.name } };
  }
  return undefined;
}

/** Responses text.format → chat response_format（json_object / json_schema；text 不映射） */
function responsesTextFormatToChat(v: unknown): unknown | undefined {
  const format = asJson(v);
  if (format == null) return undefined;
  if (format.type === 'json_object') return { type: 'json_object' };
  if (format.type === 'json_schema') {
    return {
      type: 'json_schema',
      json_schema: {
        ...(format.name !== undefined ? { name: str(format.name) ?? '' } : {}),
        ...(format.description !== undefined ? { description: str(format.description) ?? '' } : {}),
        ...(format.schema !== undefined ? { schema: format.schema } : {}),
        ...(format.strict !== undefined ? { strict: format.strict } : {}),
      },
    };
  }
  return undefined;
}

/** input_image 块 → 规范形 image_url part（image_url 接受字符串或 {url}；
 *  非 data/http(s) scheme 退占位——防 file:/内网中继） */
function inputImageBlockToPart(p: Json): Record<string, unknown> {
  const raw = p.image_url;
  const url = str(raw) ?? str(asJson(raw)?.url) ?? '';
  if (url && (url.startsWith('data:') || /^https?:\/\//i.test(url))) {
    return { type: 'image_url', image_url: { url } };
  }
  return { type: 'text', text: '' };
}

/** input_audio 块 → 规范形 input_audio part（缺 data 退占位） */
function inputAudioBlockToPart(p: Json): Record<string, unknown> {
  const audio = asJson(p.input_audio);
  const data = str(audio?.data) ?? '';
  const format = str(audio?.format) ?? '';
  if (data) return { type: 'input_audio', input_audio: { data, format } };
  return { type: 'text', text: '' };
}

/** 单个 input 内容块 → 规范形 part（未知块退文本占位不丢结构） */
function inputBlockToPart(b: unknown): Record<string, unknown> {
  const p = asJson(b);
  if (p == null) return { type: 'text', text: '' };
  if (p.type === 'input_image') return inputImageBlockToPart(p);
  if (p.type === 'input_audio') return inputAudioBlockToPart(p);
  return { type: 'text', text: str(p.text) ?? '' };
}

/** input 内容块数组 → 规范形 content（全文本 join 字符串；含媒体用 part 数组） */
function inputContentOf(v: unknown): string | Array<Record<string, unknown>> {
  if (typeof v === 'string') return v;
  const blocks = asArray(v).map(inputBlockToPart);
  const allText = blocks.every((b) => b.type === 'text');
  if (allText) return blocks.map((b) => (b as { text: string }).text).join('');
  return blocks;
}

/** 扁平历史 item（无 role）→ chat 消息（null = 不产出）：
 *  function_call → assistant.tool_calls；function_call_output → role:tool；
 *  reasoning 历史不回放（与 claude thinking 历史策略一致） */
function flatInputItemToMessage(m: Json): Record<string, unknown> | null {
  if (m.type === 'function_call') {
    const callId = str(m.call_id) ?? str(m.id) ?? '';
    return {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: callId,
          type: 'function',
          function: { name: str(m.name) ?? '', arguments: str(m.arguments) ?? '{}' },
        },
      ],
    };
  }
  if (m.type === 'function_call_output') {
    const { output } = m;
    return {
      role: 'tool',
      tool_call_id: str(m.call_id) ?? '',
      content: typeof output === 'string' ? output : JSON.stringify(output ?? ''),
    };
  }
  return null;
}

/**
 * responses input（string 或 item 数组）→ chat messages。有角色 item → 对应消息
 * （developer→system；content 媒体归一）；扁平历史 item 双映射——agentic 第二轮
 * 的调用/结果回传，丢任一半即断链。
 */
function responsesInputToMessages(r: Json): unknown[] {
  const messages: unknown[] = [];
  const instructions = str(r.instructions);
  if (instructions) messages.push({ role: 'system', content: instructions });
  if (typeof r.input === 'string') {
    messages.push({ role: 'user', content: r.input });
    return messages;
  }
  for (const item of asArray(r.input)) {
    const m = asJson(item);
    if (!m) continue;
    const role = str(m.role);
    if (role !== undefined && RESPONSES_INPUT_ROLES.has(role)) {
      messages.push({
        role: role === 'developer' ? 'system' : role,
        content: inputContentOf(m.content),
      });
      continue;
    }
    const flat = flatInputItemToMessage(m);
    if (flat != null) messages.push(flat);
  }
  return messages;
}

export function responsesRequestToChat(req: unknown): Json {
  const r = asJson(req) ?? {};
  const out: Json = { model: str(r.model) ?? '', messages: responsesInputToMessages(r) };
  if (typeof r.max_output_tokens === 'number') out.max_tokens = r.max_output_tokens;
  if (typeof r.temperature === 'number') out.temperature = r.temperature;
  if (typeof r.top_p === 'number') out.top_p = r.top_p;
  if (r.stream === true) out.stream = true;
  const tools = responsesToolsToChat(r.tools);
  if (tools !== undefined) out.tools = tools;
  const toolChoice = responsesToolChoiceToChat(r.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  const reasoning = asJson(r.reasoning);
  if (typeof reasoning?.effort === 'string') out.reasoning_effort = reasoning.effort;
  const responseFormat = responsesTextFormatToChat(asJson(r.text)?.format);
  if (responseFormat !== undefined) out.response_format = responseFormat;
  return out;
}

/** chat tool_calls → Responses function_call output item */
function toolCallToFunctionItem(call: unknown): Json | null {
  const c = asJson(call);
  const fn = asJson(c?.function);
  if (c == null || fn == null) return null;
  const id = str(c.id) ?? '';
  return {
    type: 'function_call',
    id,
    call_id: id,
    name: str(fn.name) ?? '',
    arguments: str(fn.arguments) ?? '{}',
    status: 'completed',
  };
}

/** Responses reasoning output item（上游 thinking 归一为 summary 文本；流式面共用） */
export const reasoningItem = (status: 'in_progress' | 'completed', text: string): Json => ({
  type: 'reasoning',
  id: 'rs_gateway',
  summary: status === 'completed' ? [{ type: 'summary_text', text }] : [],
});

/** chat 响应 → Responses output 数组：reasoning + 正文 message + function_call items */
function chatOutputToResponsesOutput(message: Json, text: string): unknown[] {
  const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
  const functionCalls = asArray(message.tool_calls)
    .map(toolCallToFunctionItem)
    .filter((x): x is Json => x != null);
  const output: unknown[] = [];
  if (reasoning) output.push(reasoningItem('completed', reasoning));
  if (text || functionCalls.length === 0) {
    output.push({
      type: 'message',
      id: 'msg_gateway',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }
  output.push(...functionCalls);
  return output;
}

/** chat usage → Responses usage（三 token 字段缺省 0；流式面同口径） */
export function usageOf(usage: Json | null): {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
} {
  return {
    input_tokens: typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
    output_tokens: typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : 0,
    total_tokens: typeof usage?.total_tokens === 'number' ? usage.total_tokens : 0,
  };
}

export function chatResponseToResponses(res: unknown): Json {
  const r = asJson(res) ?? {};
  const choice = asJson(asArray(r.choices)[0]) ?? {};
  const message = asJson(choice.message) ?? {};
  const text = typeof message.content === 'string' ? message.content : '';
  // finish_reason=length（输出预算截断）→ Responses 语义 incomplete + 截断原因
  const incomplete = choice.finish_reason === 'length';
  return {
    id: str(r.id) ?? 'resp_gateway',
    object: 'response',
    created_at: typeof r.created === 'number' ? r.created : Math.floor(Date.now() / 1000),
    status: incomplete ? 'incomplete' : 'completed',
    ...(incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    model: str(r.model) ?? '',
    output: chatOutputToResponsesOutput(message, text),
    usage: usageOf(asJson(r.usage)),
  };
}
