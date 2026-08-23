/**
 * 出站改写与脱敏（§3.6 透传例外 2/3）：
 *   - responseModelRewrite 开启：同协议透传帧仅 model 字段变（其余字节逐字节对照）、
 *     跨协议转换帧（claude codec 从 message_start 提取真实模型名的路径）同样替换；
 *   - 关闭：整流逐字节相等（wire 保真基线）；
 *   - sanitizeUpstreamDetail 三类脱敏（截断/剥寻址/内部名→对外名）；
 *   - 错误出站两条路径（非流式返回值 message / 流式 failEarly 帧）脱敏、事件面与 rawBody 保真。
 */
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createAi, allowAllUrls } from '../src/index.js';
import { sanitizeUpstreamDetail } from '../src/errors/sanitize.js';

const enc = new TextEncoder();

const startServer = (
  handler: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => void,
) =>
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

const ch = (baseUrl: string, protocol = 'openai-compatible') => ({
  baseUrl,
  apiKey: 'sk-t',
  protocol,
});

/** 逐块写上游帧（可在任意字节边界劈开——验证行重组） */
const writeChunked = (
  res: import('node:http').ServerResponse,
  text: string,
  splitAt: number,
): void => {
  res.write(text.slice(0, splitAt));
  res.write(text.slice(splitAt));
  res.end();
};

describe('responseModelRewrite：响应侧 model 字段替换（例外 2）', () => {
  const frames = [
    'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"real-deployed-name","choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}]}\n\n',
    'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"real-deployed-name","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  const rewritten = frames.replaceAll('"model":"real-deployed-name"', '"model":"catalog-model"');

  it('开启：同协议帧仅 model 字段变（其余字节逐字节对照）', async () => {
    const s = await startServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      writeChunked(res, frames, 97); // 劈在首帧 model 值内部——行重组后再替换
    });
    try {
      const ai = mk({ responseModelRewrite: true });
      const { stream } = await ai.chatStream(ch(s.baseUrl), {
        model: 'catalog-model',
        messages: [],
        stream: true,
      });
      const text = await new Response(stream).text();
      expect(text).toBe(rewritten); // 逐字节对照：除 model 值外不可有任何字节漂移
    } finally {
      await s.close();
    }
  });

  it('关闭（默认）：整流逐字节相等', async () => {
    const s = await startServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      writeChunked(res, frames, 40);
    });
    try {
      const ai = mk();
      const { stream } = await ai.chatStream(ch(s.baseUrl), {
        model: 'catalog-model',
        messages: [],
        stream: true,
      });
      const text = await new Response(stream).text();
      expect(text).toBe(frames); // wire 保真基线：逐字节透传
    } finally {
      await s.close();
    }
  });

  it('开启：跨协议转换出站帧也替换（claude codec 从 message_start 提取真实模型名的路径）', async () => {
    const claudeFrames = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"claude-real-3-7","usage":{"input_tokens":2,"output_tokens":0}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('');
    const s = await startServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(claudeFrames);
    });
    try {
      const ai = mk({ responseModelRewrite: true });
      const { stream } = await ai.chatStream(ch(s.baseUrl, 'anthropic'), {
        model: 'catalog-claude',
        messages: [],
        stream: true,
      });
      const text = await new Response(stream).text();
      expect(text).toContain('"model":"catalog-claude"');
      expect(text).not.toContain('claude-real-3-7'); // 真实部署名不得出站
      expect(text).toContain('"content":"hi"');
      expect(text).toContain('[DONE]');
    } finally {
      await s.close();
    }
  });

  it('开启：无 model 字段的帧与注释行逐字节透出（改写只触碰 model 值）', async () => {
    // 注释行 + 无 model 字段的普通帧:model-rewrite 不得动任何字节(错误帧另走
    // 例外 3 的 failEarly 信封路径,由 stream-report 用例覆盖,不在此重复)
    const raw =
      ': keep-alive comment\n\ndata: {"id":"2","object":"chat.completion.chunk","created":9,"choices":[{"index":0,"delta":{"content":"b"},"finish_reason":null}]}\n\ndata: [DONE]\n\n';
    const s = await startServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(raw);
    });
    try {
      const ai = mk({ responseModelRewrite: true });
      const { stream } = await ai.chatStream(ch(s.baseUrl), {
        model: 'catalog-model',
        messages: [],
        stream: true,
      });
      const text = await new Response(stream).text();
      expect(text).toBe(raw); // 逐字节对照
    } finally {
      await s.close();
    }
  });
});

describe('sanitizeUpstreamDetail：三类脱敏（例外 3 内容层）', () => {
  it('截断：超 maxLen 截到上限，短文原样', () => {
    expect(sanitizeUpstreamDetail('x'.repeat(600)).length).toBe(512);
    expect(sanitizeUpstreamDetail('short message')).toBe('short message');
    expect(sanitizeUpstreamDetail('x'.repeat(600), { maxLen: 10 }).length).toBe(10);
  });

  it('剥内部寻址：URL / IP(:端口) / 主机:端口 / IPv6 → [redacted]', () => {
    expect(
      sanitizeUpstreamDetail('connect to https://internal-node-7.prod:8443/v1/chat failed'),
    ).not.toContain('internal-node-7');
    expect(
      sanitizeUpstreamDetail('connect to https://internal-node-7.prod:8443/v1/chat failed'),
    ).toContain('[redacted]');
    expect(sanitizeUpstreamDetail('upstream 10.0.0.5:8080 refused')).not.toContain('10.0.0.5');
    expect(sanitizeUpstreamDetail('node 192.168.1.4 unreachable')).toBe(
      'node [redacted] unreachable',
    );
    expect(sanitizeUpstreamDetail('dial ingress-gw.prod:9090 timeout')).toBe(
      'dial [redacted] timeout',
    );
    expect(sanitizeUpstreamDetail('resolve 2001:db8:1:2:3:4:5:6 failed')).not.toContain('2001:db8');
    expect(sanitizeUpstreamDetail('loopback ::1 refused')).toBe('loopback [redacted] refused');
    // 非寻址文本不误伤
    expect(sanitizeUpstreamDetail('prompt is too long for this model')).toBe(
      'prompt is too long for this model',
    );
  });

  it('内部名 → 对外名（redactions + replacement）', () => {
    const out = sanitizeUpstreamDetail('model gpt-4o-real-deploy not found on this channel', {
      redactions: ['gpt-4o-real-deploy'],
      replacement: 'catalog-gpt-4o',
    });
    expect(out).toBe('model catalog-gpt-4o not found on this channel');
    expect(sanitizeUpstreamDetail('secret-name', { redactions: ['secret-name'] })).toBe(
      '[redacted]',
    );
  });

  it('空串原样；空 redaction 项忽略', () => {
    expect(sanitizeUpstreamDetail('')).toBe('');
    expect(sanitizeUpstreamDetail('abc', { redactions: ['', 'b'] })).toBe('a[redacted]c');
  });
});

describe('错误出站脱敏接线（事件面/rawBody 保真，仅出站字节脱敏）', () => {
  it('非流式：返回值 message 脱敏；failed 事件与 rawBody 保留原文', async () => {
    const rawMessage =
      'upstream exploded at https://internal-node-7.prod:8443/v1 (model gpt-real-deploy)';
    const s = await startServer((_q, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'internal', message: rawMessage } }));
    });
    try {
      const ai = mk({ errorSanitize: { maxLen: 512, redactions: ['gpt-real-deploy'] } });
      const seen: { type: string; message?: string }[] = [];
      ai.subscribe((e) => {
        if (e.type === 'failed') seen.push({ type: e.type, message: e.error.message });
      });
      const r = await ai.chat(ch(s.baseUrl), { model: 'catalog-model', messages: [] });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.message).not.toContain('internal-node-7');
        expect(r.error.message).not.toContain('gpt-real-deploy');
        expect(r.error.message).toContain('[redacted]');
        expect(r.error.message).toContain('catalog-model'); // 内部名 → 对外名
        expect(r.error.rawBody).toContain(rawMessage); // 原文保真（日志/审计路径）
      }
      expect(seen[0]?.message).toContain(rawMessage); // 事件面不脱敏（观察面保真）
    } finally {
      await s.close();
    }
  });

  it('流式 failEarly：C 端错误帧 message 脱敏；failed 终态事件保留原文', async () => {
    const rawMessage = 'quota check failed at http://10.1.2.3:9000/quota';
    const s = await startServer((_q, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'rate_limited', message: rawMessage } }));
    });
    try {
      const ai = mk();
      const { stream, events } = await ai.chatStream(ch(s.baseUrl), {
        model: 'm',
        messages: [],
        stream: true,
      });
      const text = await new Response(stream).text();
      expect(text).toContain('[redacted]');
      expect(text).not.toContain('10.1.2.3');
      const seen: { type: string; message?: string }[] = [];
      events.subscribe((e) => {
        if (e.type === 'failed') seen.push({ type: e.type, message: e.error.message });
      });
      expect(seen[0]?.message).toBe(rawMessage); // 事件面原文
    } finally {
      await s.close();
    }
  });

  it('流式 failEarly：超长错误体截断到 maxLen', async () => {
    const long = 'z'.repeat(2000);
    const s = await startServer((_q, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'x', message: long } }));
    });
    try {
      const ai = mk({ errorSanitize: { maxLen: 100, redactions: [] } });
      const { stream } = await ai.chatStream(ch(s.baseUrl), {
        model: 'm',
        messages: [],
        stream: true,
      });
      const text = await new Response(stream).text();
      const frame = JSON.parse(text.slice(6, text.indexOf('\n\n'))) as {
        error: { message: string };
      };
      expect(frame.error.message.length).toBe(100);
    } finally {
      await s.close();
    }
  });
});

// 供 splitAt 计算的编码器引用（避免未使用告警的形式工具）
void enc;
