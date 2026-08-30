/**
 * E2E 协议面 parity 专项（/v1/responses 工具链 + 多模态音频跨协议）。
 *
 * 覆盖 2026-08-30 修复的三类静默降级在真实网关装配下的端到端行为：
 * ① /v1/responses：tools/tool_choice/reasoning/text.format 入站映射进上游请求体
 *    （openai-compatible 上游收到 chat 形）；tool_calls 在非流式（function_call
 *    output item）与流式（added/arguments.delta/done 事件）两面还原；
 * ② 状态性参数显式 400：previous_response_id / background:true（不再静默丢弃）；
 * ③ input_audio 多模态：openai 透传保留；经 anthropic/gemini 协议出站时无损
 *    转换（claude audio 块 / gemini inlineData）——本地脚本化原生协议捕获 mock
 *    留证请求体。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  defined,
  E2EKeys,
  E2E_MODEL,
  E2E_UPSTREAM_KEY,
  e2ePost,
  resetChannelHealth,
  retargetUpstream,
  setupE2EWorld,
  sleep,
  startE2EGateway,
  type E2EGateway,
  type E2EWorld,
} from './kit';

const hasEnv = process.env.DB_TEST_URL != null || process.env.DATABASE_URL != null;

const AUDIO_B64 = 'aGVsbG8=';
const audioPart = { type: 'input_audio', input_audio: { data: AUDIO_B64, format: 'wav' } };

const weatherTool = {
  type: 'function',
  name: 'get_weather',
  description: 'query weather',
  parameters: { type: 'object', properties: { city: { type: 'string' } } },
};

/** 捕获型原生协议 mock：记录最近请求体并回 canned 应答（anthropic/gemini 各一形） */
function startCaptureMock(respond: (res: ServerResponse) => void): Promise<{
  baseUrl: string;
  bodies: Array<{ path: string; body: Record<string, unknown> }>;
  close(): Promise<void>;
}> {
  const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      bodies.push({
        path: req.url ?? '',
        body: (JSON.parse(raw || '{}') as Record<string, unknown>) ?? {},
      });
      respond(res);
    });
  });
  const listening = new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return listening.then(() => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      bodies,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    };
  });
}

const anthropicRespond = (res: ServerResponse): void => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      id: 'msg_mock',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 2 },
    }),
  );
};

const geminiRespond = (res: ServerResponse): void => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'ok' }], role: 'model' }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
    }),
  );
};

describe.skipIf(!hasEnv)('E2E 协议面 parity（responses 工具链 + 音频跨协议）', () => {
  let world: E2EWorld;
  let gateway: E2EGateway;
  let keys: E2EKeys;
  let raw = '';
  let userId = 0;
  let anthropicMock: Awaited<ReturnType<typeof startCaptureMock>>;
  let geminiMock: Awaited<ReturnType<typeof startCaptureMock>>;

  beforeAll(async () => {
    world = await setupE2EWorld();
    gateway = await startE2EGateway(world);
    keys = new E2EKeys(world, gateway.assembly.billingFacade);
    const issued = await keys.issue('50');
    raw = issued.raw;
    userId = issued.userId;
    anthropicMock = await startCaptureMock(anthropicRespond);
    geminiMock = await startCaptureMock(geminiRespond);
  }, 120_000);

  afterAll(async () => {
    await anthropicMock?.close();
    await geminiMock?.close();
    if (gateway) await gateway.stop();
    if (world) await world.teardown();
  });

  /** 世界 provider 重指向 + 健康复位 + 恢复 openai mock 上游 */
  async function pointUpstream(target: { baseUrl: string; protocol: string }): Promise<void> {
    await retargetUpstream(world, {
      baseUrl: target.baseUrl,
      apiKeyPlain: E2E_UPSTREAM_KEY,
      protocol: target.protocol,
    });
    await resetChannelHealth(gateway);
  }

  it('① 非流式：responses tools 映射进上游 + tool_calls 还原为 function_call item', async () => {
    world.upstream.script = 'nonstream-toolcall';
    world.upstream.recorded.length = 0;
    const res = await fetch(`${gateway.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: E2E_MODEL,
        input: '北京天气如何',
        tools: [weatherTool],
        tool_choice: 'auto',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output?: Array<Record<string, unknown>> };
    const call = defined(
      body.output?.find((o) => o.type === 'function_call'),
      'function_call item',
    );
    expect(call).toMatchObject({
      name: 'get_weather',
      call_id: 'call_e2e_1',
      arguments: '{"city":"北京"}',
    });

    // 上游收到的是 chat 形 tools（function 包裹）与 tool_choice
    const sent = defined(world.upstream.recorded.at(-1), 'upstream record').body as {
      tools?: Array<{ type?: string; function?: { name?: string } }>;
      tool_choice?: string;
      messages?: unknown[];
    };
    expect(sent.tools?.[0]?.function?.name).toBe('get_weather');
    expect(sent.tool_choice).toBe('auto');
    expect(sent.messages).toBeDefined();
  });

  it('② 流式：tool_calls 分片 → function_call 事件 + completed.output 携带', async () => {
    world.upstream.script = 'stream-toolcall';
    const res = await fetch(`${gateway.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: E2E_MODEL,
        input: '北京天气如何',
        stream: true,
        tools: [weatherTool],
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"type":"function_call"');
    expect(text).toContain('response.function_call_arguments.delta');
    expect(text).toContain('response.completed');
    const events = [...text.matchAll(/^data: (\{.*\})$/gm)].map(
      (m) => JSON.parse(String(m[1])) as Record<string, unknown>,
    );
    const completed = defined(
      events.find((e) => e.type === 'response.completed'),
      'completed event',
    );
    const response = (completed.response ?? {}) as {
      output?: Array<{ type?: string; name?: string; arguments?: string }>;
    };
    expect(response.output?.find((o) => o.type === 'function_call')).toMatchObject({
      name: 'get_weather',
      arguments: '{"city":"北京"}',
    });
  });

  it('③ 状态性参数显式 400：previous_response_id 与 background:true', async () => {
    world.upstream.script = 'nonstream-usage';
    world.upstream.recorded.length = 0;
    const prev = await fetch(`${gateway.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: E2E_MODEL, input: '继续', previous_response_id: 'resp_x' }),
    });
    expect(prev.status).toBe(400);
    expect(await prev.text()).toContain('previous_response_id');

    const bg = await fetch(`${gateway.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: E2E_MODEL, input: '后台跑', background: true }),
    });
    expect(bg.status).toBe(400);
    expect(await bg.text()).toContain('background');
    // 零上游调用（拒绝发生在 schema 层）
    expect(world.upstream.recorded).toHaveLength(0);
  });

  it('④ reasoning.effort 与 text.format 映射进上游请求体', async () => {
    world.upstream.script = 'nonstream-usage';
    world.upstream.recorded.length = 0;
    const res = await fetch(`${gateway.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: E2E_MODEL,
        input: '结构化输出',
        reasoning: { effort: 'medium' },
        text: { format: { type: 'json_object' } },
      }),
    });
    expect(res.status).toBe(200);
    const sent = JSON.stringify(defined(world.upstream.recorded.at(-1), 'upstream record').body);
    expect(sent).toContain('"reasoning_effort":"medium"');
    expect(sent).toContain('"response_format"');
    expect(sent).toContain('json_object');
  });

  it('⑤ input_audio 经 openai 透传：音频载荷原样到达上游', async () => {
    world.upstream.script = 'nonstream-usage';
    world.upstream.recorded.length = 0;
    const res = await e2ePost(gateway.baseUrl, raw, {
      model: E2E_MODEL,
      messages: [{ role: 'user', content: [{ type: 'text', text: '听这段' }, audioPart] }],
    });
    expect(res.status).toBe(200);
    const sent = JSON.stringify(defined(world.upstream.recorded.at(-1), 'upstream record').body);
    expect(sent).toContain(AUDIO_B64);
    expect(sent).toContain('input_audio');
  });

  it('⑥ input_audio 经 anthropic 出站：claude audio 块（base64 + audio/wav）', async () => {
    await pointUpstream({ baseUrl: anthropicMock.baseUrl, protocol: 'anthropic' });
    const res = await e2ePost(gateway.baseUrl, raw, {
      model: E2E_MODEL,
      messages: [{ role: 'user', content: [{ type: 'text', text: '听这段' }, audioPart] }],
    });
    expect(res.status).toBe(200);
    const sent = defined(anthropicMock.bodies.at(-1), 'anthropic capture');
    expect(sent.path).toContain('/v1/messages');
    const blocks = (
      (sent.body as { messages?: Array<{ content?: Array<Record<string, unknown>> }> })
        .messages?.[0]?.content ?? []
    ).filter((b) => b.type === 'audio');
    expect(blocks[0]).toEqual({
      type: 'audio',
      source: { type: 'base64', media_type: 'audio/wav', data: AUDIO_B64 },
    });
  });

  it('⑦ input_audio 经 gemini 出站：inlineData（audio/wav）', async () => {
    await pointUpstream({ baseUrl: geminiMock.baseUrl, protocol: 'gemini' });
    const res = await e2ePost(gateway.baseUrl, raw, {
      model: E2E_MODEL,
      messages: [{ role: 'user', content: [{ type: 'text', text: '听这段' }, audioPart] }],
    });
    expect(res.status).toBe(200);
    const sent = defined(geminiMock.bodies.at(-1), 'gemini capture');
    expect(sent.path).toContain(':generateContent');
    const parts = (
      (sent.body as { contents?: Array<{ parts?: Array<Record<string, unknown>> }> }).contents?.[0]
        ?.parts ?? []
    ).filter((p) => p.inlineData !== undefined);
    expect(parts[0]?.inlineData).toEqual({ mimeType: 'audio/wav', data: AUDIO_B64 });
  });

  it('⑧ 恢复 openai 上游后照常服务（retarget 往返无残留）', async () => {
    await pointUpstream({ baseUrl: world.upstream.url, protocol: 'openai-compatible' });
    world.upstream.script = 'nonstream-usage';
    const res = await e2ePost(gateway.baseUrl, raw, {
      model: E2E_MODEL,
      messages: [{ role: 'user', content: '恢复' }],
    });
    expect(res.status).toBe(200);
    await sleep(100);
    void userId;
  });

  it('⑨ 宿主侧工具（web_search）显式 400、零上游调用（不静默丢语义）', async () => {
    world.upstream.script = 'nonstream-usage';
    world.upstream.recorded.length = 0;
    const res = await fetch(`${gateway.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: E2E_MODEL,
        input: '搜一下',
        tools: [{ type: 'web_search_preview' }],
      }),
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain('web_search_preview');
    expect(world.upstream.recorded).toHaveLength(0);
  });

  it('⑩ 流式 reasoning：reasoning_content 增量 → summary 事件 + 终态 output 携带', async () => {
    world.upstream.script = 'stream-reasoning';
    const res = await fetch(`${gateway.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: E2E_MODEL,
        input: '深度思考后回答',
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"type":"reasoning"');
    expect(text).toContain('response.reasoning_summary_text.delta');
    expect(text).toContain('response.output_text.delta');
    expect(text).toContain('response.completed');
    const events = [...text.matchAll(/^data: (\{.*\})$/gm)].map(
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
    expect(response.output?.[0]?.summary?.[0]?.text).toBe('先想清楚');
  });
});
