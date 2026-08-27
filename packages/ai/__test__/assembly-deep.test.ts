/**
 * create-ai 装配壳深支（本地 server 模式，参照 outbound.test.ts）：
 * 注册/校验失败分支、参数抹平事件面、FormData 透传（multipart 不得被
 * finalizeRequestBody 展开毁掉）、签名钩子、响应翻译/二进制 rawBody、取消分类、
 * 流式首帧错误与首字节超时、tasks 三操作面（minimax + 本地 server）、probe 网络失败。
 * 每条都是此前 lcov 零覆盖的分支，断言锁出站可观察行为。
 */
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAi, allowAllUrls } from '../src/index.js';
import type { ChannelDesc } from '../src/types.js';
import { invalidResponseError } from '../src/errors/internal.js';
import { isUpstreamError, UpstreamError } from '../src/errors/kinds.js';
import { withRetry } from '../src/retry/with-retry.js';
import { registerSweep } from '../src/transport/heartbeat.js';
import { defineAdapter } from '../src/registry/define-adapter.js';
import { OpenAICompatibleAdapter } from '../src/adapters/openai-compatible.js';
import { defined } from './defined';

type Rec = Record<string, unknown>;

const startServer = (handler: (req: IncomingMessage, res: ServerResponse) => void) =>
  new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });

const mk = (extra?: Parameters<typeof createAi>[0]) =>
  createAi(
    {
      retry: {
        maxAttempts: 1,
        baseDelayMs: 5,
        maxDelayMs: 10,
        jitterRatio: 0,
        deadlineMs: 5000,
        emptyCompletionRetries: 0,
      },
      timeout: { connectMs: 2000, totalMs: 5000 },
      stream: { heartbeatIdleMs: 60_000, firstByteTimeoutMs: 2000, inactivityTimeoutMs: 5000 },
      ...extra,
    },
    { guardUrl: allowAllUrls },
  );

const ch = (baseUrl: string, protocol = 'openai-compatible', apiKey = 'sk-t'): ChannelDesc => ({
  baseUrl,
  apiKey,
  protocol,
});

/** 收集文本请求体后回 200 JSON 空 body（模块级：避免 it 内 handler→on 四级嵌套回调） */
function collectTextBody(onBody: (raw: string) => void) {
  return (req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      onBody(raw);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  };
}

/** 记录 content-type 头并收集二进制请求体后回 200 JSON 空 body */
function collectBinaryBody(onStart: (contentType: string) => void, onBody: (raw: Buffer) => void) {
  return (req: IncomingMessage, res: ServerResponse) => {
    onStart(req.headers['content-type'] ?? '');
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      onBody(Buffer.concat(chunks));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  };
}
describe('注册与配置校验分支', () => {
  it('重复协议注册 → 启动即抛（配置错误 fail fast）', () => {
    const a = new OpenAICompatibleAdapter();
    expect(() => createAi(undefined, {}, { adapters: [a, new OpenAICompatibleAdapter()] })).toThrow(
      /duplicate protocol adapter registration: openai-compatible/,
    );
  });
  it('未注册协议 → unsupported_protocol（chat 与 tasks.parse 双面）', async () => {
    const ai = mk();
    const r = await ai.chat(ch('https://x.test', 'nope'), { model: 'm', messages: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('unsupported_protocol');
    const p = ai.tasks.parse(ch('https://x.test', 'nope'), 'video', {});
    expect(p.kind).toBe('error');
  });
  it('protocol 空 → invalid_config（assertChannel 第三分支）', async () => {
    const r = await mk().chat(
      { baseUrl: 'https://x.test', apiKey: 'k', protocol: '' },
      { model: 'm', messages: [] },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_config');
  });
});

describe('参数抹平事件面（vendor profile 接线）', () => {
  it('channel.vendor=deepseek：store 被 ignore → param_adjustment 事件 + 出站 body 无 store', async () => {
    let seenBody: Rec = {};
    const s = await startServer(
      collectTextBody((raw) => {
        seenBody = JSON.parse(raw) as Rec;
      }),
    );
    try {
      const ai = mk();
      const seen: string[] = [];
      ai.subscribe((e) => {
        if (e.type === 'param_adjustment') seen.push(`${e.param}:${e.action}`);
      });
      const r = await ai.chat({ ...ch(s.baseUrl), vendor: 'deepseek' } as never, {
        model: 'm',
        messages: [],
        store: true,
      });
      expect(r.ok).toBe(true);
      expect(seen).toEqual(['store:ignore']);
      expect(seenBody.store).toBeUndefined();
    } finally {
      await s.close();
    }
  });
});

describe('B-F1 回归：FormData 请求体透传（multipart 不被展开毁掉）', () => {
  it('audio_transcription 形态：字段与文件字节完整到达上游，model 重写为真实名', async () => {
    let contentType = '';
    let raw: Buffer = Buffer.alloc(0);
    const s = await startServer(
      collectBinaryBody(
        (ct) => {
          contentType = ct;
        },
        (b) => {
          raw = b;
        },
      ),
    );
    try {
      const ai = mk();
      const form = new FormData();
      form.set('model', 'external-name');
      form.set('language', 'zh');
      form.append('file', new Blob([new Uint8Array([1, 2, 3, 4])]), 'a.wav');
      const r = await ai.chat(ch(s.baseUrl), form, {
        model: 'real-deployed',
        endpoint: 'audio_transcription',
      });
      expect(r.ok).toBe(true);
      expect(contentType).toMatch(/^multipart\/form-data/); // 关键：不能退化成 application/json
      const body = raw.toString('latin1');
      expect(body).toContain('name="model"');
      expect(body).toContain('real-deployed'); // 对外名 → 真实名重写
      expect(body).toContain('name="language"');
      expect(body).toContain('name="file"');
      expect(body).toContain('a.wav');
    } finally {
      await s.close();
    }
  });
});

describe('签名钩子 / 响应翻译 / rawBody / 取消分类', () => {
  it('adapter.signRequest：最终请求头带签名结果（异步签名时序）', async () => {
    let auth = '';
    const s = await startServer((req, res) => {
      auth = String(req.headers['x-sign'] ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    try {
      const signedAdapter = defineAdapter({
        protocol: 'signed-x',
        addressing: { signRequest: async () => ({ 'x-sign': 'sig-1' }) },
      });
      const ai = createAi(undefined, { guardUrl: allowAllUrls }, { adapters: [signedAdapter] });
      const r = await ai.chat(ch(s.baseUrl, 'signed-x'), { model: 'm', messages: [] });
      expect(r.ok).toBe(true);
      expect(auth).toBe('sig-1');
    } finally {
      await s.close();
    }
  });
  it('anthropic 非流式：translateResponseBody 接线（claude 形 → 规范形 + usage 归一）', async () => {
    const s = await startServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_1',
          model: 'claude-x',
          content: [{ type: 'text', text: 'salut' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 1 },
        }),
      );
    });
    try {
      const r = await mk().chat(ch(s.baseUrl, 'anthropic'), { model: 'm', messages: [] });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const body = r.body as Rec;
        expect((defined((body.choices as Rec[])[0], 'choices[0]').message as Rec).content).toBe(
          'salut',
        );
        expect(r.usage).toMatchObject({ inputTokens: 5, cachedInputTokens: 1, outputTokens: 2 }); // inputTokens 含缓存读（口径）
      }
    } finally {
      await s.close();
    }
  });
  it('非 JSON content-type → readRawBody 二进制返回', async () => {
    const s = await startServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(Buffer.from([1, 2, 3, 254]));
    });
    try {
      const r = await mk().chat(ch(s.baseUrl), { model: 'm', messages: [] });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(Array.from(r.rawBody ?? [])).toEqual([1, 2, 3, 254]);
        expect(r.rawContentType).toBe('audio/mpeg');
        expect(r.body).toBeUndefined();
      }
    } finally {
      await s.close();
    }
  });
  it('外部 signal 中止 → kind=canceled（fetch aborted 分类链）', async () => {
    const s = await startServer(() => {
      /* 挂住不响应 */
    });
    try {
      const ctrl = new AbortController();
      const ai = mk();
      const p = ai.chat(ch(s.baseUrl), { model: 'm', messages: [] }, { signal: ctrl.signal });
      setTimeout(() => ctrl.abort(), 80);
      const r = await p;
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('canceled');
    } finally {
      await s.close();
    }
  }, 10_000);
});

describe('chatStream 深支：首帧错误 / 首字节超时 / 早退脱敏', () => {
  it('200 + 流内错误帧 → 首帧识别重试取消（rest cancel）→ failed 终态', async () => {
    const s = await startServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"error":{"code":"insufficient_quota","message":"no quota left"}}\n\n');
    });
    try {
      const { stream, events } = await mk().chatStream(ch(s.baseUrl), {
        model: 'm',
        messages: [],
        stream: true,
      });
      const text = await new Response(stream).text();
      expect(text).toContain('insufficient_quota');
      const seen: string[] = [];
      events.subscribe((e) => seen.push(e.type));
      expect(seen.at(-1)).toBe('failed');
    } finally {
      await s.close();
    }
  });
  it('首字节超时 → kind=timeout（headers 后 body 挂起）', async () => {
    const s = await startServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders(); /* headers 已发、body 挂起 */
    });
    try {
      const ai = createAi(
        {
          retry: {
            maxAttempts: 1,
            baseDelayMs: 5,
            maxDelayMs: 10,
            jitterRatio: 0,
            deadlineMs: 5000,
            emptyCompletionRetries: 0,
          },
          timeout: { connectMs: 2000, totalMs: 5000 },
          stream: { heartbeatIdleMs: 60_000, firstByteTimeoutMs: 120, inactivityTimeoutMs: 5000 },
        },
        { guardUrl: allowAllUrls },
      );
      const { stream, events } = await ai.chatStream(ch(s.baseUrl), {
        model: 'm',
        messages: [],
        stream: true,
      });
      const text = await new Response(stream).text();
      expect(text).toContain('timeout');
      const seen: Rec[] = [];
      events.subscribe((e) => seen.push(e as Rec));
      const failed = seen.find((e) => e.type === 'failed') as
        | { error?: { kind?: string; message?: string } }
        | undefined;
      expect(failed?.error?.kind).toBe('timeout');
      expect(failed?.error?.message).toContain('no first byte from upstream within 120ms');
    } finally {
      await s.close();
    }
  }, 10_000);
  it('早退（invalid_config）→ failEarly 帧含 kind；出站 message 经脱敏闭包', async () => {
    const ai = mk({ errorSanitize: { maxLen: 10, redactions: [] } });
    const { stream } = await ai.chatStream(
      { baseUrl: 'https://x.test', apiKey: '', protocol: 'openai-compatible' },
      { model: 'm', messages: [] },
    );
    const text = await new Response(stream).text();
    expect(text).toContain('invalid_config');
    expect(text).toContain('[DONE]');
    const frame = JSON.parse(text.slice(6, text.indexOf('\n\n'))) as { error: { message: string } };
    expect(frame.error.message.length).toBeLessThanOrEqual(10); // 脱敏截断生效
  });
});

describe('tasks 三操作面（minimax + 本地 server）', () => {
  const queryBody = { status: 'Success', file_id: 'f1', video_width: 1080, video_height: 1920 };
  const serve = (status: number, body: unknown) =>
    startServer((_q, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });

  it('query：成功 → succeeded + 产物尺寸；404 → ok=false（mapError 兜底）；信封错误优先', async () => {
    const ok = await serve(200, queryBody);
    try {
      const r = await mk().tasks.query({ ...ch(ok.baseUrl), protocol: 'minimax' }, 't1');
      expect(r).toMatchObject({
        ok: true,
        status: 'succeeded',
        fileId: 'f1',
        artifact: { width: 1080, height: 1920 },
      });
    } finally {
      await ok.close();
    }
    const nf = await serve(404, { base_resp: { status_code: 1004 } });
    try {
      const r = await mk().tasks.query({ ...ch(nf.baseUrl), protocol: 'minimax' }, 't1');
      expect(r.ok).toBe(false);
    } finally {
      await nf.close();
    }
    const env = await serve(200, { base_resp: { status_code: 1008 } });
    try {
      const r = await mk().tasks.query({ ...ch(env.baseUrl), protocol: 'minimax' }, 't1');
      expect(r).toMatchObject({ ok: false });
      if (!r.ok) expect(r.error.kind).toBe('quota_exhausted');
    } finally {
      await env.close();
    }
  });
  it('file：downloadUrl 提取；垃圾体 → invalid_response', async () => {
    const ok = await serve(200, { file: { download_url: 'https://d/x.mp4' } });
    try {
      const r = await mk().tasks.file({ ...ch(ok.baseUrl), protocol: 'minimax' }, 'f1');
      expect(r).toMatchObject({ ok: true, downloadUrl: 'https://d/x.mp4' });
    } finally {
      await ok.close();
    }
    const bad = await serve(200, {});
    try {
      const r = await mk().tasks.file({ ...ch(bad.baseUrl), protocol: 'minimax' }, 'f1');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('invalid_response');
    } finally {
      await bad.close();
    }
  });
  it('网络异常（连接拒绝）→ network kind 不抛', async () => {
    const holder = await startServer(() => {});
    const port = (holder as unknown as { baseUrl: string }).baseUrl;
    await holder.close();
    const r = await mk().tasks.query({ ...ch(port), protocol: 'minimax' }, 't1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('network');
  });
});

describe('probe：全部探测失败 → network 兜底', () => {
  it('连接拒绝（无 listener）→ ok=false network', async () => {
    const holder = await startServer(() => {});
    const url = (holder as unknown as { baseUrl: string }).baseUrl;
    await holder.close();
    const r = await mk().probe(ch(url));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error?.kind).toBe('network');
  });
});

describe('subscribe 退订与共享小件', () => {
  it('退订后不再收事件；重复退订安全', async () => {
    const s = await startServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'x' } }] }));
    });
    try {
      const ai = mk();
      const seen: string[] = [];
      const off = ai.subscribe((e) => seen.push(e.type));
      await ai.chat(ch(s.baseUrl), { model: 'm', messages: [] });
      off();
      off(); // 二次退订（indexOf -1 分支）
      const before = seen.length;
      await ai.chat(ch(s.baseUrl), { model: 'm', messages: [] });
      expect(seen.length).toBe(before); // 已退订不再收
    } finally {
      await s.close();
    }
  });
  it('errors/internal + kinds 谓词 + heartbeat 异常检查器自动注销', async () => {
    expect(invalidResponseError().kind).toBe('invalid_response');
    expect(invalidResponseError('custom').message).toBe('custom');
    expect(isUpstreamError(new UpstreamError({ kind: 'network' }))).toBe(true);
    expect(isUpstreamError(new Error('x'))).toBe(false);
    let calls = 0;
    const off = registerSweep(() => {
      calls += 1;
      throw new Error('checker boom');
    });
    await new Promise((r) => {
      setTimeout(r, 320);
    });
    off();
    expect(calls).toBe(1); // 抛错按不存活处理 → 立即注销，不再重入
  });
  it('withRetry：退避睡眠中被外部 signal 中止 → 停止重试（sleep abort 分支）', async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20); // 首次失败后进入 60ms 退避睡眠时中止
    let attempts = 0;
    const { attempts: n } = await withRetry(
      async () => {
        attempts += 1;
        return { ok: false as const, error: new UpstreamError({ kind: 'rate_limited' }) };
      },
      {
        maxAttempts: 5,
        baseDelayMs: 60,
        maxDelayMs: 60,
        jitterRatio: 0,
        deadlineMs: 5000,
        emptyCompletionRetries: 0,
        signal: ctrl.signal,
      },
    );
    expect(n).toBe(1);
    expect(attempts).toBe(1);
  }, 3000);
});
