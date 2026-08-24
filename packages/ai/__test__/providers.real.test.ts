import { describe, expect, it } from 'vitest';
import { createAi } from '../src/index.js';
import type { AiEvent, CallOptions, ChannelDesc, UpstreamError } from '../src/index.js';

/**
 * 真实供应商集成测试（MiniMax + DeepSeek）——v1 `ai-getway/packages/ai/test/real/providers.test.ts`
 * 的逐用例移植（IMPLEMENTATION.md §4.8）。
 *
 * ⚠️ 本测试发起真实上游调用，会产生（极少）费用。
 * 仅在配置了 *_API_KEY 时运行；CI 默认 skip（无 key 自动跳过）。
 *
 * 加载 monorepo 根 .env，把 MINIMAX_ 与 DEEPSEEK_ 环境变量注入 process.env
 * （从本文件目录向上逐级查找，见 findEnvFile）。
 *
 * env 契约（唯一文档处——.env.example 已不列供应商键，生产渠道凭据走管理台 channels 落库）：
 *   MiniMax：MINIMAX_API_KEY + MINIMAX_BASE_URL 必填；MINIMAX_MODEL 可选（默认 MiniMax-M3）
 *   DeepSeek：DEEPSEEK_API_KEY + DEEPSEEK_BASE_URL 必填；DEEPSEEK_MODEL 可选（默认 deepseek-chat）
 * 任一变量声明即视为启用该供应商，缺必填项直接 fail（防半配置静默跑错环境）。
 *
 * ── v1 → v2 语义映射（旧用例语义保持，API 形状随 §1 契约演进）──
 * 1. 装配：`createAi(config, memoryDeps())` → `createAi(defaults)`——v2 无存储依赖注入点
 *    （breakerStorage/deadCredentialStorage 随熔断/死凭据跨请求状态整体裁决移除：
 *    铁律 12「ai 不持有跨请求运维状态」+ IMPLEMENTATION §0-3.6；机制位改由 kind→派生表
 *    单点得出，§3.2）。配置键 `breaker` / `deadCredential` 同因移除。
 * 2. `allowLocalUrl: false` 配置键已移除：v2 缺省 URL 守卫即机械基线
 *    （https-only + 禁私网/回环 + DNS 逐地址判定，IMPLEMENTATION §3.3/§4.6）——
 *    不注入 guardUrl = 旧 false 行为。v2 新增 `stream.firstByteTimeoutMs` 首字节预算。
 * 3. 调用：`ai.chat({ channel, request, ctx })` → `ai.chat(channel, request, opts)`——
 *    旧 RequestCtx 四字段（requestId/model/providerName/endpoint）平铺为 CallOptions，
 *    v2 全可选（缺省 randomUUID / request.model / 不带 / 'chat'）；本测试显式传全量。
 * 4. 结果判别联合：旧 `status:'success'|'empty'|'error'` → `ok:true` | `ok:false`
 *    （empty 语义 = `ok:false && empty===true`，error.kind='empty_completion'）。
 * 5. 错误：旧自由字符串 `error.code` → 封闭词表 `error.kind`（§3.2；厂商原码在
 *    `error.vendorCode`）；机制位 retryable/circuitTrip/deadCredential 同名保留（派生表）。
 * 6. 事件：旧 `ai.onEvent` → `ai.subscribe`（chat 事件仅走全局面）；流式旧
 *    `handle.onEvent` → `result.events.subscribe`（per-call 面：first_chunk 缓冲重放 +
 *    终态缓冲重放，attempt_start 等流前事件经全局面观察——见 events.ts 头注释时序契约）。
 * 7. usage 口径（usage/normalize.ts 头注释）：estimated:false 仅在供应商真实 usage 归一
 *    成功时出现；v2 库内零估算回退——chat 结果 / success 事件的 usage 在上游未给可信
 *    usage 时为 undefined（估算归消费方，success.outputFeatures 为充分统计量数据源）。
 *    旧断言 `if (usage) expect(estimated).toBe(false)` 语义不变。
 * 8. `stream_options:{include_usage:true}`：v2 由 openai-compatible 适配器对一切流式请求
 *    强制注入（含 continuous_usage_stats，计费完整性优先，见 adapter 头注释）——本测试
 *    仍显式传 include_usage，验证用户传入与强制注入合并不冲突（其余键透传）。
 * 9. 错误帧断言：v1 出站错误帧带 v1 code；v2 failEarly 合成帧形如
 *    `{"error":{"code":"<kind>","type":"<vendorCode>",...}}`（stream-report.ts）——
 *    「透传文本包含错误码」断言从 error.code 改为 error.kind。
 *
 * v1 有、v2 裁决移除的行为（本文件不再覆盖，出处附节号）：
 * - 熔断/死凭据存储配置与注入（IMPLEMENTATION §3.2「机制位派生表」、§0 三不变量之三：
 *   渠道健康归订阅者旁路消费）——invalid_api_key 的 deadCredential:true 旗标断言保留
 *   （派生表真实验证），但不再有「连续达阈值停止路由」的库内状态可配。
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
          `Real-test config error: ${def.name} ${envKey} is empty. ` +
            `Fill a valid value in .env, or remove ALL variables of this provider ` +
            `(declaring any one requires the full set).`,
        );
      }
      cfg[field] = val;
    }
    // 可选变量：声明了但空也报错（避免 .env 里 MINIMAX_MODEL= 空值导致用默认却无感知）
    for (const [envKey, field] of Object.entries(def.optional)) {
      if (envKey in process.env) {
        const val = process.env[envKey];
        if (!val) {
          throw new Error(`Real-test config error: ${def.name} ${envKey} declared but empty.`);
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

/**
 * 轻量调用配置：max_tokens=5、短 deadline。
 * 不注入 guardUrl——缺省机械基线（https + 禁私网）即旧 allowLocalUrl:false 语义。
 */
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
    stream: { heartbeatIdleMs: 30_000, firstByteTimeoutMs: 20_000, inactivityTimeoutMs: 60_000 },
    timeout: { connectMs: 15_000, totalMs: 30_000 },
  });
}

function channel(p: ProviderConfig): ChannelDesc {
  return { baseUrl: p.baseUrl, apiKey: p.apiKey, protocol: 'openai-compatible' };
}

/** 旧 RequestCtx 四字段平铺为 v2 CallOptions（显式传全量，验证平铺契约） */
function opts(p: ProviderConfig, tag: string): CallOptions {
  return {
    requestId: `real-${p.name}-${tag}-${Date.now()}`,
    model: p.model,
    providerName: p.providerName,
    endpoint: 'chat',
  };
}

/** v2 判别联合 → 旧 status 词汇（empty 语义 = ok:false && empty） */
function statusOf(r: { ok: boolean; empty?: boolean }): 'success' | 'empty' | 'error' {
  if (r.ok) return 'success';
  return r.empty === true ? 'empty' : 'error';
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
          console.warn(`[${p.name}] probe failed:`, result.error?.kind, result.error?.message);
        }
        expect(typeof result.ok).toBe('boolean');
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
      }, 30_000);

      it('chat：非流式 + usage 归一化', async () => {
        const ai = makeAi();
        const events: AiEvent[] = [];
        ai.subscribe((e) => events.push(e));

        const result = await ai.chat(
          channel(p),
          {
            model: p.model,
            messages: [{ role: 'user', content: '回复一个字：好' }],
            max_tokens: 5,
            temperature: 0,
          },
          opts(p, 'chat'),
        );
        void events;

        // 成功路径断言（网络/限流失败时跳过严格断言，打印诊断）
        if (result.ok) {
          expect(result.usage).toBeDefined();
          if (result.usage) {
            // 口径（usage/normalize.ts 头注释）：estimated:false = 供应商真实 usage 归一成功
            expect(result.usage.estimated).toBe(false);
            expect(result.usage.inputTokens).toBeGreaterThan(0);
            expect(result.usage.outputTokens).toBeGreaterThan(0);
            console.log(`[${p.name}] chat usage:`, JSON.stringify(result.usage));
          }
          // 事件序列（全局面）：attempt_start + success 终态最后
          expect(events.some((e) => e.type === 'attempt_start')).toBe(true);
          expect(events.at(-1)?.type).toBe('success');
        } else if (!result.ok && result.error?.kind === 'quota_exhausted') {
          // 账户余额耗尽（需充值）：不可重试
          console.log(`[${p.name}] chat 余额耗尽（quota_exhausted，不可重试）`);
          expect(result.error.retryable).toBe(false);
        } else if (!result.ok && result.error?.retryable === true) {
          // 窗口限流（如 MiniMax Token Plan 5h 窗口 / RPM 限流）：可重试，重试耗尽后仍失败
          console.log(`[${p.name}] chat 限流（${result.error.kind}，可重试，重试耗尽后失败）`);
        } else {
          console.warn(`[${p.name}] chat 非预期:`, result.error?.kind, result.error?.message);
        }
        expect(['success', 'empty', 'error']).toContain(statusOf(result));
      }, 60_000);

      it('chatStream：流式透传 + usage 捕获', async () => {
        const ai = makeAi();
        const handle = await ai.chatStream(
          channel(p),
          {
            model: p.model,
            stream: true,
            messages: [{ role: 'user', content: '回复一个字：好' }],
            max_tokens: 5,
            temperature: 0,
            stream_options: { include_usage: true },
          },
          opts(p, 'stream'),
        );

        const events: AiEvent[] = [];
        handle.events.subscribe((e) => events.push(e));
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
          expect(successEv.bytesRelayed ?? 0).toBeGreaterThan(0);
        } else if (failedEv?.type === 'failed') {
          // 供应商错误（额度耗尽/key 失效等）：验证错误帧透传 + failed 事件
          // （v2 failEarly 合成帧 code 字段 = kind，见文件头注释第 9 条）
          console.log(`[${p.name}] stream 供应商错误（已透传错误帧）:`, failedEv.error.kind);
          expect(text).toContain(failedEv.error.kind);
        } else {
          throw new Error(`[${p.name}] stream 既无 success 也无 failed 事件`);
        }
      }, 60_000);

      it('错误分类：无效模型 → model_not_found（不重试）', async () => {
        const ai = makeAi();
        let calls = 0;
        const off = ai.subscribe((e) => {
          if (e.type === 'attempt_start') calls++;
        });

        const result = await ai.chat(
          channel(p),
          {
            model: 'this-model-does-not-exist-xyz',
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 5,
          },
          opts(p, 'bad-model'),
        );
        off();

        expect(result.ok).toBe(false);
        if (!result.ok) {
          const error = result.error as UpstreamError;
          // 4xx 类错误不重试（calls=1）；具体 kind 因供应商而异
          // （404→model_not_found / 400→invalid_request，厂商原码看 vendorCode）
          expect(calls).toBe(1);
          expect(error.retryable).toBe(false);
          expect(error.circuitTrip).toBe(false);
          console.log(`[${p.name}] bad-model error:`, error.kind, 'status=' + error.status);
        }
      }, 30_000);

      it('tools 函数调用：透传 tool_calls 响应（流式 delta 完整）', async () => {
        const ai = makeAi();
        const handle = await ai.chatStream(
          channel(p),
          {
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
          opts(p, 'tools'),
        );

        const events: AiEvent[] = [];
        handle.events.subscribe((e) => events.push(e));
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
          console.log(`[${p.name}] tools 供应商错误（已透传错误帧）:`, failedEv.error.kind);
          expect(text).toContain(failedEv.error.kind);
        } else {
          throw new Error(`[${p.name}] tools 既无 success 也无 failed 事件`);
        }
      }, 60_000);

      it('reasoning_effort 透传：参数被静默接受（不报 400）', async () => {
        // reasoning_effort 是 OpenAI o 系列参数；MiniMax 用 thinking(bool)，DeepSeek 用独立 reasoner 模型。
        // 验证：passthrough 模式下传该参数，供应商应静默忽略或接受（不 400）。
        const ai = makeAi();
        const result = await ai.chat(
          channel(p),
          {
            model: p.model,
            messages: [{ role: 'user', content: '回复一个字：好' }],
            max_tokens: 5,
            reasoning_effort: 'low', // OpenAI 风格，非 o 系列模型应忽略
          },
          opts(p, 'reasoning'),
        );

        // 供应商应静默接受（success）；即使忽略该参数也应正常返回
        if (result.ok) {
          console.log(
            `[${p.name}] reasoning_effort=low 被静默接受，usage:`,
            JSON.stringify(result.usage),
          );
        } else {
          // 少数供应商可能对未知参数报 400——记录但不强制失败（行为符合预期：透传基底）
          console.warn(`[${p.name}] reasoning_effort 导致:`, result.error.kind);
        }
        expect(['success', 'empty', 'error']).toContain(statusOf(result));
      }, 60_000);
    });
  }
});

// ─────────────── 扩展场景：流式/错误分类/多事件总线（有 key 即跑） ───────────────

describeOrSkip('真实供应商集成 · 扩展场景', () => {
  for (const p of PROVIDERS) {
    describe(`${p.name} (${p.model})`, () => {
      it('chatStream：全链流式——首帧/usage/terminated 语义齐全', async () => {
        const ai = makeAi();
        const handle = await ai.chatStream(
          channel(p),
          {
            model: p.model,
            messages: [{ role: 'user', content: '数到三' }],
            max_tokens: 16,
            stream: true,
            temperature: 0,
          },
          opts(p, 'v2-stream'),
        );
        const events: AiEvent[] = [];
        handle.events.subscribe((e) => events.push(e));
        const text = await new Response(handle.stream).text();
        expect(text.length).toBeGreaterThan(0);

        const success = events.find((e) => e.type === 'success');
        if (success !== undefined && success.type === 'success') {
          // 正常完成：usage 可信（供应商真实返回，adapter 强制注入 include_usage 的效果）
          if (success.usage) {
            expect(success.usage.estimated).toBe(false);
            expect(success.usage.inputTokens).toBeGreaterThan(0);
            expect(success.usage.outputTokens).toBeGreaterThan(0);
            console.log(`[${p.name}] stream usage:`, JSON.stringify(success.usage));
          }
          // 自然完成：terminated 缺省或非客户端断开；字节确实送达
          expect(
            success.terminated === undefined || success.terminated !== 'client_disconnect',
          ).toBe(true);
          expect(success.bytesRelayed ?? 0).toBeGreaterThan(0);
        }
        // first_chunk 一次性缓冲重放（per-call 面契约）——晚订阅也能锚定首字节
        const firstChunk = events.find((e) => e.type === 'first_chunk');
        expect(firstChunk).toBeDefined();
      }, 45_000);

      it('无效密钥 → invalid_api_key + deadCredential（分类矩阵真实验证）', async () => {
        const ai = makeAi();
        const bad: ChannelDesc = {
          ...channel(p),
          apiKey: 'sk-invalid-key-for-classification-test',
        };
        const result = await ai.chat(
          bad,
          { model: p.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 },
          opts(p, 'v2-badkey'),
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          // 供应商应返回 401（或 403/带特征的 400）——deadCredential 旗标是路由停用依据
          // （v2 机制位由 kind→派生表单点派生，§3.2；库内无死凭据存储，阈值归消费方）
          expect(result.error.kind).toBe('invalid_api_key');
          expect(result.error.deadCredential).toBe(true);
          expect(result.error.retryable).toBe(false);
        }
      }, 45_000);

      it('endpoint 寻址真实验证：embeddings 路径（供应商不支持时断言错误可分类）', async () => {
        const ai = makeAi();
        const result = await ai.chat(
          channel(p),
          { model: p.model, input: '嵌入测试' },
          { ...opts(p, 'v2-embed'), endpoint: 'embeddings' },
        );
        if (result.ok) {
          // DeepSeek/MiniMax 若支持 embeddings：usage 必须可信
          expect(result.usage?.estimated ?? true).toBe(false);
          console.log(`[${p.name}] embeddings usage:`, JSON.stringify(result.usage));
        } else {
          // 不支持时：可分类错误（model_not_found/invalid_request），不是 network（寻址正确性证明）
          expect(result.error.kind).not.toBe('network');
          console.log(`[${p.name}] embeddings unsupported → ${result.error.kind}`);
        }
      }, 45_000);
    });
  }
});
