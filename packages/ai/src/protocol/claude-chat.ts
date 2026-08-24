/**
 * Claude Messages ⇄ OpenAI Chat 非流式 codec（chat 家族，relaykit 等价物）。
 *
 * 规范形 = OpenAI chat/completions（请求/响应）。本文件四个方向中的非流式三个：
 *   ① claudeRequestToChat   入站 /v1/messages 请求 → 规范形请求
 *   ② chatRequestToClaude   规范形请求 → Claude /v1/messages 请求（anthropic 上游适配器用）
 *   ③ claudeResponseToChat  Claude 非流式响应 → 规范形响应；chatResponseToClaude 反向（客户端面）
 * 流式双向转换见 claude-stream.ts（按职责拆分：本文件不装流式状态机）。
 *
 * usage 语义归一：cache_read_input_tokens → cachedInputTokens；
 * cache_creation_input_tokens 计入未缓存输入（发生写入成本，按 input 价计）。
 * max_tokens：Claude 必填——规范形缺省时用 DEFAULT_CLAUDE_MAX_TOKENS。
 */

export const DEFAULT_CLAUDE_MAX_TOKENS = 4096;

type Json = Record<string, unknown>;

// 守卫三件套（claude codec 家族内部共享：claude-chat 与 claude-stream 单一实现）
export function asJson(v: unknown): Json | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null;
}
export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

// ─────────────────────────── 内容块映射 ───────────────────────────

/** chat message.content → claude content blocks */
function chatContentToClaude(content: unknown): unknown[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return asArray(content).map((part) => {
    const p = asJson(part);
    if (!p) return { type: 'text', text: '' };
    if (p.type === 'text' && typeof p.text === 'string') return { type: 'text', text: p.text };
    if (p.type === 'image_url') {
      const url = str(asJson(p.image_url)?.url) ?? '';
      // data URL → base64 source；远程 URL 不转换（claude 支持 url source）
      const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
      if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
      return { type: 'image', source: { type: 'url', url } };
    }
    return { type: 'text', text: '' };
  });
}

/** claude content blocks → chat content（文本 join 为 string；含工具/图像时用块数组） */
function claudeContentToChat(blocks: unknown): string | Array<Record<string, unknown>> {
  const arr = asArray(blocks);
  const out: Array<Record<string, unknown>> = [];
  let textOnly = true;
  for (const b of arr) {
    const block = asJson(b);
    if (!block) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text });
    } else if (
      block.type === 'image' ||
      block.type === 'tool_use' ||
      block.type === 'tool_result' ||
      block.type === 'thinking'
    ) {
      textOnly = false;
      // 复杂块保留原样（规范形 passthrough——OpenAI 形态无法表达的部分不强行降级）
      out.push(block as Record<string, unknown>);
    } else {
      textOnly = false;
    }
  }
  if (textOnly) return out.map((b) => (b as { text: string }).text).join('');
  return out;
}

// ─────────────────────────── ① 入站请求 → 规范形 ───────────────────────────

// eslint-disable-next-line complexity, max-lines-per-function -- 双向 codec：字段级形状穷举（请求方言矩阵），拆分需跨函数线程化中间状态，存量棘轮（铁律 22⑥）
export function claudeRequestToChat(req: unknown): Json {
  const r = asJson(req) ?? {};
  const messages: unknown[] = [];
  // system（string 或 blocks）→ 首条 system message
  const system = str(r.system);
  if (system) messages.push({ role: 'system', content: system });
  else if (Array.isArray(r.system)) {
    const text = asArray(r.system)
      .map((b) => str(asJson(b)?.text) ?? '')
      .join('');
    if (text) messages.push({ role: 'system', content: text });
  }
  for (const m of asArray(r.messages)) {
    const msg = asJson(m);
    if (!msg) continue;
    let role;
    if (str(msg.role) === 'assistant') role = 'assistant';
    else if (str(msg.role) === 'user') role = 'user';
    else role = 'user';
    // 工具结果块（user 消息里的 tool_result）→ chat tool 消息
    const blocks = asArray(msg.content);
    const toolResults = blocks.filter((b) => asJson(b)?.type === 'tool_result');
    if (toolResults.length > 0) {
      for (const tr of toolResults) {
        const t = asJson(tr);
        // 过滤谓词已保证 tool_result 块 asJson 非空；收窄分支仅为类型系统
        if (t === null) continue;
        messages.push({
          role: 'tool',
          tool_call_id: str(t.tool_use_id) ?? '',
          content: claudeContentToChat(t.content ?? str(t.content)),
        });
      }
      const rest = blocks.filter((b) => asJson(b)?.type !== 'tool_result');
      if (rest.length > 0) messages.push({ role, content: claudeContentToChat(rest) });
      continue;
    }
    // assistant 工具调用块 → chat tool_calls
    const toolUses = blocks.filter((b) => asJson(b)?.type === 'tool_use');
    const entry: Json = { role, content: claudeContentToChat(msg.content) };
    if (role === 'assistant' && toolUses.length > 0) {
      entry.tool_calls = toolUses.flatMap((tu) => {
        const t = asJson(tu);
        // 过滤谓词已保证 tool_use 块 asJson 非空；收窄分支仅为类型系统
        if (t === null) return [];
        return [
          {
            id: str(t.id) ?? `call_${str(t.id) ?? 'x'}`,
            type: 'function',
            function: { name: str(t.name) ?? '', arguments: JSON.stringify(t.input ?? {}) },
          },
        ];
      });
    }
    messages.push(entry);
  }
  const out: Json = { model: str(r.model) ?? '', messages };
  if (typeof r.max_tokens === 'number') out.max_tokens = r.max_tokens;
  if (typeof r.temperature === 'number') out.temperature = r.temperature;
  if (typeof r.top_p === 'number') out.top_p = r.top_p;
  if (Array.isArray(r.stop_sequences)) out.stop = r.stop_sequences.map((s) => String(s));
  if (r.stream === true) out.stream = true;
  if (Array.isArray(r.tools)) {
    out.tools = r.tools
      .map((t) => {
        const tool = asJson(t);
        if (!tool) return null;
        return {
          type: 'function',
          function: {
            name: str(tool.name) ?? '',
            description: str(tool.description) ?? '',
            parameters: tool.input_schema ?? {},
          },
        };
      })
      .filter(Boolean);
  }
  const tc = asJson(r.tool_choice);
  if (tc) {
    if (tc.type === 'auto') out.tool_choice = 'auto';
    else if (tc.type === 'any') out.tool_choice = 'required';
    else if (tc.type === 'tool' && typeof tc.name === 'string') {
      out.tool_choice = { type: 'function', function: { name: tc.name } };
    }
  }
  return out;
}

// ─────────────────────────── ② 规范形请求 → Claude（上游适配器） ───────────────────────────

// eslint-disable-next-line complexity, max-lines-per-function, max-statements -- 双向 codec：字段级形状穷举（请求方言矩阵），拆分需跨函数线程化中间状态，存量棘轮（铁律 22⑥）
export function chatRequestToClaude(req: unknown): Json {
  const r = asJson(req) ?? {};
  const out: Json = {};
  const messages: unknown[] = [];
  let systemText = '';
  for (const m of asArray(r.messages)) {
    const msg = asJson(m);
    if (!msg) continue;
    const role = str(msg.role);
    if (role === 'system' || role === 'developer') {
      const c = msg.content;
      systemText += (systemText ? '\n' : '') + (typeof c === 'string' ? c : JSON.stringify(c));
      continue;
    }
    if (role === 'tool') {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: str(msg.tool_call_id) ?? '',
            content:
              typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? ''),
          },
        ],
      });
      continue;
    }
    if (role === 'assistant') {
      const blocks: unknown[] =
        typeof msg.content === 'string' && msg.content
          ? [{ type: 'text', text: msg.content }]
          : chatContentToClaude(msg.content);
      for (const tc of asArray(msg.tool_calls)) {
        const call = asJson(tc);
        const fn = asJson(call?.function);
        if (!call || !fn) continue;
        let input: unknown = {};
        try {
          input = JSON.parse(str(fn.arguments) ?? '{}');
        } catch {
          input = {};
        }
        blocks.push({
          type: 'tool_use',
          id: str(call.id) ?? 'tool_u_x',
          name: str(fn.name) ?? '',
          input,
        });
      }
      messages.push({ role: 'assistant', content: blocks });
      continue;
    }
    messages.push({ role: 'user', content: chatContentToClaude(msg.content) });
  }
  if (systemText) out.system = systemText;
  // model 必填：Anthropic /v1/messages 协议要求 body 携带模型名——缺失即 400
  // （DashScope anthropic 兼容端点实测：InvalidParameter Request body format invalid）
  out.model = str(r.model) ?? '';
  out.messages = messages;
  out.max_tokens = DEFAULT_CLAUDE_MAX_TOKENS;
  if (typeof r.max_tokens === 'number' && r.max_tokens > 0) out.max_tokens = r.max_tokens;
  else if (typeof r.max_completion_tokens === 'number' && r.max_completion_tokens > 0) {
    out.max_tokens = r.max_completion_tokens;
  }
  if (typeof r.temperature === 'number') out.temperature = r.temperature;
  if (typeof r.top_p === 'number') out.top_p = r.top_p;
  if (Array.isArray(r.stop)) out.stop_sequences = r.stop.map((s) => String(s));
  if (Array.isArray(r.tools)) {
    out.tools = r.tools
      .map((t) => {
        const tool = asJson(t);
        const fn = asJson(tool?.function);
        if (!fn) return null;
        return {
          name: str(fn.name) ?? '',
          description: str(fn.description) ?? '',
          input_schema: fn.parameters ?? { type: 'object' },
        };
      })
      .filter(Boolean);
  }
  const tc = r.tool_choice;
  if (tc === 'auto') out.tool_choice = { type: 'auto' };
  else if (tc === 'required' || tc === 'any') out.tool_choice = { type: 'any' };
  else if (asJson(tc)?.type === 'function') {
    const fnName = str(asJson(asJson(tc)?.function)?.name);
    if (fnName) out.tool_choice = { type: 'tool', name: fnName };
  }
  if (r.stream === true) out.stream = true;
  return out;
}

// ─────────────────────────── ③ 非流式响应 ⇄ 规范形 ───────────────────────────

export function claudeUsageToUsage(u: unknown): {
  /** 总输入（OpenAI 口径 = 未缓存 + 缓存读 + 缓存写；Anthropic input_tokens 只含未缓存） */
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** 缓存写入（5m + 1h 两档合计——1h 档在 cache_creation.ephemeral_1h_input_tokens） */
  cacheCreationTokens: number;
} | null {
  const j = asJson(u);
  if (!j) return null;
  const input = typeof j.input_tokens === 'number' ? j.input_tokens : NaN;
  const output = typeof j.output_tokens === 'number' ? j.output_tokens : NaN;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  const cacheRead = typeof j.cache_read_input_tokens === 'number' ? j.cache_read_input_tokens : 0;
  const cacheCreate =
    typeof j.cache_creation_input_tokens === 'number' ? j.cache_creation_input_tokens : 0;
  const oneHour = asJson(j.cache_creation)?.ephemeral_1h_input_tokens;
  const cacheCreate1h = typeof oneHour === 'number' ? oneHour : 0;
  const write = cacheCreate + cacheCreate1h;
  // 口径（资金正确性）：Anthropic input_tokens 不含缓存部分——补齐为总输入，
  // 与规范形/计费公式的「inputTokens 含 cached（及 write）」口径对齐；
  // 若按 uncached = input − cached 计算，会少算缓存命中的未缓存分量。
  const total = input + cacheRead + write;
  return {
    promptTokens: total,
    completionTokens: output,
    cachedTokens: Math.min(cacheRead, total),
    cacheCreationTokens: write,
  };
}

/** 响应内容块收集：text 块拼正文、tool_use 块转 tool_calls（形状兜底同 v1） */
function collectClaudeBlocks(blocks: unknown[]): {
  textParts: string[];
  toolCalls: Array<Record<string, unknown>>;
} {
  const textParts: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  for (const b of blocks) {
    const block = asJson(b);
    if (!block) continue;
    if (block.type === 'text' && typeof block.text === 'string') textParts.push(block.text);
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: str(block.id) ?? 'call_x',
        type: 'function',
        function: { name: str(block.name) ?? '', arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  return { textParts, toolCalls };
}

export function claudeResponseToChat(res: unknown): Json {
  const r = asJson(res) ?? {};
  const { textParts, toolCalls } = collectClaudeBlocks(asArray(r.content));
  const message: Json = { role: 'assistant', content: textParts.join('') };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const stopReason = str(r.stop_reason) ?? '';
  const usage = claudeUsageToUsage(r.usage);
  return {
    id: str(r.id) ?? 'chatcmpl-claude',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: str(r.model) ?? '',
    choices: [
      {
        index: 0,
        message,
        finish_reason: CLAUDE_STOP_TO_CHAT[stopReason] ?? (stopReason ? 'stop' : null),
      },
    ],
    ...(usage
      ? {
          usage: {
            prompt_tokens: usage.promptTokens,
            completion_tokens: usage.completionTokens,
            total_tokens: usage.promptTokens + usage.completionTokens,
            prompt_tokens_details: { cached_tokens: usage.cachedTokens },
            // 非标准扩展字段：缓存写入 token（OpenAI SDK 容忍未知子字段；消费方=本包 usage 归一）
            cache_write_tokens: usage.cacheCreationTokens,
          },
        }
      : {}),
  };
}

const CLAUDE_STOP_TO_CHAT: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
};

const CHAT_FINISH_TO_CLAUDE: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'refusal',
};

/** 规范形 chat 非流式响应 → Claude Messages 响应（入站 /v1/messages 非流式） */
// eslint-disable-next-line complexity -- 双向 codec：字段级形状穷举（请求方言矩阵），拆分需跨函数线程化中间状态，存量棘轮（铁律 22⑥）
export function chatResponseToClaude(res: unknown): Json {
  const r = asJson(res) ?? {};
  const choice = asJson(asArray(r.choices)[0]) ?? {};
  const message = asJson(choice.message) ?? {};
  const blocks: unknown[] = [];
  const content = typeof message.content === 'string' ? message.content : '';
  if (content) blocks.push({ type: 'text', text: content });
  for (const tc of asArray(message.tool_calls)) {
    const call = asJson(tc);
    const fn = asJson(call?.function);
    if (!call || !fn) continue;
    let input: unknown = {};
    try {
      input = JSON.parse(str(fn.arguments) ?? '{}');
    } catch {
      input = {};
    }
    blocks.push({
      type: 'tool_use',
      id: str(call.id) ?? 'toolu_x',
      name: str(fn.name) ?? '',
      input,
    });
  }
  const usage = asJson(r.usage);
  const inputTokens = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const outputTokens = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : 0;
  const promptDetails = asJson(usage?.prompt_tokens_details);
  const cached = typeof promptDetails?.cached_tokens === 'number' ? promptDetails.cached_tokens : 0;
  const finish = str(choice.finish_reason) ?? 'end_turn';
  return {
    id: str(r.id) ?? 'msg_gateway',
    type: 'message',
    role: 'assistant',
    model: str(r.model) ?? '',
    content: blocks,
    stop_reason: CHAT_FINISH_TO_CLAUDE[finish] ?? 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cached,
    },
  };
}
