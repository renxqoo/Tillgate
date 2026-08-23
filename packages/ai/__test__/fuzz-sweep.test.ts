import { describe, expect, it } from 'vitest';
import {
  claudeRequestToChat,
  chatRequestToClaude,
  claudeResponseToChat,
  claudeUsageToUsage,
} from '../src/protocol/claude-chat.js';
import {
  claudeUpstreamToCanonicalStream,
  canonicalStreamToClaudeStream,
} from '../src/protocol/claude-stream.js';
import {
  geminiRequestToChat,
  chatRequestToGemini,
  geminiResponseToChat,
  geminiUsageToUsage,
} from '../src/protocol/gemini-chat.js';
import {
  geminiUpstreamToCanonicalStream,
  canonicalStreamToGeminiStream,
} from '../src/protocol/gemini-stream.js';
import {
  completionsRequestToChat,
  chatResponseToCompletions,
  canonicalStreamToCompletionsStream,
} from '../src/protocol/completions-chat.js';
import {
  responsesRequestToChat,
  chatResponseToResponses,
  canonicalStreamToResponsesStream,
} from '../src/protocol/responses-chat.js';
import { OpenAICompatibleAdapter } from '../src/adapters/openai-compatible.js';
import { AnthropicAdapter } from '../src/adapters/anthropic.js';
import { GeminiAdapter } from '../src/adapters/gemini.js';
import { VertexAiAdapter } from '../src/adapters/vertex-ai.js';
import { MiniMaxAdapter } from '../src/adapters/minimax.js';
import { DashScopeAdapter } from '../src/adapters/dashscope.js';
import { estimateInputTokens, estimateOutputTokens } from '../src/usage/token-estimate.js';
import { normalizeUsage } from '../src/usage/normalize.js';
import {
  extractVendorCode,
  extractDetail,
  retryAfterMsOf,
  statusFallbackError,
  tableOrFallback,
} from '../src/errors/fallback.js';
import { resolveVendorProfile } from '../src/registry/vendor-profiles.js';
import { joinUrl } from '../src/join-url.js';
import { estimateTextTokens } from '../src/usage/token-estimate.js';

/** 垃圾输入语料（§10.1-3：零值/空/垃圾形状/类型错位不崩） */
const CORPUS: unknown[] = [
  null,
  undefined,
  0,
  42,
  '',
  'str',
  true,
  [],
  [1],
  [[]],
  {},
  { a: 1 },
  { model: 42 },
  { messages: 'x' },
  { messages: [null] },
  { messages: [{ role: 42, content: 42 }] },
  { system: 42 },
  { content: [{ type: 42 }] },
  { choices: 'x' },
  { choices: [42] },
  { usage: 'x' },
  { error: 42 },
  { input: 42 },
  { contents: 'x' },
  { candidates: [42] },
  { parts: 42 },
  { base_resp: 42 },
  { tool_calls: 'x' },
  { tools: [42] },
  { input: [42] },
  { data: 42 },
  { file: 42 },
];

const NO_THROW = (label: string, fn: () => unknown): void => {
  expect(() => fn(), `${label} 不应抛出`).not.toThrow();
};

describe('fuzz 扫描：纯函数对垃圾语料全量不崩（防御守卫边界）', () => {
  it('codec 请求/响应方向 × 语料', () => {
    for (const c of CORPUS) {
      NO_THROW('claudeRequestToChat', () => claudeRequestToChat(c));
      NO_THROW('chatRequestToClaude', () => chatRequestToClaude(c));
      NO_THROW('claudeResponseToChat', () => claudeResponseToChat(c));
      NO_THROW('geminiRequestToChat', () => geminiRequestToChat(c, 'm'));
      NO_THROW('chatRequestToGemini', () => chatRequestToGemini(c));
      NO_THROW('geminiResponseToChat', () => geminiResponseToChat(c, 'm'));
      NO_THROW('completionsRequestToChat', () => completionsRequestToChat(c));
      NO_THROW('chatResponseToCompletions', () => chatResponseToCompletions(c));
      NO_THROW('responsesRequestToChat', () => responsesRequestToChat(c));
      NO_THROW('chatResponseToResponses', () => chatResponseToResponses(c));
      NO_THROW('claudeUsageToUsage', () => claudeUsageToUsage(c));
      NO_THROW('geminiUsageToUsage', () => geminiUsageToUsage(c));
      NO_THROW('normalizeUsage', () => normalizeUsage(c));
      NO_THROW('estimateInputTokens', () => estimateInputTokens(c));
      NO_THROW('estimateOutputTokens', () => estimateOutputTokens(c));
      NO_THROW('estimateTextTokens', () => estimateTextTokens(String(c ?? '')));
      NO_THROW('extractVendorCode', () => extractVendorCode(c));
      NO_THROW('extractDetail', () => extractDetail(c));
      NO_THROW('retryAfterMsOf', () => retryAfterMsOf(c as Record<string, string>));
      NO_THROW('statusFallbackError', () => statusFallbackError(429, c));
      NO_THROW('tableOrFallback', () =>
        tableOrFallback({ table: { x: 'rate_limited' }, status: 429, body: c }),
      );
      NO_THROW('resolveVendorProfile', () => resolveVendorProfile(c as string));
      NO_THROW('joinUrl-base', () => joinUrl(String(c ?? ''), '/v1/x'));
      NO_THROW('joinUrl-path', () => joinUrl('https://h.test', String(c ?? '')));
    }
  });

  it('adapter 能力件 × 语料', () => {
    const adapters = [
      new OpenAICompatibleAdapter(),
      new AnthropicAdapter(),
      new GeminiAdapter(),
      new VertexAiAdapter(),
      new MiniMaxAdapter(),
      new DashScopeAdapter(),
    ];
    const pi = { endpoint: 'chat' as const, model: 'm', requestId: 'r', stream: true };
    for (const a of adapters) {
      const chn = { baseUrl: 'https://x.test', apiKey: 'k', protocol: a.protocol };
      for (const c of CORPUS) {
        NO_THROW(`${a.protocol} normalize`, () => a.normalizeRequest(c, {}, 'chat'));
        NO_THROW(`${a.protocol} finalize`, () =>
          a.finalizeRequestBody((c ?? {}) as Record<string, unknown>, pi),
        );
        NO_THROW(`${a.protocol} extractUsage`, () => a.extractUsage(c));
        NO_THROW(`${a.protocol} mapError-500`, () => a.mapError(500, c));
        NO_THROW(`${a.protocol} mapError-429`, () => a.mapError(429, c, { 'retry-after': 'x' }));
        NO_THROW(`${a.protocol} translateBody`, () =>
          (
            a as unknown as { translateResponseBody?: (b: unknown) => unknown }
          ).translateResponseBody?.(c),
        );
      }
      NO_THROW(`${a.protocol} planRequest`, () => a.planRequest(chn as never, pi));
      NO_THROW(`${a.protocol} probe`, () => a.probeRequests(chn as never));
    }
  });

  it('流式 codec 对垃圾 JSON 帧/非 JSON 帧不崩', async () => {
    const badFrames = [
      '',
      'data: \n\n',
      'data: not-json\n\n',
      'data: [1,2]\n\n',
      'data: "str"\n\n',
      'data: 42\n\n',
      'event: x\ndata: null\n\n',
    ];
    for (const f of badFrames) {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(f));
          c.close();
        },
      });
      await new Response(claudeUpstreamToCanonicalStream(stream)).text();
      const s2 = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(f));
          c.close();
        },
      });
      await new Response(geminiUpstreamToCanonicalStream(s2, 'm')).text();
      const s3 = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(f));
          c.close();
        },
      });
      await new Response(canonicalStreamToClaudeStream(s3, 'm')).text();
      const s4 = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(f));
          c.close();
        },
      });
      await new Response(canonicalStreamToGeminiStream(s4, 'm')).text();
      const s5 = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(f));
          c.close();
        },
      });
      await new Response(canonicalStreamToCompletionsStream(s5)).text();
      const s6 = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(f));
          c.close();
        },
      });
      await new Response(canonicalStreamToResponsesStream(s6)).text();
    }
  });

  it('错误翻译：语料 × 全 status 段', () => {
    const a = new OpenAICompatibleAdapter();
    for (const c of CORPUS.slice(0, 12)) {
      for (const st of [400, 401, 403, 404, 409, 413, 422, 429, 500, 502, 503, 529]) {
        NO_THROW('mapError', () => a.mapError(st, c, { 'retry-after': String(st) }));
      }
    }
  });
});
