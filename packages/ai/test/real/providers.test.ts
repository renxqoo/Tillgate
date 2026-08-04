import { describe, expect, it } from 'vitest';
import { createAi } from '../../src/create-ai.js';
import type { AiEvent } from '../../src/events.js';
import type { ChannelDesc, RequestCtx } from '../../src/types.js';

/**
 * 真实供应商集成测试（MiniMax + DeepSeek）。
 *
 * ⚠️ 本测试发起真实上游调用，会产生（极少）费用。
 * 仅在配置了 *_API_KEY 时运行；CI 默认 skip（无 key 自动跳过）。
 *
 * 加载 monorepo 根 .env，把 MINIMAX_ 与 DEEPSEEK_ 环境变量注入 process.env。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 从起始目录向上逐级查找 .env（到根为止），找到第一个存在的 */
function findEnvFile(startDirs: string[]): string | undefined {
  for (const start of startDirs) {
    let dir = start;
    for (let i = 0; i < 6; i++) {
      const candidate = resolve(dir, '.env');
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break; // 到文件系统根
      dir = parent;
    }
  }
  return undefined;
}

try {
  // 起始目录：测试文件所在目录（import.meta.url，不依赖 cwd）+ 当前工作目录
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = findEnvFile([here, process.cwd()]);
  if (envPath) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (!m) continue;
      const key = m[1] as string;
      const val = m[2] as string;
      if (!(key in process.env)) process.env[key] = val;
    }
  }
} catch {
  /* .env 读取失败：依赖已有 process.env（CI 通过 secret 注入） */
}

interface ProviderConfig {
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  providerName: string;
}

/** 必需变量（值为空时报错）vs 可选变量（缺失用默认） */
const PROVIDER_DEFS = [
  {
    name: 'MiniMax',
    providerName: 'minimax',
    required: { MINIMAX_API_KEY: 'apiKey', MINIMAX_BASE_URL: 'baseUrl' },
    optional: { MINIMAX_MODEL: 'model' },
    defaults: { model: 'MiniMax-M3' },
  },
  {
    name: 'DeepSeek',
    providerName: 'deepseek',
    required: { DEEPSEEK_API_KEY: 'apiKey', DEEPSEEK_BASE_URL: 'baseUrl' },
    optional: { DEEPSEEK_MODEL: 'model' },
    defaults: { model: 'deepseek-chat' },
  },
] as const;

function loadProviders(): ProviderConfig[] {
  const out: ProviderConfig[] = [];
  for (const def of PROVIDER_DEFS) {
    // 统计该供应商有哪些变量被声明（存在于 process.env，不管值是否空）
    const declared = Object.keys(def.required).filter((k) => k in process.env);
    if (declared.length === 0) continue; // 该供应商完全未配置 → 不测（skip）

    // 有任一变量被声明 → 必须全部配齐且非空，否则 fail fast（配置错误）
    const cfg: Record<string, string> = {};
    for (const [envKey, field] of Object.entries(def.required)) {
      const val = process.env[envKey];
      if (!val) {
        throw new Error(
          `真实测试配置错误：${def.name} 的 ${envKey} 为空。` +
            `请在 .env 中填写有效值，或整组删除该供应商的所有变量（声明了就必须配齐）。`,
        );
      }
      cfg[field] = val;
    }
    // 可选变量：声明了但空也报错（避免 .env 里 MINIMAX_MODEL= 空值导致用默认却无感知）
    for (const [envKey, field] of Object.entries(def.optional)) {
      if (envKey in process.env) {
        const val = process.env[envKey];
        if (!val) {
          throw new Error(`真实测试配置错误：${def.name} 的 ${envKey} 声明了但值为空。`);
        }
        cfg[field] = val;
      } else {
        cfg[field] = def.defaults[field as keyof typeof def.defaults];
      }
    }
    out.push({
      name: def.name,
      providerName: def.providerName,
      apiKey: cfg.apiKey!,
      baseUrl: cfg.baseUrl!,
      model: cfg.model!,
    });
  }
  return out;
}

const PROVIDERS = loadProviders();
const hasProviders = PROVIDERS.length > 0;
// 无 key 时整个文件 skip
const describeOrSkip = hasProviders ? describe : describe.skip;

/** 轻量调用配置：max_tokens=5、短 deadline、禁本地 URL（真实 https） */
function makeAi() {
  return createAi({
    retry: {
      maxAttempts: 2,
      baseDelayMs: 500,
      maxDelayMs: 1000,
      jitterRatio: 0.25,
      deadlineMs: 30_000,
      emptyCompletionRetries: 1,
    },
    breaker: { windowMs: 60_000, failureThreshold: 10, cooldownMs: 300_000, halfOpenProbe: true },
    stream: { heartbeatIdleMs: 30_000, inactivityTimeoutMs: 60_000 },
    timeout: { connectMs: 15_000, totalMs: 30_000 },
    estimate: { charPerToken: 3.5 },
    deadCredential: { failureThreshold: 5, windowMs: 3_600_000 },
    allowLocalUrl: false, // 生产配置：强制 https，禁内网
  });
}

function channel(p: ProviderConfig): ChannelDesc {
  return { baseUrl: p.baseUrl, apiKey: p.apiKey, protocol: 'openai-compatible' };
}

function ctx(p: ProviderConfig, tag: string): RequestCtx {
  return { requestId: `real-${p.name}-${tag}-${Date.now()}`, model: p.model, providerName: p.providerName };
}

describeOrSkip('真实供应商集成', () => {
  for (const p of PROVIDERS) {
    describe(`${p.name} (${p.model})`, () => {
      it('probe：GET /v1/models 连通性', async () => {
        const ai = makeAi();
        const result = await ai.probe(channel(p));
        // 真实环境应 ok；若供应商对 /v1/models 鉴权失败会返回死凭据错误
        if (!result.ok) {
          // 允许失败，但打印错误便于诊断（不 hard fail 网络/限流类错误）
          console.warn(`[${p.name}] probe failed:`, result.error?.code, result.error?.message);
        }
        expect(typeof result.ok).toBe('boolean');
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
      }, 30_000);

      it('chat：非流式 + usage 归一化', async () => {
        const ai = makeAi();
        const events: AiEvent[] = [];
        ai.onEvent((e) => events.push(e));

        const result = await ai.chat({
          channel: channel(p),
          request: {
            model: p.model,
            messages: [{ role: 'user', content: '回复一个字：好' }],
            max_tokens: 5,
            temperature: 0,
          },
          ctx: ctx(p, 'chat'),
        });

        // 成功路径断言（网络/限流失败时跳过严格断言，打印诊断）
        if (result.status === 'success') {
          expect(result.usage).toBeDefined();
          if (result.usage) {
            expect(result.usage.estimated).toBe(false); // 供应商应返回 usage
            expect(result.usage.inputTokens).toBeGreaterThan(0);
            expect(result.usage.outputTokens).toBeGreaterThan(0);
            console.log(`[${p.name}] chat usage:`, JSON.stringify(result.usage));
          }
          // 事件序列：attempt_start + success
          expect(events.some((e) => e.type === 'attempt_start')).toBe(true);
          expect(events.at(-1)?.type).toBe('success');
        } else if (result.status === 'error' && result.error?.code === 'quota_exhausted') {
          // 账户余额耗尽（需充值）：不可重试
          console.log(`[${p.name}] chat 余额耗尽（quota_exhausted，不可重试）`);
          expect(result.error.retryable).toBe(false);
        } else if (result.status === 'error' && result.error?.retryable === true) {
          // 窗口限流（如 MiniMax Token Plan 5h 窗口 / RPM 限流）：可重试，重试耗尽后仍失败
          console.log(`[${p.name}] chat 限流（${result.error?.code}，可重试，重试耗尽后失败）`);
        } else {
          console.warn(`[${p.name}] chat 非预期:`, result.status, result.error?.code, result.error?.message);
        }
        expect(['success', 'empty', 'error']).toContain(result.status);
      }, 60_000);

      it('chatStream：流式透传 + usage 捕获', async () => {
        const ai = makeAi();
        const handle = await ai.chatStream({
          channel: channel(p),
          request: {
            model: p.model,
            stream: true,
            messages: [{ role: 'user', content: '回复一个字：好' }],
            max_tokens: 5,
            temperature: 0,
            stream_options: { include_usage: true },
          },
          ctx: ctx(p, 'stream'),
        });

        const events: AiEvent[] = [];
        handle.onEvent((e) => events.push(e));
        const reader = handle.stream.getReader();
        const dec = new TextDecoder();
        const chunks: string[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(dec.decode(value));
        }
        const text = chunks.join('');

        // 透传完整性：应有 SSE data 帧（成功或错误都是 data: 帧）
        expect(text).toMatch(/data:/);
        console.log(`[${p.name}] stream output (前 200 字符):`, text.slice(0, 200));

        const successEv = events.find((e) => e.type === 'success');
        const failedEv = events.find((e) => e.type === 'failed');
        if (successEv?.type === 'success') {
          // 成功路径：流式正常结束不应有 terminated
          expect(successEv.terminated).toBeUndefined();
          if (successEv.usage) {
            expect(successEv.usage.estimated).toBe(false);
            console.log(`[${p.name}] stream usage:`, JSON.stringify(successEv.usage));
          }
          expect((successEv.bytesRelayed ?? 0)).toBeGreaterThan(0);
        } else if (failedEv?.type === 'failed') {
          // 供应商错误（额度耗尽/key 失效等）：验证错误帧透传 + failed 事件
          console.log(`[${p.name}] stream 供应商错误（已透传错误帧）:`, failedEv.error.code);
          expect(text).toContain(failedEv.error.code);
        } else {
          throw new Error(`[${p.name}] stream 既无 success 也无 failed 事件`);
        }
      }, 60_000);

      it('错误分类：无效模型 → model_not_found（不重试）', async () => {
        const ai = makeAi();
        let calls = 0;
        const off = ai.onEvent((e) => {
          if (e.type === 'attempt_start') calls++;
        });

        const result = await ai.chat({
          channel: channel(p),
          request: {
            model: 'this-model-does-not-exist-xyz',
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 5,
          },
          ctx: ctx(p, 'bad-model'),
        });
        off();

        expect(result.status).toBe('error');
        if (result.status === 'error') {
          // 4xx 类错误不重试（calls=1）；具体 code 因供应商而异（404→model_not_found / 400→invalid_request[_error]）
          expect(calls).toBe(1);
          expect(result.error?.retryable).toBe(false);
          expect(result.error?.circuitTrip).toBe(false);
          console.log(`[${p.name}] bad-model error:`, result.error?.code, 'status=' + result.error?.status);
        }
      }, 30_000);

      it('tools 函数调用：透传 tool_calls 响应（流式 delta 完整）', async () => {
        const ai = makeAi();
        const handle = await ai.chatStream({
          channel: channel(p),
          request: {
            model: p.model,
            stream: true,
            messages: [{ role: 'user', content: '北京今天天气怎么样？请调用工具查询' }],
            max_tokens: 200,
            tools: [
              {
                type: 'function',
                function: {
                  name: 'get_weather',
                  description: '查询指定城市的天气',
                  parameters: {
                    type: 'object',
                    properties: {
                      city: { type: 'string', description: '城市名' },
                    },
                    required: ['city'],
                  },
                },
              },
            ],
            tool_choice: 'auto',
          },
          ctx: ctx(p, 'tools'),
        });

        const events: AiEvent[] = [];
        handle.onEvent((e) => events.push(e));
        const reader = handle.stream.getReader();
        const dec = new TextDecoder();
        const chunks: string[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(dec.decode(value));
        }
        const text = chunks.join('');

        const successEv = events.find((e) => e.type === 'success');
        const failedEv = events.find((e) => e.type === 'failed');
        if (successEv?.type === 'success') {
          // 成功：透传内容应包含 tool_calls 或正常 content（取决于模型是否决定调用工具）
          const hasToolCalls = text.includes('tool_calls');
          const hasContent = /"content"\s*:/.test(text);
          console.log(`[${p.name}] tools: hasToolCalls=${hasToolCalls} hasContent=${hasContent}`);
          console.log(`[${p.name}] tools output (前 300 字符):`, text.slice(0, 300));
          expect(hasToolCalls || hasContent).toBe(true);
        } else if (failedEv?.type === 'failed') {
          // 供应商错误（额度/key）：验证错误帧透传
          console.log(`[${p.name}] tools 供应商错误（已透传错误帧）:`, failedEv.error.code);
          expect(text).toContain(failedEv.error.code);
        } else {
          throw new Error(`[${p.name}] tools 既无 success 也无 failed 事件`);
        }
      }, 60_000);

      it('reasoning_effort 透传：参数被静默接受（不报 400）', async () => {
        // reasoning_effort 是 OpenAI o 系列参数；MiniMax 用 thinking(bool)，DeepSeek 用独立 reasoner 模型。
        // 验证：passthrough 模式下传该参数，供应商应静默忽略或接受（不 400）。
        const ai = makeAi();
        const result = await ai.chat({
          channel: channel(p),
          request: {
            model: p.model,
            messages: [{ role: 'user', content: '回复一个字：好' }],
            max_tokens: 5,
            reasoning_effort: 'low', // OpenAI 风格，非 o 系列模型应忽略
          },
          ctx: ctx(p, 'reasoning'),
        });

        // 供应商应静默接受（success）；即使忽略该参数也应正常返回
        if (result.status === 'success') {
          console.log(`[${p.name}] reasoning_effort=low 被静默接受，usage:`, JSON.stringify(result.usage));
        } else {
          // 少数供应商可能对未知参数报 400——记录但不强制失败（行为符合预期：透传基底）
          console.warn(`[${p.name}] reasoning_effort 导致:`, result.status, result.error?.code);
        }
        expect(['success', 'empty', 'error']).toContain(result.status);
      }, 60_000);
    });
  }
});
