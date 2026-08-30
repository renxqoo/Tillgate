import { asArray, asJson, str, FINISH_MAP, type Json } from './gemini-shared';

/**
 * Gemini generateContent ⇄ OpenAI Chat 非流式双向 codec（chat 家族，流式 ④ 在 gemini-stream.ts）。
 *
 * ① geminiRequestToChat   入站 /v1beta/models/:model:generateContent 请求 → 规范形
 * ② chatRequestToGemini   规范形 → Gemini 请求（gemini/vertex 上游适配器用）
 * ③ geminiResponseToChat  Gemini 非流式响应 → 规范形
 *
 * usage 语义归一：promptTokenCount → inputTokens（cachedContentTokenCount 扣出 cached，
 * thoughtsTokenCount 计入 output——思考 token 由输出侧承担）。
 */

/**
 * 单个 gemini part → 规范形 part：文本原样；inlineData 媒体归一（image_url data
 * URL / input_audio）；fileData 的 http(s) URI → 远程 image_url，非 http(s)（gs://
 * 等 gemini 私有 URI）与远程音频无规范形对应——原样透传（出站透传兜底同协议往返）；
 * functionCall/未知 part 原样保留（消息层提取/透传）。返回 null = 残块不入列。
 */
function geminiPartToChatPart(part: Json): Record<string, unknown> | null {
  if (typeof part.text === 'string') return { type: 'text', text: part.text };
  const inline = asJson(part.inlineData);
  if (inline != null) {
    const mimeType = str(inline.mimeType) ?? '';
    const data = str(inline.data) ?? '';
    if (!data) return null;
    if (mimeType.startsWith('audio/')) {
      return {
        type: 'input_audio',
        input_audio: { data, format: mimeType.replace(/^audio\//, '') || 'wav' },
      };
    }
    return {
      type: 'image_url',
      image_url: { url: `data:${mimeType || 'application/octet-stream'};base64,${data}` },
    };
  }
  const file = asJson(part.fileData);
  if (file != null) {
    const uri = str(file.fileUri) ?? '';
    const mimeType = str(file.mimeType) ?? '';
    if (!uri) return null;
    // http(s) 且非音频 → 远程 image_url；其余（gs:// / 远程音频）透传原生形
    if (/^https?:\/\//i.test(uri) && !mimeType.startsWith('audio/')) {
      return { type: 'image_url', image_url: { url: uri } };
    }
    return part as Record<string, unknown>;
  }
  return part as Record<string, unknown>;
}

/** gemini parts → chat content（纯文本 join；媒体归一为规范形，其余保块形） */
function partsToContent(parts: unknown): string | Array<Record<string, unknown>> {
  const arr = asArray(parts);
  const out: Array<Record<string, unknown>> = [];
  let textOnly = true;
  for (const p of arr) {
    const part = asJson(p);
    if (!part) continue;
    const converted = geminiPartToChatPart(part);
    if (converted == null) {
      textOnly = false;
      continue;
    }
    if (converted.type !== 'text') textOnly = false;
    out.push(converted);
  }
  if (textOnly) return out.map((b) => (b as { text: string }).text).join('');
  return out;
}

export function geminiUsageToUsage(
  u: unknown,
): { promptTokens: number; completionTokens: number; cachedTokens: number } | null {
  const j = asJson(u);
  if (!j) return null;
  const prompt = typeof j.promptTokenCount === 'number' ? j.promptTokenCount : NaN;
  const candidates = typeof j.candidatesTokenCount === 'number' ? j.candidatesTokenCount : NaN;
  if (!Number.isFinite(prompt) || !Number.isFinite(candidates)) return null;
  const thoughts = typeof j.thoughtsTokenCount === 'number' ? j.thoughtsTokenCount : 0;
  const cached =
    typeof j.cachedContentTokenCount === 'number' ? Math.min(j.cachedContentTokenCount, prompt) : 0;
  return { promptTokens: prompt, completionTokens: candidates + thoughts, cachedTokens: cached };
}

// ─────────────────────────── ① 入站请求 → 规范形 ───────────────────────────

// eslint-disable-next-line complexity, max-lines-per-function -- 双向 codec：字段级形状穷举（请求方言矩阵），拆分需跨函数线程化中间状态
export function geminiRequestToChat(req: unknown, model: string): Json {
  const r = asJson(req) ?? {};
  const messages: unknown[] = [];
  const sys = asJson(r.systemInstruction);
  const sysText = sys
    ? asArray(sys.parts)
        .map((p) => str(asJson(p)?.text) ?? '')
        .join('')
    : '';
  if (sysText) messages.push({ role: 'system', content: sysText });
  for (const c of asArray(r.contents)) {
    const content = asJson(c);
    if (!content) continue;
    const role = str(content.role) === 'model' ? 'assistant' : 'user';
    const parts = asArray(content.parts);
    // functionResponse part → chat tool 消息
    const fnResponses = parts.filter((p) => asJson(p)?.functionResponse !== undefined);
    if (fnResponses.length > 0) {
      for (const fr of fnResponses) {
        const f = asJson(asJson(fr)?.functionResponse) ?? {};
        messages.push({
          role: 'tool',
          tool_call_id: str(f.name) ?? '',
          content: JSON.stringify(f.response ?? {}),
        });
      }
      continue;
    }
    const entry: Json = { role, content: partsToContent(parts) };
    if (role === 'assistant') {
      // functionCall 为非对象标量（垃圾形状）时先归一成对象再过滤 null（垃圾形状不崩）
      const toolCalls = parts
        .map((p) => asJson(asJson(p)?.functionCall))
        .filter((f): f is Json => f !== null)
        .map((f, i) => ({
          id: `call_g${i}`,
          type: 'function',
          function: { name: str(f.name) ?? '', arguments: JSON.stringify(f.args ?? {}) },
        }));
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
    }
    messages.push(entry);
  }
  const cfg = asJson(r.generationConfig) ?? {};
  const out: Json = { model, messages };
  if (typeof cfg.maxOutputTokens === 'number') out.max_tokens = cfg.maxOutputTokens;
  if (typeof cfg.temperature === 'number') out.temperature = cfg.temperature;
  if (typeof cfg.topP === 'number') out.top_p = cfg.topP;
  if (Array.isArray(cfg.stopSequences)) out.stop = cfg.stopSequences.map(String);
  if (str(cfg.responseMimeType) === 'application/json') {
    out.response_format = { type: 'json_object' };
  }
  if (Array.isArray(r.tools)) {
    const decls = r.tools.flatMap((t) => asArray(asJson(t)?.functionDeclarations));
    if (decls.length > 0) {
      out.tools = decls.map((d) => {
        const decl = asJson(d) ?? {};
        return {
          type: 'function',
          function: {
            name: str(decl.name) ?? '',
            description: str(decl.description) ?? '',
            parameters: decl.parameters ?? decl.parametersSchema ?? {},
          },
        };
      });
    }
  }
  const tc = asJson(r.toolConfig) ? asJson(asJson(r.toolConfig)?.functionCallingConfig) : null;
  const allowedNames = asArray(tc?.allowedFunctionNames);
  if (tc && tc.mode === 'ANY' && typeof allowedNames[0] === 'string') {
    out.tool_choice = { type: 'function', function: { name: allowedNames[0] } };
  } else if (tc && tc.mode === 'AUTO') {
    out.tool_choice = 'auto';
  }
  return out;
}

// ─────────────────────────── ② 规范形 → Gemini（上游适配器） ───────────────────────────

/** chat image_url part → gemini part（data URL → inlineData；http(s) 远程 → fileData——
 *  白名单防 file:/内网 scheme 经网关中继；其余退空文本占位） */
function imageUrlToGeminiPart(p: Json): unknown {
  const url = str(asJson(p.image_url)?.url) ?? '';
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (m) return { inlineData: { mimeType: m[1], data: m[2] } };
  if (/^https?:\/\//i.test(url)) {
    return { fileData: { fileUri: url } };
  }
  return { text: '' };
}

/** chat input_audio part → gemini inlineData（mimeType 补全 audio/ 前缀；缺 data 退空文本） */
function inputAudioToGeminiPart(p: Json): unknown {
  const audio = asJson(p.input_audio);
  const data = str(audio?.data) ?? '';
  const format = str(audio?.format) ?? '';
  if (!data) return { text: '' };
  return {
    inlineData: { mimeType: format.startsWith('audio/') ? format : `audio/${format}`, data },
  };
}

/** 单个 chat content part → gemini part（text/image_url/input_audio/原生透传，未知→空文本占位） */
function chatPartToGeminiPart(p: Json): unknown {
  if (typeof p.text === 'string') return { text: p.text };
  if (p.type === 'image_url') return imageUrlToGeminiPart(p);
  if (p.type === 'input_audio') return inputAudioToGeminiPart(p);
  // 原生 gemini 形态透传（gemini 原生入站归一后不会再出现原始形——透传兜底
  // 防御外部直构的规范形体）
  if (p.inlineData !== undefined || p.fileData !== undefined) return p;
  return { text: '' };
}

function chatContentToParts(content: unknown): unknown[] {
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  return asArray(content).map((part) => {
    const p = asJson(part);
    return p == null ? { text: '' } : chatPartToGeminiPart(p);
  });
}

// eslint-disable-next-line complexity, max-lines-per-function, max-statements -- 双向 codec：字段级形状穷举（请求方言矩阵），拆分需跨函数线程化中间状态
export function chatRequestToGemini(req: unknown): Json {
  const r = asJson(req) ?? {};
  const contents: unknown[] = [];
  let systemText = '';
  for (const m of asArray(r.messages)) {
    const msg = asJson(m);
    if (!msg) continue;
    const role = str(msg.role);
    if (role === 'system' || role === 'developer') {
      systemText +=
        (systemText ? '\n' : '') +
        (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? ''));
      continue;
    }
    if (role === 'tool') {
      let response: unknown = {};
      try {
        response = JSON.parse(
          typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? {}),
        );
      } catch {
        response = {};
      }
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name: str(msg.tool_call_id) ?? '', response } }],
      });
      continue;
    }
    if (role === 'assistant') {
      const parts: unknown[] = chatContentToParts(msg.content);
      for (const tc of asArray(msg.tool_calls)) {
        const call = asJson(tc);
        const fn = asJson(call?.function);
        if (!fn) continue;
        let args: unknown = {};
        try {
          args = JSON.parse(str(fn.arguments) ?? '{}');
        } catch {
          args = {};
        }
        parts.push({ functionCall: { name: str(fn.name) ?? '', args } });
      }
      contents.push({ role: 'model', parts });
      continue;
    }
    contents.push({ role: 'user', parts: chatContentToParts(msg.content) });
  }
  const out: Json = { contents };
  if (systemText) out.systemInstruction = { parts: [{ text: systemText }] };
  const cfg: Json = {};
  let maxTokens;
  if (typeof r.max_tokens === 'number' && r.max_tokens > 0) maxTokens = r.max_tokens;
  else if (typeof r.max_completion_tokens === 'number') maxTokens = r.max_completion_tokens;
  else maxTokens = undefined;
  if (maxTokens !== undefined) cfg.maxOutputTokens = maxTokens;
  if (typeof r.temperature === 'number') cfg.temperature = r.temperature;
  if (typeof r.top_p === 'number') cfg.topP = r.top_p;
  if (Array.isArray(r.stop)) cfg.stopSequences = r.stop.map(String);
  if (Object.keys(cfg).length > 0) out.generationConfig = cfg;
  const decls = asArray(r.tools)
    .map((t) => asJson(asJson(t)?.function))
    .filter((fn): fn is Json => fn !== null)
    .map((f) => ({
      name: str(f.name) ?? '',
      description: str(f.description) ?? '',
      parameters: f.parameters ?? { type: 'object' },
    }));
  if (decls.length > 0) out.tools = [{ functionDeclarations: decls }];
  const tc = r.tool_choice;
  if (tc === 'auto') out.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  else if (tc === 'required' || tc === 'none') {
    out.toolConfig = { functionCallingConfig: { mode: tc === 'none' ? 'NONE' : 'ANY' } };
  } else if (asJson(tc)?.type === 'function') {
    const name = str(asJson(asJson(tc)?.function)?.name);
    if (name) {
      out.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [name] } };
    }
  }
  return out;
}

// ─────────────────────────── ③ 非流式响应 → 规范形 ───────────────────────────

export function geminiResponseToChat(res: unknown, model: string): Json {
  const r = asJson(res) ?? {};
  const candidate = asJson(asArray(r.candidates)[0]) ?? {};
  const content = asJson(candidate.content) ?? {};
  const parts = asArray(content.parts);
  const textParts: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  parts.forEach((p, i) => {
    const part = asJson(p);
    if (!part) return;
    if (typeof part.text === 'string') textParts.push(part.text);
    if (part.functionCall !== undefined) {
      const f = asJson(part.functionCall) ?? {};
      toolCalls.push({
        id: `call_g${i}`,
        type: 'function',
        function: { name: str(f.name) ?? '', arguments: JSON.stringify(f.args ?? {}) },
      });
    }
  });
  const message: Json = { role: 'assistant', content: textParts.join('') };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const finish = str(candidate.finishReason) ?? '';
  const usage = geminiUsageToUsage(r.usageMetadata);
  return {
    id: str(r.responseId) ?? 'chatcmpl-gemini',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: FINISH_MAP[finish] ?? (finish ? 'stop' : null) }],
    ...(usage
      ? {
          usage: {
            prompt_tokens: usage.promptTokens,
            completion_tokens: usage.completionTokens,
            total_tokens: usage.promptTokens + usage.completionTokens,
            prompt_tokens_details: { cached_tokens: usage.cachedTokens },
          },
        }
      : {}),
  };
}

// ─────────────────────── 客户端方向非流式：规范形 → Gemini 响应 ───────────────────────

const CHAT_FINISH_TO_GEMINI: Record<string, string> = {
  stop: 'STOP',
  length: 'MAX_TOKENS',
  content_filter: 'SAFETY',
};

/** 规范形 chat 非流式响应 → Gemini generateContent 响应（入站非流式） */
// eslint-disable-next-line complexity -- 双向 codec：字段级形状穷举（请求方言矩阵），拆分需跨函数线程化中间状态
export function chatResponseToGemini(res: unknown): Json {
  const r = asJson(res) ?? {};
  const choice = asJson(asArray(r.choices)[0]) ?? {};
  const message = asJson(choice.message) ?? {};
  const parts: unknown[] = [];
  const content = typeof message.content === 'string' ? message.content : '';
  if (content) parts.push({ text: content });
  for (const tc of asArray(message.tool_calls)) {
    const call = asJson(tc);
    const fn = asJson(call?.function);
    if (!call || !fn) continue;
    let args: unknown = {};
    try {
      args = JSON.parse(str(fn.arguments) ?? '{}');
    } catch {
      args = {};
    }
    parts.push({ functionCall: { name: str(fn.name) ?? '', args } });
  }
  const usage = asJson(r.usage);
  const prompt = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const candidates = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : 0;
  const finish = str(choice.finish_reason) ?? 'STOP';
  return {
    candidates: [
      {
        content: { role: 'model', parts },
        finishReason: CHAT_FINISH_TO_GEMINI[finish] ?? 'STOP',
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: prompt,
      candidatesTokenCount: candidates,
      totalTokenCount: prompt + candidates,
    },
    modelVersion: str(r.model) ?? '',
  };
}
