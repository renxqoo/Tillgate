/**
 * 阶段 span 契约（TracePort 面）：
 * 一次请求的 span 名称序列、嵌套关系与关键属性的行为规格。
 * 捕获桩记录进入时刻的父 span（栈快照），等价 OTel active-span 语义。
 */
import { describe, expect, it } from 'vitest';
import {
  baseAuth,
  buildInference,
  channel,
  fakeAi,
  fakeBilling,
  fakeCatalog,
  fakeUpstream,
  mapping,
  streamResultOf,
  upstreamError,
  usage,
} from './harness';
import type { TraceAttributes, TracePort } from '../src/ports/trace';
import { defined } from './defined';

interface RecordedSpan {
  name: string;
  attributes: TraceAttributes;
  /** 进入时刻的父 span 名（null = 顶层，真实部署即请求根 span 之下） */
  parent: string | null;
  set: TraceAttributes;
  status: { code: 'ok' | 'error'; message?: string } | undefined;
}

function fakeTrace() {
  const stack: string[] = [];
  const spans: RecordedSpan[] = [];
  const port: TracePort = {
    withSpan: async (name, attributes, fn) => {
      const rec: RecordedSpan = {
        name,
        attributes: { ...attributes },
        parent: stack.at(-1) ?? null,
        set: {},
        status: undefined,
      };
      spans.push(rec);
      stack.push(name);
      try {
        return await fn({
          setAttributes: (a) => Object.assign(rec.set, a),
          setStatus: (s) => {
            rec.status = s;
          },
        });
      } finally {
        stack.pop();
      }
    },
  };
  return {
    port,
    spans,
    names: () => spans.map((s) => s.name),
    byName: (name: string) => spans.filter((s) => s.name === name),
  };
}

function setup() {
  const ai = fakeAi();
  const upstream = fakeUpstream();
  const billing = fakeBilling();
  const trace = fakeTrace();
  const catalog = fakeCatalog(
    {
      'gpt-x': mapping({ fallbackModels: ['gpt-y'] }),
      'gpt-y': mapping({ mappingId: 12, externalModel: 'gpt-y', realModel: 'gpt-y-real' }),
    },
    {
      'gpt-x-real': [channel({ channelId: 1, channelName: 'ch-a' })],
      'gpt-y-real': [channel({ channelId: 2, channelName: 'ch-b' })],
    },
  );
  const inference = buildInference({
    ai: ai.ai,
    catalog,
    billing: billing.port,
    upstream: upstream.port,
    trace: trace.port,
  });
  return { inference, upstream, billing, trace };
}

const body = { model: 'gpt-x', messages: [{ role: 'user', content: '你好' }] };

describe('阶段 span（TracePort）：非流式 chat 全路径', () => {
  it('成功路径：prepare → authorize → routing.resolve → reserve_channel → upstream.attempt → settle_signal（顶层成序列）', async () => {
    const s = setup();
    s.upstream.onChat(async () => ({
      ok: true,
      usage: usage({ inputTokens: 100, outputTokens: 40 }),
      durationMs: 5,
      body: { id: 'cmpl', choices: [] },
    }));
    const delivered = await s.inference.chat({ requestId: 'req-1', auth: baseAuth, body });
    expect(delivered).toMatchObject({ ok: true, status: 200 });

    expect(s.trace.names()).toEqual([
      'inference.prepare',
      'billing.authorize',
      'routing.resolve',
      'billing.reserve_channel',
      'upstream.attempt',
      'billing.settle_signal',
    ]);
    // 顶层平铺（父 = 请求根 span——装配侧由 otel 中间件提供活动上下文）
    for (const span of s.trace.spans) expect(span.parent).toBeNull();

    const prepare = defined(s.trace.byName('inference.prepare')[0], 'inference.prepare');
    expect(prepare.attributes).toMatchObject({ 'request.id': 'req-1', 'ai.model': 'gpt-x' });
    expect(prepare.set).toMatchObject({ 'quote.candidates': 2 });
    expect(
      defined(s.trace.byName('billing.authorize')[0], 'billing.authorize').attributes,
    ).toMatchObject({
      'billing.stream': false,
    });
    expect(defined(s.trace.byName('routing.resolve')[0], 'routing.resolve').set).toMatchObject({
      'routing.channels': 1,
    });
    expect(
      defined(s.trace.byName('billing.reserve_channel')[0], 'billing.reserve_channel').attributes,
    ).toMatchObject({
      'channel.key': 'ch-a',
    });
    const attempt = defined(s.trace.byName('upstream.attempt')[0], 'upstream.attempt');
    expect(attempt.attributes).toMatchObject({
      'upstream.stream': false,
      'channel.attempt': 1,
      'ai.model': 'gpt-x-real',
    });
    expect(attempt.set).toMatchObject({ 'upstream.ok': true, 'tokens.input': 100 });
    expect(attempt.status).toBeUndefined();
    expect(
      defined(s.trace.byName('billing.settle_signal')[0], 'billing.settle_signal').attributes,
    ).toMatchObject({
      'request.id': 'req-1',
    });
  });

  it('换渠路径：预算尽 channel.skip（skip.reason）→ 耗尽 release_and_fail（error 状态）', async () => {
    const s = setup();
    s.billing.onReserve(async () => false); // 全渠道预算耗尽
    await expect(
      s.inference.chat({ requestId: 'req-2', auth: baseAuth, body }),
    ).rejects.toMatchObject({ code: 'inference.no_available_channel' });

    const skips = s.trace.byName('channel.skip');
    expect(skips).toHaveLength(2); // 两候选各 1 渠道
    expect(defined(skips[0], 'skips[0]').attributes).toMatchObject({
      'channel.key': 'ch-a',
      'skip.reason': 'budget_exhausted',
      'channel.attempt': 1,
    });
    const release = defined(
      s.trace.byName('billing.release_and_fail')[0],
      'billing.release_and_fail',
    );
    expect(release.attributes).toMatchObject({
      'request.id': 'req-2',
      'error.code': 'channel_budget_exhausted',
    });
    expect(release.status).toMatchObject({ code: 'error' });
  });

  it('上游 4xx：upstream.attempt（error 状态）→ passthrough_4xx（原码属性）', async () => {
    const s = setup();
    s.upstream.onChat(async () => ({
      ok: false,
      error: upstreamError('invalid_request', { status: 400, message: 'bad' }),
      durationMs: 1,
    }));
    const delivered = await s.inference.chat({ requestId: 'req-3', auth: baseAuth, body });
    expect(delivered).toMatchObject({ ok: true, passthrough: true, status: 400 });

    const attempt = defined(s.trace.byName('upstream.attempt')[0], 'upstream.attempt');
    expect(attempt.set).toMatchObject({ 'upstream.ok': false, 'http.status_code': 400 });
    expect(attempt.status).toMatchObject({ code: 'error', message: 'invalid_request' });
    const passthrough = defined(
      s.trace.byName('billing.passthrough_4xx')[0],
      'billing.passthrough_4xx',
    );
    expect(passthrough.attributes).toMatchObject({
      'request.id': 'req-3',
      'error.code': 'invalid_request',
      'http.status_code': 400,
    });
    expect(passthrough.status).toMatchObject({ code: 'error' });
  });
});

describe('阶段 span（TracePort）：流式 stream 路径', () => {
  it('成功路径：settle_signal 嵌套在 upstream.attempt 之下（后台结算继承决定性事件上下文）', async () => {
    const s = setup();
    const sr = streamResultOf();
    s.upstream.onStream(async () => sr.result);
    // 订阅前发出（harness 缓冲重放语义）：first_chunk 上线 + success 终态后台结算
    sr.emit({ type: 'first_chunk', atMs: Date.now() });
    sr.emit({ type: 'success', usage: usage(), durationMs: 10 });
    const delivered = await s.inference.stream({ requestId: 'req-4', auth: baseAuth, body });
    expect(delivered).toMatchObject({ ok: true, status: 200 });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    expect(s.trace.names()).toEqual([
      'inference.prepare',
      'billing.authorize',
      'routing.resolve',
      'billing.reserve_channel',
      'upstream.attempt',
      'billing.settle_signal',
    ]);
    const attempt = defined(s.trace.byName('upstream.attempt')[0], 'upstream.attempt');
    expect(attempt.attributes).toMatchObject({ 'upstream.stream': true });
    expect(attempt.set).toMatchObject({ 'upstream.ok': true });
    expect(
      defined(s.trace.byName('billing.settle_signal')[0], 'billing.settle_signal').parent,
    ).toBe('upstream.attempt');
  });

  it('结算重试耗尽：settle_signal 标 error（attempts 属性）后如实返回', async () => {
    const s = setup();
    const calls: number[] = [];
    s.billing.signals.length = 0;
    // signal(request_succeeded) 恒失败——结算重试器耗尽（短退避）
    const { port } = s.billing;
    port.signal = async (input) => {
      if (input.type === 'request_succeeded') {
        calls.push(1);
        throw new Error('db down');
      }
    };
    s.upstream.onChat(async () => ({
      ok: true,
      usage: usage(),
      durationMs: 1,
      body: {},
    }));
    const inference = buildInference({
      ai: fakeAi().ai,
      catalog: fakeCatalog({ 'gpt-x': mapping() }, { 'gpt-x-real': [channel()] }),
      billing: port,
      upstream: s.upstream.port,
      trace: s.trace.port,
      defaults: {
        settleSignal: { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
      },
    });
    await expect(
      inference.chat({ requestId: 'req-5', auth: baseAuth, body }),
    ).rejects.toMatchObject({ code: 'inference.finalize_unavailable' });
    expect(calls).toHaveLength(2);
    const settle = defined(s.trace.byName('billing.settle_signal')[0], 'billing.settle_signal');
    expect(settle.status).toMatchObject({ code: 'error', message: 'signal retries exhausted' });
    expect(settle.set).toMatchObject({ 'settle.attempts': 2 });
  });
});
