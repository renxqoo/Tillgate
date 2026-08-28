import { sseToSseStream } from '../transport/sse';

/**
 * OpenAI Legacy Completions → Chat 入站 codec（/v1/completions 端点用，单向）。
 * prompt（string | string[]）→ 单条 user 消息；响应/流式把 chat 形态映射回 text 形态。
 */

type Json = Record<string, unknown>;

function asJson(v: unknown): Json | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null;
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function completionsRequestToChat(req: unknown): Json {
  const r = asJson(req) ?? {};
  let prompt;
  if (typeof r.prompt === 'string') ({ prompt } = r);
  else if (Array.isArray(r.prompt)) {
    prompt = r.prompt.map((p) => (typeof p === 'string' ? p : String(asArray(p)))).join('');
  } else prompt = '';
  const messages = prompt ? [{ role: 'user', content: prompt }] : [];
  if (typeof r.system === 'string' && r.system) {
    messages.unshift({ role: 'system', content: r.system });
  }
  const out: Json = { model: str(r.model) ?? '', messages };
  const passthrough = [
    'max_tokens',
    'max_completion_tokens',
    'temperature',
    'top_p',
    'n',
    'stop',
    'stream',
    'presence_penalty',
    'frequency_penalty',
    'seed',
    'user',
  ] as const;
  for (const key of passthrough) {
    if (r[key] !== undefined) out[key] = r[key];
  }
  return out;
}

/** 规范形 chat 非流式响应 → legacy completions 响应 */
export function chatResponseToCompletions(res: unknown): Json {
  const r = asJson(res) ?? {};
  // n>1 时返回全部 choice（不只取 choices[0] 丢弃其余）
  const choices = asArray(r.choices).map((c, i) => {
    const choice = asJson(c) ?? {};
    const message = asJson(choice.message) ?? {};
    return {
      index: typeof choice.index === 'number' ? choice.index : i,
      text: typeof message.content === 'string' ? message.content : '',
      finish_reason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    };
  });
  const usage = asJson(r.usage);
  return {
    id: str(r.id) ?? 'cmpl_gateway',
    object: 'text_completion',
    created: typeof r.created === 'number' ? r.created : Math.floor(Date.now() / 1000),
    model: str(r.model) ?? '',
    choices,
    ...(usage
      ? {
          usage: {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
          },
        }
      : {}),
  };
}

/**
 * 规范形 chunk 流 → legacy completions text_completion chunk 流（入站 /v1/completions 流式）。
 * delta.content → choices[0].text；[DONE] 与注释行原样保留。
 */
export function canonicalStreamToCompletionsStream(
  upstream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  return sseToSseStream(upstream, (ev, emit) => {
    if (ev.data === '[DONE]') {
      emit(new TextEncoder().encode('data: [DONE]\n\n'));
      return;
    }
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (chunk === null || typeof chunk !== 'object') return; // fuzz：data:null 帧不崩
    const choice = asArray(chunk.choices)[0] as Record<string, unknown> | undefined;
    const delta = (choice?.delta ?? {}) as Record<string, unknown>;
    const text = typeof delta.content === 'string' ? delta.content : '';
    const finish = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;
    if (text === '' && finish === null) return;
    emit(
      new TextEncoder().encode(
        `data: ${JSON.stringify({
          id: typeof chunk.id === 'string' ? chunk.id : 'cmpl_gateway',
          object: 'text_completion',
          created:
            typeof chunk.created === 'number' ? chunk.created : Math.floor(Date.now() / 1000),
          model: typeof chunk.model === 'string' ? chunk.model : '',
          choices: [{ index: 0, text, finish_reason: finish }],
        })}\n\n`,
      ),
    );
  });
}
